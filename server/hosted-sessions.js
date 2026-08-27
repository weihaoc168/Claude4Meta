"use strict";
// Sessions the relay itself runs via the Claude Agent SDK. These are fully
// voice-controllable: streaming input lets the phone inject follow-up
// instructions mid-run, and canUseTool routes permission asks to the glasses.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { cleanEnv } = require("./claude-bin");

// WebFetch/WebSearch are deliberately NOT auto-allowed: paired with Read they
// form an unattended exfiltration channel (read a secret, fetch attacker URL).
// Override via "autoAllow" in server/config.json if you accept that risk.
const DEFAULT_AUTO_ALLOW = [
  "Read", "Glob", "Grep", "TodoWrite",
  "Task", "TaskOutput", "NotebookRead", "ListMcpResources", "ToolSearch",
];
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const END = Symbol("end");

function describeToolCall(toolName, input) {
  try {
    if (toolName === "Bash" && input.command) return String(input.command).slice(0, 90);
    if (input.file_path) return path.basename(String(input.file_path));
    if (input.description) return String(input.description).slice(0, 90);
    const k = Object.keys(input)[0];
    return k ? `${k}: ${String(input[k]).slice(0, 70)}` : "";
  } catch { return ""; }
}

class HostedSession {
  constructor({ cwd, name, broadcast, autoAllow }) {
    this.autoAllow = autoAllow;
    this.id = "h-" + crypto.randomBytes(4).toString("hex");
    this.cwd = cwd;
    this.name = name || path.basename(cwd);
    this.broadcast = broadcast;
    this.status = "running";
    this.claudeSessionId = "";
    this.commands = [];      // voice-invocable slash commands, 1:1 with the session
    this.commandMeta = {};   // name -> description (when the SDK provides it)
    this.startedAt = Date.now();
    this.lastEventAt = Date.now();
    this.tools = [];
    this.lastText = "";
    this.lastResult = "";
    this.pending = null; // { toolName, desc, resolve, timer }
    this.msgQueue = [];
    this.notify = null;
    this.closed = false;
  }

  emit(evt) {
    this.broadcast({ sessionId: this.id, sessionName: this.name, ...evt });
  }

  pushMsg(m) {
    this.msgQueue.push(m);
    if (this.notify) { const n = this.notify; this.notify = null; n(); }
  }

  async *inputGen() {
    while (true) {
      while (this.msgQueue.length) {
        const m = this.msgQueue.shift();
        if (m === END) return;
        yield m;
      }
      await new Promise((r) => (this.notify = r));
    }
  }

  userMessage(text) {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId,
    };
  }

  async run(sdkQuery) {
    try {
      this.q = sdkQuery({
        prompt: this.inputGen(),
        options: {
          cwd: this.cwd,
          env: cleanEnv(),
          permissionMode: "default",
          canUseTool: (toolName, input) => this.handlePermission(toolName, input),
        },
      });
      for await (const msg of this.q) this.onMessage(msg);
      if (this.status !== "error") this.status = "done";
    } catch (e) {
      this.status = "error";
      this.lastResult = String(e.message || e);
      this.emit({ type: "error", status: "error", text: `${this.name} crashed: ${this.lastResult.slice(0, 140)}`, speak: true });
    }
    this.clearPending("The session ended before the operator answered.");
    this.closed = true;
    this.lastEventAt = Date.now();
    this.emit({ type: "sessions" });
  }

  onMessage(msg) {
    this.lastEventAt = Date.now();
    if (msg.type === "system" && msg.subtype === "init") {
      this.claudeSessionId = msg.session_id || "";
      // 1:1 command mapping: expose what THIS session supports, minus the
      // commands the SDK flags as bound to a local terminal UI
      const terminal = new Set(msg.terminal_slash_commands || []);
      this.commands = (msg.slash_commands || []).filter((c) => !terminal.has(c));
      this.emit({ type: "sessions" });
      return;
    }
    if (msg.type === "system" && msg.subtype === "commands_changed") {
      // fire-and-forget push after e.g. new skills are discovered: replace
      const list = Array.isArray(msg.commands) ? msg.commands : [];
      this.commands = list.map((c) => c.name);
      this.commandMeta = Object.fromEntries(list.map((c) => [c.name, c.description || ""]));
      this.emit({ type: "sessions" });
      return;
    }
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) this.lastText = block.text;
        if (block.type === "tool_use" && block.name) {
          this.tools.push(block.name);
          if (this.tools.length > 15) this.tools.shift();
        }
      }
      return;
    }
    if (msg.type === "result") {
      const failed = !!msg.is_error;
      this.status = failed ? "error" : "idle";
      this.lastResult = typeof msg.result === "string" ? msg.result : this.lastText;
      const gist = (this.lastResult || "").replace(/[*_`#>\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      this.emit({
        type: failed ? "error" : "done",
        status: this.status,
        text: failed
          ? `${this.name} stopped with an error. Say status for details.`
          : `${this.name} finished this turn. ${gist}`,
        speak: true,
      });
      // pre-generate the brief now so a temple tap gets an instant answer
      if (this.onSettled) setTimeout(this.onSettled, 100);
    }
  }

  // Resolve an orphaned ask (interrupt, close, SDK death) as a deny so the
  // SDK unblocks, the timer cannot later flip status, and new asks work again.
  clearPending(message) {
    if (!this.pending) return;
    const { resolve, timer, toolName } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve({
      behavior: "deny",
      message: message || `The operator interrupted before answering the ${toolName} request. Do not retry it unprompted.`,
    });
  }

  async shutdown() {
    this.clearPending("The operator closed the session.");
    try {
      if (this.q && this.q.interrupt && !this.closed) await this.q.interrupt();
    } catch { /* already gone */ }
    this.pushMsg(END);
  }

  handlePermission(toolName, input) {
    if (this.autoAllow.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // one ask at a time: deny overlapping asks so the session works around them
    if (this.pending) {
      return Promise.resolve({
        behavior: "deny",
        message: "Another permission request is already waiting on the operator. Retry this step after that one is resolved, or find another way.",
      });
    }
    const desc = describeToolCall(toolName, input);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.status = "running";
        resolve({ behavior: "deny", message: "The operator did not respond in time. Skip this step or finish up with what you have." });
      }, PERMISSION_TIMEOUT_MS);
      this.pending = { toolName, desc, resolve, timer, input };
      this.status = "needs_input";
      this.emit({
        type: "needs_input", status: "needs_input",
        text: `${this.name} wants to run ${toolName}${desc ? ": " + desc : ""}. Say approve or deny.`,
        speak: true,
      });
    });
  }

  resolvePermission(decision) {
    if (!this.pending) return false;
    const { resolve, timer, input, toolName } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    this.status = "running";
    if (decision === "allow") {
      resolve({ behavior: "allow", updatedInput: input });
    } else {
      resolve({ behavior: "deny", message: `The operator denied ${toolName} by voice. Adjust your approach or ask what to do instead.` });
    }
    this.emit({ type: "status", status: "running" });
    return true;
  }
}

class HostedSessions {
  constructor({ broadcast, briefModel, autoAllow }) {
    this.broadcast = broadcast;
    this.sessions = new Map();
    this.sdkQuery = null;
    this.sdkError = "";
    this.autoAllow = new Set(Array.isArray(autoAllow) && autoAllow.length ? autoAllow : DEFAULT_AUTO_ALLOW);
    require("./summarizer").setModel(briefModel);
    // prune ended sessions so long-running relays don't accumulate them
    setInterval(() => {
      const cutoff = Date.now() - 15 * 60 * 1000;
      let changed = false;
      for (const [id, s] of this.sessions) {
        if (s.closed && s.lastEventAt < cutoff) { this.sessions.delete(id); changed = true; }
      }
      if (changed) this.broadcast({ type: "sessions" });
    }, 5 * 60 * 1000);
  }

  async ensureSdk() {
    if (this.sdkQuery || this.sdkError) return;
    try {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      this.sdkQuery = mod.query;
    } catch (e) {
      this.sdkError = "Agent SDK is not installed. Run npm install in the claude-glasses folder.";
      console.error("[hosted] " + this.sdkError, e.message);
    }
  }

  start({ cwd, prompt, name }) {
    if (!fs.existsSync(cwd)) throw new Error(`directory does not exist: ${cwd}`);
    const s = new HostedSession({ cwd, name, broadcast: this.broadcast, autoAllow: this.autoAllow });
    s.onSettled = () => this.brief(s.id, require("./summarizer").makeBrief).catch(() => {});
    this.sessions.set(s.id, s);
    s.pushMsg(s.userMessage(prompt));
    this.ensureSdk().then(() => {
      if (this.sdkQuery) {
        s.run(this.sdkQuery);
      } else {
        s.status = "error";
        s.lastResult = this.sdkError;
        s.emit({ type: "error", status: "error", text: this.sdkError, speak: true });
      }
    });
    this.broadcast({ type: "sessions" });
    return s;
  }

  claudeSessionIds() {
    const ids = new Set();
    for (const s of this.sessions.values()) if (s.claudeSessionId) ids.add(s.claudeSessionId);
    return ids;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, name: s.name, source: "hosted", cwd: s.cwd,
      status: s.status, pendingPermission: !!s.pending,
      commands: s.commands,
    }));
  }

  has(id) { return this.sessions.has(id); }

  async brief(id, makeBrief) {
    const s = this.sessions.get(id);
    if (!s) return "That session is gone.";
    const mins = Math.round((Date.now() - s.startedAt) / 60000);
    const digest = [
      `Working directory: ${s.cwd}`,
      `Running for ${mins} minutes. Current state: ${s.status}.`,
      s.pending ? `Waiting for permission to run ${s.pending.toolName}: ${s.pending.desc}` : "",
      `Recent tools used: ${s.tools.join(", ") || "none yet"}`,
      `Latest assistant message: ${(s.lastText || "").slice(0, 1500)}`,
      s.lastResult ? `Last turn result: ${s.lastResult.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
    return makeBrief({ name: s.name, status: s.status, digest });
  }

  async sendMessage(id, text) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: "session gone" };
    if (s.closed) return { ok: false, error: "that session has ended" };
    s.pushMsg(s.userMessage(text));
    if (s.pending) {
      // the current turn is blocked on an approval; the message is queued
      return {
        ok: true,
        note: `Queued. ${s.name} is still waiting for permission to run ${s.pending.toolName}. Say approve or deny first.`,
      };
    }
    s.status = "running";
    s.emit({ type: "status", status: "running" });
    return { ok: true };
  }

  async permission(id, decision) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: "session gone" };
    if (!s.resolvePermission(decision)) return { ok: false, error: "nothing is waiting for approval" };
    return { ok: true };
  }

  async interrupt(id) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: "session gone" };
    try {
      s.clearPending("The operator interrupted the session while this tool was awaiting approval.");
      if (s.q && s.q.interrupt) await s.q.interrupt();
      s.status = "idle";
      s.emit({ type: "status", status: "idle" });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: "session gone" };
    await s.shutdown();
    this.sessions.delete(id);
    this.broadcast({ type: "sessions" });
    return { ok: true };
  }
}

module.exports = { HostedSessions };
