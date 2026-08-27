"use strict";

// ---------- settings ----------
const store = {
  get url() { return localStorage.getItem("cg_url") || ""; },
  set url(v) { localStorage.setItem("cg_url", v); },
  get token() { return localStorage.getItem("cg_token") || ""; },
  set token(v) { localStorage.setItem("cg_token", v); },
  get rate() { return parseFloat(localStorage.getItem("cg_rate") || "1.0"); },
  set rate(v) { localStorage.setItem("cg_rate", String(v)); },
  get speakAll() { return localStorage.getItem("cg_speakall") === "1"; },
  set speakAll(v) { localStorage.setItem("cg_speakall", v ? "1" : "0"); },
  get confirm() { return localStorage.getItem("cg_confirm") === "1"; },
  set confirm(v) { localStorage.setItem("cg_confirm", v ? "1" : "0"); },
  get activeId() { return localStorage.getItem("cg_active") || ""; },
  set activeId(v) { localStorage.setItem("cg_active", v); },
  get voiceName() { return localStorage.getItem("cg_voice") || ""; },
  set voiceName(v) { localStorage.setItem("cg_voice", v); },
  get neural() { return localStorage.getItem("cg_neural") !== "0"; }, // default on
  set neural(v) { localStorage.setItem("cg_neural", v ? "1" : "0"); },
  get neuralVoice() { return localStorage.getItem("cg_nvoice") || ""; },
  set neuralVoice(v) { localStorage.setItem("cg_nvoice", v); },
};

const base = () => (store.url || location.origin).replace(/\/+$/, "");

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const logEl = $("log"), sessEl = $("sessions"), micBtn = $("micBtn"),
  glassesBtn = $("glassesBtn"), statusBtn = $("statusBtn"), connDot = $("connDot");

function logLine(cls, text) {
  const d = document.createElement("div");
  d.className = "line " + cls;
  d.textContent = text;
  logEl.appendChild(d);
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- api ----------
// apiState feeds spoken diagnostics: a voice-first app must say WHY it has no
// sessions (tailnet down vs bad token), not just report an empty list.
let apiState = "unknown"; // unknown | ok | unauthorized | unreachable

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(base() + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": store.token,
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    apiState = "unreachable";
    throw new Error("network: " + e.message);
  }
  if (r.status === 401) {
    apiState = "unauthorized";
    throw new Error("401 the relay rejected the token");
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
  apiState = "ok";
  return r.json();
}

function connectivityExcuse() {
  if (!store.token) return "No access token is set. Open settings, paste the token from the relay console, and save.";
  if (apiState === "unauthorized") return "The relay rejected the token. Open settings, paste it again with no extra spaces, and save.";
  if (apiState === "unreachable") return "I cannot reach the relay. Make sure Tailscale is connected on this phone, then try again.";
  if (apiState === "unknown") return "I have not reached the relay yet. Check that Tailscale is connected and the token is set.";
  return null;
}

// ---------- sessions ----------
let sessions = [];
let projects = [];

function activeSession() {
  return sessions.find((s) => s.id === store.activeId) || sessions[0] || null;
}

function renderSessions() {
  sessEl.innerHTML = "";
  const act = activeSession();
  for (const s of sessions) {
    const card = document.createElement("div");
    card.className = "sess" + (act && s.id === act.id ? " active" : "");
    card.innerHTML = `<div class="name"></div><div class="meta"><span class="st ${s.status}"></span><span class="mtext"></span></div>`;
    card.querySelector(".name").textContent = s.name;
    card.querySelector(".mtext").textContent = `${s.source} · ${s.status.replace("_", " ")}`;
    card.onclick = () => {
      store.activeId = s.id;
      renderSessions();
      speak(`Active session: ${s.name}.`);
    };
    sessEl.appendChild(card);
  }
  if (!sessions.length) {
    const d = document.createElement("div");
    d.className = "sess";
    d.innerHTML = `<div class="name">No sessions</div><div class="meta">start one from the PC or by voice</div>`;
    sessEl.appendChild(d);
  }
}

async function loadSessions() {
  try {
    const j = await api("/api/sessions");
    sessions = j.sessions || [];
    projects = j.projects || [];
    renderSessions();
  } catch (e) {
    logLine("info", "Could not load sessions: " + e.message);
  }
}

// ---------- speech synthesis ----------
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice =
    vs.find((v) => v.name === store.voiceName) ||
    vs.find((v) => v.lang.startsWith("en") && /Google|Natural|Online/i.test(v.name)) ||
    vs.find((v) => v.lang.startsWith("en")) || vs[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

let speaking = false;
let currentUtterance = null; // { text, onDone, canceled }
const speakQueue = [];

function speak(text, { log = true, onDone = null } = {}) {
  if (log) logLine("spoken", text);
  speakQueue.push({ text, onDone });
  drainSpeech();
}

let neuralStop = null;

// Neural voice: fetch an mp3 from the relay and play it through Web Audio.
// Never through an <audio> element: those seize Android's media-key routing,
// which the glasses temple tap relies on for push-to-talk. Returns falsy only
// on failure, so the caller can fall back to the phone's built-in voice.
async function playNeural(item) {
  try {
    const voiceParam = store.neuralVoice ? "&voice=" + encodeURIComponent(store.neuralVoice) : "";
    const r = await fetch(base() + "/api/tts?text=" + encodeURIComponent(item.text) + voiceParam, {
      headers: { "X-Auth-Token": store.token },
    });
    if (!r.ok) return false;
    const data = await r.arrayBuffer();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch { /* needs gesture */ } }
    const buf = await audioCtx.decodeAudioData(data);
    const outcome = await new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      neuralStop = () => { try { src.stop(); } catch { /* done */ } resolve("cancel"); };
      src.onended = () => resolve("ok");
      try { src.start(); } catch { resolve("err"); }
    });
    neuralStop = null;
    if (glassesOn && "mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    return outcome !== "err";
  } catch {
    neuralStop = null;
    return false;
  }
}

function finishUtterance() {
  speaking = false;
  const it = currentUtterance;
  currentUtterance = null;
  if (it && !it.canceled && it.onDone) {
    try { it.onDone(); } catch { /* ignore */ }
  }
  drainSpeech();
}

async function drainSpeech() {
  if (speaking || !speakQueue.length) return;
  if (listening) return; // an open mic wins; queue drains when it closes
  speaking = true;
  const item = speakQueue.shift();
  currentUtterance = item;
  if (store.neural && !item.canceled) {
    const played = await playNeural(item);
    if (played || item.canceled) { finishUtterance(); return; }
  }
  const u = new SpeechSynthesisUtterance(item.text);
  if (voice) u.voice = voice;
  u.rate = store.rate;
  u.onend = u.onerror = finishUtterance;
  speechSynthesis.speak(u);
}

// ---------- earcons ----------
let audioCtx = null;
function beep(freq, ms, when = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = freq;
    g.gain.value = 0.12;
    const t = audioCtx.currentTime + when;
    o.start(t); o.stop(t + ms / 1000);
  } catch { /* audio not available yet */ }
}

// ---------- speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, discardResult = false;

function initRec() {
  if (!SR) {
    logLine("info", "SpeechRecognition not supported in this browser.");
    return null;
  }
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.continuous = false;
  r.onresult = (ev) => {
    const t = ev.results[ev.results.length - 1][0].transcript.trim();
    if (!discardResult && t) {
      logLine("heard", t);
      handleUtterance(t);
    }
  };
  r.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    drainSpeech(); // play announcements that deferred while the mic was open
  };
  r.onerror = (ev) => {
    listening = false;
    micBtn.classList.remove("listening");
    if (ev.error !== "no-speech" && ev.error !== "aborted")
      logLine("info", "Mic error: " + ev.error);
    drainSpeech();
  };
  return r;
}

function startListening() {
  if (listening) return;
  rec = rec || initRec();
  if (!rec) return;
  if (currentUtterance) currentUtterance.canceled = true; // its onDone must not fire
  speechSynthesis.cancel();
  if (neuralStop) neuralStop();
  speaking = false;
  speakQueue.length = 0;
  discardResult = false;
  try {
    rec.start();
    listening = true;
    micBtn.classList.add("listening");
    beep(880, 90);
  } catch { /* start() while already running */ }
}

function stopListening(discard = false) {
  if (!listening || !rec) return;
  discardResult = discard;
  try { rec.stop(); } catch { /* ignore */ }
  listening = false;
  micBtn.classList.remove("listening");
  if (!discard) beep(520, 90);
}

function toggleListening() {
  listening ? stopListening() : startListening();
}

// ---------- command grammar ----------
let pendingSend = null;       // text awaiting "yes" when confirm mode is on
let pendingNewProject = null; // project awaiting its opening instruction

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findSession(phrase) {
  const p = norm(phrase);
  if (!p) return null;
  let best = null, bestScore = 0;
  for (const s of sessions) {
    const name = norm(s.name);
    if (!name) continue; // a name with no Latin chars would match everything
    let score = 0;
    if (name === p) score = 100;
    else if (name.includes(p) || (name.length >= 3 && p.includes(name))) score = 60;
    else {
      const toks = p.split(" ");
      score = toks.filter((t) => t.length > 2 && name.includes(t)).length * 10;
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 10 ? best : null;
}

// briefs are cached so a temple tap answers instantly; the cache refreshes in
// the background and is dropped whenever the session does something new
const briefCache = new Map(); // sessionId -> text

async function fetchBrief(s) {
  const j = await api(`/api/sessions/${encodeURIComponent(s.id)}/brief`);
  briefCache.set(s.id, j.text || "");
  return j.text || "";
}

async function speakBrief(session) {
  if (!session) {
    speak(connectivityExcuse() || "No sessions are running. Say new session in a project name to start one.");
    return;
  }
  const cached = briefCache.get(session.id);
  if (cached) {
    speak(cached);
    fetchBrief(session).catch(() => {});
    return;
  }
  speak(`Checking ${session.name}.`);
  try {
    speak((await fetchBrief(session)) || `${session.name} has no update.`);
  } catch (e) {
    speak(connectivityExcuse() || `Could not get status for ${session.name}.`);
  }
}

async function speakAllBriefs() {
  if (!sessions.length) await loadSessions();
  if (!sessions.length) {
    speak(connectivityExcuse() || "No sessions are running right now.");
    return;
  }
  for (const s of sessions.slice(0, 5)) {
    const cached = briefCache.get(s.id);
    if (cached) {
      speak(`${s.name}: ${cached}`);
      fetchBrief(s).catch(() => {});
      continue;
    }
    try {
      speak(`${s.name}: ${await fetchBrief(s)}`);
    } catch { speak(`${s.name}: status unavailable.`); }
  }
}

async function sendMessage(text) {
  if (!sessions.length) await loadSessions();
  const s = activeSession();
  if (!s) {
    speak(connectivityExcuse() || "No session is running to receive that. Say new session in a project name first.");
    return;
  }
  try {
    const j = await api(`/api/sessions/${encodeURIComponent(s.id)}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    speak(j.note || `Sent to ${s.name}.`);
  } catch (e) {
    speak(`Sending failed: ${e.message}`);
  }
}

async function sendPermission(decision) {
  const s = sessions.find((x) => x.pendingPermission) || activeSession();
  if (!s) { speak("Nothing is waiting for approval."); return; }
  try {
    await api(`/api/sessions/${encodeURIComponent(s.id)}/permission`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    speak(decision === "allow" ? `Approved for ${s.name}.` : `Denied for ${s.name}.`);
  } catch (e) {
    speak(`That did not go through: ${e.message}`);
  }
}

// Natural-language status ask: every word must be a status word or filler, so
// "what's the session status" matches but "update the readme" stays an
// instruction. Returns "all", "one", or null.
function statusIntent(t) {
  const words = t.split(" ").filter(Boolean);
  if (!words.length) return null;
  const CORE = new Set(["status", "progress", "update", "updates", "news", "going", "doing"]);
  const FILLER = new Set([
    "whats", "what", "is", "the", "a", "an", "hows", "how", "s", "it", "its",
    "check", "give", "me", "read", "any", "there", "session", "sessions",
    "current", "report", "please", "on", "things", "my", "all", "everything", "every",
  ]);
  if (!words.some((w) => CORE.has(w))) return null;
  if (!words.every((w) => CORE.has(w) || FILLER.has(w))) return null;
  // "going"/"doing" only count with a "how" ("how is it going"), not alone
  if (!words.some((w) => ["status", "progress", "update", "updates", "news"].includes(w)) &&
      !words.includes("how") && !words.includes("hows")) return null;
  const all = ["all", "everything", "every", "sessions"].some((w) => words.includes(w));
  return all ? "all" : "one";
}

// speech form of a slash command: "code-review" is said as "code review"
function speakable(name) {
  return name.replace(/[-_:]/g, " ").replace(/\s+/g, " ").trim();
}

// Resolve a spoken phrase against the active session's own slash commands
// (1:1 with what that Claude Code session reports). Longest match wins and
// anything after the command name is passed through as arguments.
function resolveCommand(phrase) {
  const s = activeSession();
  if (!s || !Array.isArray(s.commands) || !s.commands.length) return null;
  const p = norm(phrase);
  if (!p) return null;
  let best = null;
  for (const name of s.commands) {
    const n = norm(speakable(name));
    if (!n) continue;
    if (n === p) return { name, args: "" };
    if (p.startsWith(n + " ") && (!best || n.length > best.n.length)) {
      best = { name, n, args: phrase.trim().split(/\s+/).slice(n.split(" ").length).join(" ") };
    }
  }
  return best ? { name: best.name, args: best.args } : null;
}

async function runCommand(cmd) {
  const s = activeSession();
  if (!s) { speak(connectivityExcuse() || "No active session."); return; }
  const line = "/" + cmd.name + (cmd.args ? " " + cmd.args : "");
  try {
    const j = await api(`/api/sessions/${encodeURIComponent(s.id)}/message`, {
      method: "POST",
      body: JSON.stringify({ text: line }),
    });
    speak(j.note || `Running ${speakable(cmd.name)} in ${s.name}.`);
  } catch (e) {
    speak(`Could not run that: ${e.message}`);
  }
}

function matchProject(phrase) {
  const p = norm(phrase);
  let best = null, bestScore = 0;
  for (const name of projects) {
    const n = norm(name);
    let score = 0;
    if (n === p) score = 100;
    else if (n.includes(p) || p.includes(n)) score = 60;
    else score = p.split(" ").filter((w) => w.length > 2 && n.includes(w)).length * 10;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return bestScore >= 10 ? best : null;
}

async function startNewSession(project, prompt) {
  try {
    const j = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ project, prompt }),
    });
    store.activeId = j.id;
    await loadSessions();
    speak(`Started ${j.name}. It is the active session now.`);
  } catch (e) {
    speak(`Could not start that session: ${e.message}`);
  }
}

function handleUtterance(raw) {
  const t = norm(raw);

  if (pendingNewProject) {
    const project = pendingNewProject;
    pendingNewProject = null;
    if (/^(cancel|never mind|nevermind|no)$/.test(t)) { speak("Cancelled."); return; }
    startNewSession(project, raw);
    return;
  }

  if (pendingSend) {
    if (/^(yes|yeah|yep|send it|confirm|go ahead)\b/.test(t)) {
      const msg = pendingSend; pendingSend = null;
      sendMessage(msg);
    } else if (/^(no|nope|cancel|never mind|nevermind)\b/.test(t)) {
      pendingSend = null;
      speak("Cancelled.");
    } else {
      speak("Say yes to send, or no to cancel.");
    }
    return;
  }

  const si = statusIntent(t);
  if (si) {
    (async () => {
      if (!sessions.length) await loadSessions();
      if (si === "all") speakAllBriefs();
      else speakBrief(activeSession());
    })();
    return;
  }

  if (/^(list |what |which )?(commands?|skills?)( can i (say|run|use))?( are there)?$/.test(t)) {
    const s = activeSession();
    if (!s || !Array.isArray(s.commands) || !s.commands.length) {
      speak(s && s.source === "watched"
        ? "That session is watch only, so commands are not available."
        : "No command list yet. The session may still be starting.");
      return;
    }
    const names = s.commands.map(speakable);
    const head = names.slice(0, 18).join(", ");
    speak(`${s.name} supports ${names.length} commands: ${head}${names.length > 18 ? ", and more" : ""}.`);
    return;
  }

  if (/^(are you (there|connected|online)|connection( status)?|ping|test)$/.test(t)) {
    (async () => {
      await loadSessions();
      speak(connectivityExcuse() ||
        `Connected to the relay. ${sessions.length} session${sessions.length === 1 ? "" : "s"} visible.`);
    })();
    return;
  }

  let m = t.match(/^(?:new session|start(?: a)?(?: new)? session)(?: in| on| for)? (.+)$/);
  if (m) {
    const project = matchProject(m[1]);
    if (!project) {
      speak(projects.length
        ? `I know these projects: ${projects.join(", ")}. Which one?`
        : "No projects are configured on the relay yet.");
      return;
    }
    pendingNewProject = project;
    speak(`Starting a session in ${project}. What should it do?`, { onDone: startListening });
    return;
  }

  m = t.match(/^(?:switch to|go to|select) (.+)$/);
  if (m) {
    const s = findSession(m[1]);
    if (s) { store.activeId = s.id; renderSessions(); speak(`Switched to ${s.name}.`); }
    else speak(`I could not find a session called ${m[1]}.`);
    return;
  }

  if (/^(approve|allow|yes allow|go ahead|permission granted|accept)$/.test(t)) { sendPermission("allow"); return; }
  if (/^(deny|reject|no|do not allow|dont allow|decline)$/.test(t)) { sendPermission("deny"); return; }

  if (/^(stop|interrupt|halt|pause)( it| that| the session)?$/.test(t)) {
    const s = activeSession();
    if (s) api(`/api/sessions/${encodeURIComponent(s.id)}/interrupt`, { method: "POST", body: "{}" })
      .then(() => speak(`Interrupted ${s.name}.`))
      .catch(() => speak("Interrupt failed."));
    return;
  }

  if (/^(close|dismiss)( this| the| it)?( session| one)?$/.test(t)) {
    const s = activeSession();
    if (!s) { speak("No session to close."); return; }
    api(`/api/sessions/${encodeURIComponent(s.id)}/close`, { method: "POST", body: "{}" })
      .then(() => { speak(`Closed ${s.name}.`); loadSessions(); })
      .catch((e) => speak(`Could not close it: ${e.message}`));
    return;
  }

  if (/^(help|what can i say)$/.test(t)) {
    speak("Say status for an update, new session in a project name, switch to a session name, approve or deny for permissions, run and a command name for Claude Code commands, list commands to hear them, stop to interrupt, or just speak an instruction to send it.");
    return;
  }

  // Claude Code slash commands, mapped 1:1 from the active session.
  // "run <name> [args]" is explicit; a bare utterance that exactly names a
  // command also runs it. App words above always win over command names.
  const runMatch = t.match(/^(?:run|execute|slash|command) (.+)$/);
  if (runMatch) {
    const cmd = resolveCommand(runMatch[1]);
    if (cmd) { runCommand(cmd); return; }
    // unknown command: fall through so "run the tests" stays an instruction
  }
  const exact = resolveCommand(t);
  if (exact && exact.args === "") {
    runCommand(exact);
    return;
  }

  // anything else is an instruction for the active session
  if (store.confirm) {
    pendingSend = raw;
    speak(`Send: ${raw}? Say yes or no.`, { onDone: startListening });
  } else {
    sendMessage(raw);
  }
}

// ---------- server events (SSE) ----------
let es = null;
function connectEvents() {
  if (es) es.close();
  const u = new URL(base() + "/api/events");
  u.searchParams.set("token", store.token);
  es = new EventSource(u);
  es.onopen = () => { connDot.classList.add("on"); apiState = "ok"; };
  es.onerror = () => connDot.classList.remove("on");
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "sessions") { loadSessions(); return; }
    if (e.sessionId) {
      briefCache.delete(e.sessionId); // activity happened; the old brief is stale
      const s = sessions.find((x) => x.id === e.sessionId);
      if (s && e.status) { s.status = e.status; renderSessions(); }
    }
    if (e.text) {
      const act = activeSession();
      const relevant = store.speakAll || !e.sessionId || (act && e.sessionId === act.id)
        || e.type === "needs_input" || e.type === "error";
      const label = e.sessionName && sessions.length > 1 ? `${e.sessionName}: ` : "";
      if (relevant && e.speak !== false) speak(label + e.text);
      else logLine("info", label + e.text);
    }
  };
}

// ---------- glasses mode: media-key push-to-talk + wake lock ----------
let glassesOn = false, silentAudio = null, wakeLock = null;

// Near-silent 6-second WAV loop. Chrome requires media >= 5s with audio focus
// before it shows the media notification and routes AVRCP taps to the page,
// and a not-perfectly-silent track is more reliably treated as real playback.
function makeSilentWav() {
  const sr = 8000, n = sr * 6;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(Math.sin(i / 40) * 1.5));
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

async function enableGlassesMode() {
  silentAudio = silentAudio || new Audio(makeSilentWav());
  silentAudio.loop = true;
  silentAudio.volume = 0.01;
  try { await silentAudio.play(); } catch (e) {
    logLine("info", "Audio focus failed: " + e.message);
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Claude Glasses", artist: "tap to talk",
    });
    const ptt = () => {
      // keep the silent loop playing so media keys stay routed to us
      silentAudio.play().catch(() => {});
      navigator.mediaSession.playbackState = "playing";
      toggleListening();
    };
    navigator.mediaSession.setActionHandler("play", ptt);
    navigator.mediaSession.setActionHandler("pause", ptt);
    // double tap = brief, triple tap = all briefs. The beep is instant proof
    // the tap reached the app, even while the brief itself is still cooking.
    // Some devices deliver double-tap as seek instead of track-change.
    const briefTap = () => { beep(660, 90); logLine("info", "Tap: brief"); speakBrief(activeSession()); };
    const allTap = () => { beep(440, 90); logLine("info", "Tap: all briefs"); speakAllBriefs(); };
    for (const [action, fn] of [
      ["nexttrack", briefTap], ["previoustrack", allTap],
      ["seekforward", briefTap], ["seekbackward", allTap],
    ]) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported name */ }
    }
    navigator.mediaSession.playbackState = "playing";
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* wake lock optional */ }
  glassesOn = true;
  glassesBtn.classList.add("on");
  const a = activeSession();
  if (a && !briefCache.has(a.id)) fetchBrief(a).catch(() => {});
  speak("Glasses mode on. Tap your glasses to talk.");
}

function disableGlassesMode() {
  if (silentAudio) silentAudio.pause();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.setActionHandler("pause", null);
  }
  glassesOn = false;
  glassesBtn.classList.remove("on");
  logLine("info", "Glasses mode off.");
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !glassesOn) return;
  // returning to the foreground: retake audio focus, media keys, wake lock
  if (silentAudio) silentAudio.play().catch(() => {});
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  if (!wakeLock) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* ignore */ }
  }
});

// ---------- ui wiring ----------
micBtn.onclick = toggleListening;
glassesBtn.onclick = () => (glassesOn ? disableGlassesMode() : enableGlassesMode());
statusBtn.onclick = () => speakBrief(activeSession());

const dlg = $("settingsDlg");
$("settingsBtn").onclick = () => {
  $("setUrl").value = store.url;
  $("setToken").value = store.token;
  $("setRate").value = String(store.rate);
  $("setSpeakAll").checked = store.speakAll;
  $("setConfirm").checked = store.confirm;
  $("setNeural").checked = store.neural;
  if (store.neuralVoice) $("setNeuralVoice").value = store.neuralVoice;
  const sel = $("setVoice");
  sel.innerHTML = "";
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  for (const v of vs) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = v.name.replace(/^Microsoft |^Google /, "") + (/Online|Network/i.test(v.name) ? " *" : "");
    if (voice && v.name === voice.name) o.selected = true;
    sel.appendChild(o);
  }
  dlg.showModal();
};
$("cancelBtn").onclick = () => dlg.close();
$("saveBtn").onclick = () => {
  store.url = $("setUrl").value.trim();
  store.token = $("setToken").value.trim();
  store.rate = parseFloat($("setRate").value);
  store.speakAll = $("setSpeakAll").checked;
  store.confirm = $("setConfirm").checked;
  store.neural = $("setNeural").checked;
  store.neuralVoice = $("setNeuralVoice").value;
  if ($("setVoice").value) store.voiceName = $("setVoice").value;
  pickVoice();
  dlg.close();
  loadSessions();
  connectEvents();
  speak("This is how I sound now.");
};

// ---------- boot ----------
// setup link support: https://host/#token=... installs the token, no pasting
// multilingual voices were dropped (they misread briefs in other languages);
// clear any stored choice of one so the default applies again
if (/Multilingual/.test(store.neuralVoice)) store.neuralVoice = "";

const hashTok = location.hash.match(/token=([A-Za-z0-9_-]+)/);
if (hashTok) {
  store.token = hashTok[1];
  history.replaceState(null, "", location.pathname);
  logLine("info", "Access token installed from the setup link.");
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
logLine("info", "Claude Glasses ready.");
if (!store.token) logLine("info", "Open settings and paste the access token from the relay console.");
loadSessions();
connectEvents();
setInterval(loadSessions, 30000);
setInterval(() => {
  const a = activeSession();
  if (glassesOn && a && !briefCache.has(a.id)) fetchBrief(a).catch(() => {});
}, 45000);
