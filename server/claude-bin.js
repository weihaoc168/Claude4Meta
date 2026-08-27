"use strict";
// Locate and run the Claude Code CLI without going through .ps1/.cmd shims,
// which Node cannot spawn shell-free on Windows.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let resolved = null;

// Child sessions must not inherit the context of whatever Claude session may
// have launched this server (session IDs, scratchpad paths, harness flags) —
// leaked vars misroute file writes and confuse the nested CLI.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k) && k !== "CLAUDE_EXE") continue;
    env[k] = v;
  }
  return env;
}

function resolveClaude() {
  if (resolved) return resolved;
  const candidates = [
    process.env.CLAUDE_EXE,
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { resolved = c; return c; } } catch { /* keep looking */ }
  }
  resolved = "claude"; // PATH fallback (works on unix installs)
  return resolved;
}

function runClaude(args, { stdin = "", timeoutMs = 90000 } = {}) {
  return new Promise((resolvePromise) => {
    const exe = resolveClaude();
    let child;
    try {
      child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: cleanEnv() });
    } catch (e) {
      resolvePromise({ ok: false, stdout: "", stderr: String(e), code: -1 });
      return;
    }
    let out = "", err = "", done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, stdout: out, stderr: err, code });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
      finish(-2);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { err += String(e); finish(-1); });
    child.on("close", finish);
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

module.exports = { resolveClaude, runClaude, cleanEnv };
