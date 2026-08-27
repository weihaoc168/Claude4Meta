"use strict";
// Neural text-to-speech through Edge's free TTS service. Sounds far closer to
// an assistant voice than the phone's built-in robotic voices. The client
// falls back to speechSynthesis whenever this endpoint fails.

const crypto = require("node:crypto");

let voiceName = "en-US-JennyNeural";
const cache = new Map(); // sha1(voice|text) -> Buffer
const MAX_CACHE = 100;
const MAX_TEXT = 600;

// Selectable audio profiles; requests outside this list fall back to default.
// Deliberately NO "Multilingual" voices: those auto-detect language per text
// and misread short briefs with odd tokens in French or other languages.
const VOICES = new Set([
  "en-US-JennyNeural",
  "en-US-AriaNeural",
  "en-US-MichelleNeural",
  "en-US-ChristopherNeural",
  "en-US-GuyNeural",
  "en-US-EricNeural",
  "en-US-RogerNeural",
  "en-GB-RyanNeural",
  "en-GB-SoniaNeural",
]);

function setVoice(v) { if (v) voiceName = v; }

let lastVoice = ""; // whatever the phone last asked for; used to pre-warm audio

function warm(text) {
  synth(text, lastVoice).catch(() => {});
}

async function synth(text, voice) {
  const chosen = VOICES.has(voice) ? voice : voiceName;
  lastVoice = chosen;
  text = String(text).slice(0, MAX_TEXT);
  const key = crypto.createHash("sha1").update(chosen + "|" + text).digest("hex");
  if (cache.has(key)) return cache.get(key);

  const mod = require("msedge-tts");
  const MsEdgeTTS = mod.MsEdgeTTS || mod.default;
  const { OUTPUT_FORMAT } = mod;
  const t = new MsEdgeTTS();
  await t.setMetadata(chosen, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const out = t.toStream(text);
  const stream = out.audioStream || out;

  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error("tts timeout")), 20000);
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    stream.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  if (buf.length < 100) throw new Error("empty tts result");
  cache.set(key, buf);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return buf;
}

module.exports = { synth, setVoice, warm };
