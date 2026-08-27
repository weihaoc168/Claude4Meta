"use strict";
// Claude Glasses relay: serves the voice PWA, tracks Claude Code sessions,
// and exposes a small voice-friendly HTTP API over token auth.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const { LocalAgentWatcher } = require("./local-agents");
const { HostedSessions } = require("./hosted-sessions");
const { CloudSessions } = require("./cloud-sessions");
const { makeBrief } = require("./summarizer");

// ---------- config ----------
const CONFIG_PATH = path.join(__dirname, "config.json");
let config = { port: 8787, token: "", briefModel: "claude-haiku-4-5", projects: [] };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
} catch { /* first run */ }
if (config.ttsVoice) require("./tts").setVoice(config.ttsVoice);
if (!config.token) {
  config.token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------- event bus (SSE) ----------
const sseClients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(": ping\n\n"); } catch { sseClients.delete(res); }
  }
}, 25000);

// ---------- session sources ----------
const hosted = new HostedSessions({ broadcast, briefModel: config.briefModel, autoAllow: config.autoAllow });
const local = new LocalAgentWatcher({ broadcast, excludeIds: () => hosted.claudeSessionIds() });
const cloud = new CloudSessions({
  broadcast,
  localNames: () => new Set(
    [...hosted.list(), ...local.list()]
      .map((s) => s.name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim())
  ),
});

function allSessions() {
  return [...hosted.list(), ...local.list(), ...cloud.list()];
}
function findSource(id) {
  if (hosted.has(id)) return hosted;
  if (local.has(id)) return local;
  if (cloud.has(id)) return cloud;
  return null;
}

// ---------- helpers ----------
function checkAuth(req, url) {
  const given = req.headers["x-auth-token"] || url.searchParams.get("token") || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css",
  ".png": "image/png", ".ico": "image/x-icon",
};
const APP_DIR = path.join(__dirname, "..", "app");

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  // health is token-free so the NAS watchdog can probe liveness; it reveals
  // nothing beyond "the relay process is up"
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (!checkAuth(req, url)) {
    const given = String(req.headers["x-auth-token"] || url.searchParams.get("token") || "");
    console.log(`[auth] rejected ${req.socket.remoteAddress} ${url.pathname} gotLen=${given.length} got4=${given.slice(0, 4)}`);
    json(res, 401, { error: "bad token" });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tts") {
    const text = (url.searchParams.get("text") || "").trim();
    if (!text) { json(res, 400, { error: "need text" }); return; }
    try {
      const buf = await require("./tts").synth(text, url.searchParams.get("voice") || "");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(buf);
    } catch (e) {
      json(res, 503, { error: "tts unavailable: " + String(e.message || e) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    json(res, 200, { sessions: allSessions(), projects: config.projects.map((p) => p.name) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readBody(req);
    const proj = config.projects.find(
      (p) => p.name.toLowerCase() === String(body.project || "").toLowerCase()
    );
    const cwd = body.cwd || (proj && proj.cwd);
    if (!cwd || !body.prompt) { json(res, 400, { error: "need cwd (or project) and prompt" }); return; }
    const s = hosted.start({ cwd, prompt: body.prompt, name: body.name || proj?.name });
    json(res, 200, { id: s.id, name: s.name });
    return;
  }

  // /api/sessions/:id/<action>
  if (parts[0] === "api" && parts[1] === "sessions" && parts.length >= 3) {
    const id = decodeURIComponent(parts[2]);
    const source = findSource(id);
    if (!source) { json(res, 404, { error: "unknown session" }); return; }
    const action = parts[3] || "";

    if (req.method === "GET" && action === "brief") {
      const text = await source.brief(id, makeBrief);
      json(res, 200, { text });
      return;
    }
    if (req.method === "POST" && action === "message") {
      const body = await readBody(req);
      if (!body.text) { json(res, 400, { error: "need text" }); return; }
      const r = await source.sendMessage(id, body.text);
      json(res, r.ok ? 200 : 409, r);
      return;
    }
    if (req.method === "POST" && action === "permission") {
      const body = await readBody(req);
      const r = await source.permission(id, body.decision === "allow" ? "allow" : "deny");
      json(res, r.ok ? 200 : 409, r);
      return;
    }
    if (req.method === "POST" && action === "interrupt") {
      const r = await source.interrupt(id);
      json(res, r.ok ? 200 : 409, r);
      return;
    }
    if (req.method === "POST" && action === "close") {
      const r = await source.close(id);
      json(res, r.ok ? 200 : 409, r);
      return;
    }
  }

  json(res, 404, { error: "no such route" });
}

const server = http.createServer((req, res) => {
  // new URL throws on targets like "GET //[" and treats "//host/x" as
  // protocol-relative; either would crash or misroute without these guards
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (url.host !== "localhost") { res.writeHead(400); res.end(); return; }
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    });
  } else if (req.method === "GET") {
    serveStatic(res, url.pathname);
  } else {
    res.writeHead(405); res.end();
  }
});

server.listen(config.port, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) addrs.push(n.address);
    }
  }
  console.log("Claude Glasses relay");
  console.log(`  token:  ${config.token}`);
  for (const a of addrs) console.log(`  url:    http://${a}:${config.port}`);
  console.log(`  note:   the phone browser needs HTTPS for the microphone.`);
  console.log(`          run: tailscale serve --bg ${config.port}`);
  local.startPolling();
  cloud.startPolling();
});
