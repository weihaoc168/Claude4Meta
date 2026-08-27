"use strict";
// Account-wide Claude Code sessions from claude.ai: cloud runs and Remote
// Control bridges from any machine, the same list the web and desktop apps
// show. Uses the Claude Code login's OAuth token against an UNOFFICIAL
// endpoint, so everything here fails soft: if the surface changes or the
// token is stale, the source just goes quiet. View-only: briefs and status,
// no steering (there is no public API for that).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("./claude-bin");

const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const BASE = "https://api.anthropic.com/v1/code/sessions";
const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // sessions active in the last 6h
const MAX_SESSIONS = 8;

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function readToken() {
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, "utf8")).claudeAiOauth;
    if (!cred || !cred.accessToken) return null;
    if (Date.now() > (cred.expiresAt || 0) - 60000) return null;
    return cred.accessToken;
  } catch {
    return null;
  }
}

function mapStatus(rec) {
  const bucket = String(rec.status_bucket || "").toLowerCase();
  const status = String(rec.status || "").toLowerCase();
  if (/wait|attention|input|permission/.test(bucket)) return "needs_input";
  if (bucket === "working" || status === "active") return "running";
  if (/complete|ended|closed|archived/.test(status)) return "done";
  return "idle";
}

class CloudSessions {
  constructor({ broadcast, localNames = () => new Set() }) {
    this.broadcast = broadcast;
    this.localNames = localNames;
    this.sessions = new Map(); // cse id -> record
    this.lastAuthRetry = 0;
  }

  headers(token) {
    return {
      Authorization: "Bearer " + token,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    };
  }

  async fetchJson(url) {
    let token = readToken();
    if (!token) {
      // claude auth status refreshes a stale token as a side effect;
      // do this at most once per 10 minutes
      if (Date.now() - this.lastAuthRetry > 10 * 60 * 1000) {
        this.lastAuthRetry = Date.now();
        await runClaude(["auth", "status"], { timeoutMs: 30000 });
        token = readToken();
      }
      if (!token) throw new Error("no fresh oauth token");
    }
    const r = await fetch(url, { headers: this.headers(token), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("cloud api " + r.status);
    return r.json();
  }

  startPolling() {
    const tick = () => this.poll().catch(() => { /* fails soft */ });
    tick();
    setInterval(tick, 30000);
  }

  async poll() {
    const j = await this.fetchJson(BASE);
    const rows = Array.isArray(j.data) ? j.data : [];
    const now = Date.now();
    const localSet = this.localNames();
    const found = new Map();

    const candidates = rows
      .filter((r) => r.id && r.last_event_at)
      .map((r) => ({ r, last: Date.parse(r.last_event_at) || 0 }))
      .filter((x) => now - x.last < ACTIVE_WINDOW_MS)
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_SESSIONS);

    for (const { r, last } of candidates) {
      // a Remote Control bridge of a session this relay already watches
      // locally would show up twice; skip the cloud twin
      const title = /[a-z0-9]/i.test(r.title || "") ? r.title : "";
      const name = title || `cloud session (${String(r.id).slice(-5)})`;
      if (r.environment_kind === "bridge" && localSet.has(norm(name))) continue;

      const prev = this.sessions.get(r.id);
      const status = mapStatus(r);
      found.set(r.id, {
        id: r.id, name, source: "cloud", cwd: "",
        status, last, pendingPermission: status === "needs_input",
      });

      if (prev && prev.status === "running" && status !== "running") {
        this.broadcast({
          type: "status", sessionId: r.id, sessionName: name, status,
          text: `${name}, on your account, has gone quiet. Say status for details.`,
          speak: true,
        });
      }
    }

    const changed =
      found.size !== this.sessions.size ||
      [...found.keys()].some((k) => !this.sessions.has(k)) ||
      [...found.values()].some((s) => (this.sessions.get(s.id) || {}).status !== s.status);
    this.sessions = found;
    if (changed) this.broadcast({ type: "sessions" });
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, name: s.name, source: s.source, cwd: s.cwd,
      status: s.status, pendingPermission: s.pendingPermission,
    }));
  }

  has(id) { return this.sessions.has(id); }

  async brief(id, makeBrief) {
    const s = this.sessions.get(id);
    if (!s) return "That session is gone.";
    let digestBody = "No recent events could be read.";
    try {
      const j = await this.fetchJson(`${BASE}/${encodeURIComponent(id)}/events`);
      const events = Array.isArray(j.data) ? j.data : [];
      const tools = [];
      let lastText = "", lastUser = "";
      for (const ev of events) { // newest first
        const content = ev.payload && ev.payload.message && ev.payload.message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const b of blocks) {
          if (ev.event_type === "assistant" && b.type === "text" && b.text && !lastText) lastText = b.text;
          if (ev.event_type === "assistant" && b.type === "tool_use" && b.name && tools.length < 12) tools.push(b.name);
          if (ev.event_type === "user" && b.type === "text" && b.text && !lastUser) lastUser = b.text;
        }
        if (typeof content === "string" && ev.event_type === "user" && !lastUser) lastUser = content;
        if (lastText && lastUser && tools.length >= 12) break;
      }
      const mins = Math.max(0, Math.round((Date.now() - s.last) / 60000));
      digestBody = [
        `This is a claude.ai account session (cloud or another machine). Watch only.`,
        `Last activity: ${mins === 0 ? "under a minute" : mins + " minutes"} ago`,
        `Recent tools used: ${tools.join(", ") || "none recorded"}`,
        lastUser ? `Latest user instruction: ${lastUser.slice(0, 400)}` : "",
        `Most recent assistant message: ${(lastText || "").slice(0, 1500)}`,
      ].filter(Boolean).join("\n");
    } catch { /* digest stays generic */ }
    return makeBrief({ name: s.name, status: s.status, digest: digestBody });
  }

  async sendMessage() {
    return { ok: false, error: "This is an account session, so it is view only from the glasses. Steer it in the Claude app or on the machine it runs on." };
  }
  async permission() {
    return { ok: false, error: "Account session, view only. Answer it in the Claude app." };
  }
  async interrupt() {
    return { ok: false, error: "Account session, view only. Stop it in the Claude app." };
  }
  async close() {
    return { ok: false, error: "Account session, view only. It leaves this list after six quiet hours." };
  }
}

module.exports = { CloudSessions };
