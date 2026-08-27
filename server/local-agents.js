"use strict";
// Read-only watcher for Claude Code sessions started outside the relay
// (terminals, VS Code, background agents). Tails the transcript files in
// ~/.claude/projects to report status; cannot inject messages into them.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const ACTIVE_WINDOW_MS = 60 * 60 * 1000; // sessions touched in the last hour
const RUNNING_WINDOW_MS = 120 * 1000;    // written to in the last 2 minutes
const MAX_SESSIONS = 8;
const TAIL_BYTES = 64 * 1024;

function readTailLines(file) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift(); // drop the partial first line
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  }
}

function parseTail(file) {
  const info = { title: "", cwd: "", lastText: "", tools: [], lastRole: "" };
  for (const line of readTailLines(file)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "summary" && rec.summary) info.title = rec.summary;
    if (rec.cwd) info.cwd = rec.cwd;
    if (rec.type === "assistant" || rec.type === "user") info.lastRole = rec.type;
    const content = rec.message && rec.message.content;
    if (rec.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) info.lastText = block.text;
        if (block.type === "tool_use" && block.name) {
          info.tools.push(block.name);
          if (info.tools.length > 12) info.tools.shift();
        }
      }
    }
  }
  return info;
}

class LocalAgentWatcher {
  constructor({ broadcast, excludeIds = () => new Set() }) {
    this.broadcast = broadcast;
    this.excludeIds = excludeIds;
    this.sessions = new Map(); // id -> session record
  }

  startPolling() {
    this.scan();
    setInterval(() => this.scan(), 15000);
  }

  scan() {
    const found = new Map();
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return; }
    const now = Date.now();
    const excluded = this.excludeIds();

    const candidates = [];
    for (const dir of dirs) {
      const full = path.join(PROJECTS_DIR, dir);
      let files;
      try { files = fs.readdirSync(full); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -6);
        if (excluded.has(id)) continue;
        const fp = path.join(full, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
        candidates.push({ id, fp, dir, mtime: st.mtimeMs });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const c of candidates.slice(0, MAX_SESSIONS)) {
      const prev = this.sessions.get(c.id);
      const status = now - c.mtime < RUNNING_WINDOW_MS ? "running" : "idle";
      let rec = prev;
      if (!rec || rec.mtime !== c.mtime) {
        const tail = parseTail(c.fp);
        const projName = tail.cwd ? path.basename(tail.cwd) : c.dir.split("-").filter(Boolean).pop();
        // titles without Latin letters or digits cannot be voice-matched
        // (and an empty normalized name would match every spoken phrase)
        const speakableTitle = /[a-z0-9]/i.test(tail.title || "") ? tail.title : "";
        rec = {
          id: c.id,
          name: speakableTitle || `${projName} (${c.id.slice(0, 5)})`,
          source: "watched",
          cwd: tail.cwd,
          status,
          mtime: c.mtime,
          tail,
          pendingPermission: false,
        };
      } else {
        rec = { ...rec, status };
      }
      found.set(c.id, rec);

      if (prev && prev.status === "running" && status === "idle") {
        this.broadcast({
          type: "status", sessionId: c.id, sessionName: rec.name, status,
          text: `${rec.name} has gone quiet. Say status for details.`, speak: true,
        });
        // pre-generate the brief so the follow-up "status" answers instantly
        setTimeout(() => this.brief(c.id, require("./summarizer").makeBrief).catch(() => {}), 100);
      }
    }

    const changed =
      found.size !== this.sessions.size ||
      [...found.keys()].some((k) => !this.sessions.has(k));
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
    const mins = Math.max(0, Math.round((Date.now() - s.mtime) / 60000));
    const digest = [
      `Project directory: ${s.cwd || "unknown"}`,
      `Last activity: ${mins === 0 ? "under a minute" : mins + " minutes"} ago`,
      `Recent tools used: ${s.tail.tools.join(", ") || "none recorded"}`,
      `Most recent assistant message: ${(s.tail.lastText || "").slice(0, 1500)}`,
      `Note: this session runs outside the relay; it is watch-only.`,
    ].join("\n");
    return makeBrief({ name: s.name, status: s.status, digest });
  }

  async sendMessage() {
    return { ok: false, error: "This session was started outside the relay, so it is watch only. Start a session from the glasses app to control it by voice." };
  }
  async permission() {
    return { ok: false, error: "Watch-only session. Approve it on the machine it runs on." };
  }
  async interrupt() {
    return { ok: false, error: "Watch-only session. Stop it on the machine it runs on." };
  }
  async close() {
    return { ok: false, error: "Watch-only session. It disappears from the list an hour after it goes quiet." };
  }
}

module.exports = { LocalAgentWatcher };
