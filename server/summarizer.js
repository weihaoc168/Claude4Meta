"use strict";
// Turns raw session activity into one short spoken sentence. Fast path: a
// direct Haiku API call reusing the Claude Code login's OAuth token (~1-2s).
// Fallback: spawning claude -p (slow, 5-10s) which also refreshes the token.
// Results are cached per activity digest, and the TTS audio is pre-warmed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("./claude-bin");

const SYSTEM_PROMPT =
  "You produce one short spoken status update for a developer who is listening " +
  "through audio glasses, away from any screen. Rules: at most two short sentences, " +
  "under 40 words total. Plain conversational speech. No markdown, no code, no file " +
  "paths, no URLs, no quotes. Name concrete outcomes, not tool mechanics. If the " +
  "session is waiting on the developer, say exactly what it is waiting for. " +
  "Always answer in English, whatever language the digest contains. " +
  "Input below is a machine digest of a Claude Code session; reply with the update only.";

const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const cache = new Map(); // digestHash -> text
const inflight = new Map(); // digestHash -> promise
let model = "claude-haiku-4-5";
let directBroken = false; // set on 401/403 so we stop retrying a dead path

function setModel(m) { if (m) model = m; }

function fallbackBrief({ name, status }) {
  const map = {
    running: `${name} is still working.`,
    idle: `${name} is idle and ready for instructions.`,
    needs_input: `${name} is waiting for your approval.`,
    done: `${name} has finished its task.`,
    error: `${name} hit an error.`,
  };
  return map[status] || `${name} status is ${status}.`;
}

async function directBrief(input) {
  if (directBroken) throw new Error("direct path disabled");
  const cred = JSON.parse(fs.readFileSync(CRED_PATH, "utf8")).claudeAiOauth;
  if (!cred || !cred.accessToken) throw new Error("no oauth token");
  if (Date.now() > (cred.expiresAt || 0) - 60000) throw new Error("token near expiry");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cred.accessToken,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 403) {
    directBroken = true;
    throw new Error("oauth rejected: " + r.status);
  }
  if (!r.ok) throw new Error("api " + r.status);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  if (!text) throw new Error("empty response");
  return text;
}

async function cliBrief(input) {
  const r = await runClaude(
    ["-p", "--system-prompt", SYSTEM_PROMPT, "--model", model,
     "--tools", "", "--no-session-persistence", "--setting-sources", ""],
    { stdin: input, timeoutMs: 60000 }
  );
  return (r.ok && r.stdout.trim()) || "";
}

async function makeBrief({ name, status, digest }) {
  const hash = crypto.createHash("sha1").update(name + "|" + status + "|" + digest).digest("hex");
  if (cache.has(hash)) return cache.get(hash);
  if (inflight.has(hash)) return inflight.get(hash);

  const p = (async () => {
    const t0 = Date.now();
    const input = `Session "${name}" (state: ${status})\n\n${digest}`.slice(0, 12000);
    let text = "", how = "direct";
    try {
      text = await directBrief(input);
    } catch {
      how = "cli";
      try { text = await cliBrief(input); } catch { text = ""; }
    }
    text = text.replace(/[*_`#>\[\]]/g, "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 400) text = fallbackBrief({ name, status });
    console.log(`[brief] ${how} ${Date.now() - t0}ms ${name}`);
    cache.set(hash, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    try { require("./tts").warm(text); } catch { /* tts optional */ }
    return text;
  })().finally(() => inflight.delete(hash));

  inflight.set(hash, p);
  return p;
}

module.exports = { makeBrief, setModel, fallbackBrief };
