# Claude4Meta

Claude Code on Meta AI glasses. Your glasses tell you, in a short spoken sentence, what your coding sessions are doing. You answer with your voice: give an instruction, approve a permission, run a slash command, start a new session. It works from anywhere your phone has signal.

Meta glasses do not run third party apps, so everything rides through the phone. The glasses are Bluetooth audio for a small web app on the phone, and the web app talks to a relay on the PC where Claude Code runs.

```
Meta glasses  <-- Bluetooth audio -->  Android phone (Chrome PWA)
                                              |
                                        HTTPS over Tailscale
                                              |
                                    PC: relay (Node) + Claude Code
                                              |
                          hosted sessions | this PC's sessions | claude.ai account sessions
```

## What you get

- **Spoken briefs.** Tap the temple twice and hear a two sentence status of the active session. First ask after new activity takes a second or two, then answers come from cache instantly.
- **Announcements.** The app speaks on its own when a session finishes, hits an error, or is waiting for you.
- **Voice instructions.** Tap once, speak, and the words go into the session as a normal message.
- **Voice approvals.** When a hosted session wants to run a tool that is not pre-approved, the glasses ask. Say approve or deny.
- **Slash commands by voice.** Every slash command the session reports, built-ins and your own skills, is mapped one to one. "Run code review", "run compact", "run model sonnet".
- **All your sessions.** Sessions started from the app, sessions running in your terminal or editor on the PC, and sessions anywhere on your claude.ai account, including other machines.
- **Natural neural voice** through the glasses, with selectable audio profiles.

## Requirements

- A PC with Node 20 or newer and [Claude Code](https://code.claude.com) installed and logged in. The relay reuses that login; no API key is needed.
- An Android phone with Chrome. Meta glasses paired to it as usual.
- [Tailscale](https://tailscale.com) on the PC and the phone. Chrome only allows the microphone on HTTPS, and `tailscale serve` gives you a valid HTTPS URL that works away from home with nothing exposed to the internet.

## Quick start, PC side

```powershell
git clone https://github.com/ImagenWeihao/Claude4Meta.git
cd Claude4Meta
npm install
node server\index.js
```

The first run writes `server\config.json` with a random access token and prints the token and the URLs. Then put HTTPS in front of it:

```powershell
tailscale serve --bg 8787
```

That prints an `https://<pc>.<tailnet>.ts.net` URL. It is reachable only from devices on your tailnet.

Add your projects to `server\config.json` so you can say "new session in <name>":

```json
{
  "port": 8787,
  "token": "generated on first run",
  "briefModel": "claude-haiku-4-5",
  "ttsVoice": "en-US-JennyNeural",
  "autoAllow": [],
  "projects": [
    { "name": "myapp", "cwd": "C:\\code\\myapp" }
  ]
}
```

## Quick start, phone side

1. Open the Tailscale HTTPS URL in Chrome. To skip typing the token, open `https://<your-url>/#token=<token>` once; the app stores it and drops it from the address bar.
2. Chrome menu, Add to Home screen.
3. Allow the microphone when asked.
4. Tap **Glasses mode**. Re-tap it every time you reopen the app; the browser only hands over the glasses tap controls on a fresh tap.

Keep the app in the foreground with the screen on while you use it. Glasses mode holds a wake lock for you.

## Glasses taps

| Tap | Action |
|---|---|
| Single | Open the microphone. Speak, then it sends by itself. |
| Double | Hear the active session brief. |
| Triple | Hear every session. |

## Voice commands

| Say | Effect |
|---|---|
| "status", "session status", "what's the status", "how's it going", "any updates" | Brief of the active session |
| "status all" | Brief of every session |
| "run ‹command›" | Run a slash command in the active session. Say hyphens as spaces: "run code review". Arguments pass through: "run model sonnet". A bare exact command name also works. |
| "list commands" | Speaks the active session's command list |
| "new session in ‹project›" | Starts a hosted session, then asks what it should do |
| "switch to ‹name›" | Changes the active session |
| "approve", "deny" | Answers a pending permission ask |
| "stop" | Interrupts the active session |
| "close session" | Ends the active hosted session and frees its process |
| "are you connected" | Speaks the connection state, including why it is broken |
| "help" | Lists the commands |
| anything else | Sent to the active session as an instruction |

Turn on "Read back instructions before sending" in settings if you want a yes or no confirmation before each instruction goes out.

## Session types

| Type | Where it comes from | What the glasses can do |
|---|---|---|
| hosted | Started from the app by voice, or through the API | Full control: briefs, instructions, approvals, slash commands, interrupt |
| watched | Any session you start in a terminal or editor on the PC | Listen only: briefs and announcements |
| cloud | Any session on your claude.ai account, cloud runs and Remote Control bridges from other machines | Listen only: briefs and announcements |

Hosted sessions run through the Claude Agent SDK, so the relay sees every message and every permission ask. Watched sessions are read from the transcript files under `~/.claude/projects`. Cloud sessions are read from the same claude.ai surface the web and desktop apps use, with your Claude Code login token. That surface is not a public API, so the cloud source fails soft: if it changes, those entries disappear while everything else keeps working.

## How briefs are made

The relay turns recent session activity into one spoken sentence with Claude Haiku. It calls the API directly with your Claude Code login token, which takes one to two seconds, and falls back to spawning `claude -p` if that is ever rejected. Briefs are cached per activity digest, generated ahead of time when a session finishes a turn or goes quiet, and their audio is pre-synthesized, so a temple tap after new activity usually hits a ready answer.

## Voice output

Speech comes from Microsoft's neural voices through the [`msedge-tts`](https://www.npmjs.com/package/msedge-tts) package, the same voices behind Edge's Read Aloud. Only the short brief text is sent out for synthesis, never code or transcripts. Pick a voice under **Audio profile** in the app settings. If the neural service is unavailable the app falls back to the phone's built in voice automatically.

Only non-multilingual voices are offered on purpose. The multilingual ones guess the language from the text and misread short briefs full of project names in French or German.

## Permissions and security

- Every API call needs the access token. The phone stores it locally; the relay compares it in constant time.
- Keep the relay on your tailnet. Do not expose it with Tailscale Funnel or a port forward.
- Hosted sessions ask over the glasses before running tools that are not pre-approved. Local read-only tools (`Read`, `Glob`, `Grep`, todo and subagent plumbing) are auto-allowed. `WebFetch` and `WebSearch` deliberately ask, because an auto-allowed fetch paired with auto-allowed reads would let a prompt-injected session send files off the machine with no ask ever surfacing. Set `"autoAllow": [...]` in the config to your own list if you accept that.
- Unanswered asks are denied after ten minutes.
- Text from sessions and from claude.ai is treated as data. It gets summarized and spoken, never executed.

## Keeping it running

`server\start-relay.ps1` runs the relay in a restart loop and exits if one is already listening. `server\start-relay.vbs` launches that loop with no window. Put a shortcut to the `.vbs` in your Startup folder (`shell:startup`) and the relay comes up at logon and survives crashes.

For an outside check, poll `GET /api/health` with the token from another machine every few minutes and notify yourself when it fails twice in a row. A NAS scheduler with a five line shell script does the job.

## Known limits

These come from Android Chrome, not from the app.

- Speech recognition uses the **phone microphone**, not the glasses microphone. Chrome never engages the Bluetooth voice channel. Keep the phone within about a meter. Replies always play through the glasses.
- The tab must stay in the **foreground with the screen on** for speech in and out. Temple taps still reach the app from the lock screen, but recognition cannot start reliably with the screen off.
- Recognition captures **one utterance per tap**. Continuous mode is unreliable on Android Chrome.

## Getting the glasses microphone

Meta officially supports glasses mic access for third party apps through plain Bluetooth HFP. A native Android app calls `AudioManager.setCommunicationDevice` and records 8 kHz mono audio beamformed to the wearer. No Meta SDK is needed for audio, and sideloading your own app is free through Developer Mode in the Meta AI app. Three ways to build on this relay:

1. **Phone call bridge, hours of work.** A Twilio number saved as a contact. "Hey Meta, call Jarvis" puts call audio on the glasses mic. Twilio ConversationRelay does streaming speech recognition and synthesis and exchanges text with the relay over a WebSocket.
2. **Native companion app, about a week.** A Kotlin foreground service inside a Capacitor wrapper around this same web app. Bluetooth SCO capture streams to the relay, Whisper on the PC transcribes, replies play back through the glasses. Avoid Android's SpeechRecognizer; it ignores Bluetooth routing on Samsung phones.
3. **WhatsApp voice notes, half a day.** A WhatsApp bot number plus "Hey Meta, send a voice message to Jarvis". Not conversational, but zero phone code.

## API

All endpoints need `X-Auth-Token` (or `?token=` for the event stream).

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Liveness, session count |
| `GET /api/sessions` | Sessions from all sources plus configured projects |
| `POST /api/sessions` `{project or cwd, prompt, name?}` | Start a hosted session |
| `GET /api/sessions/:id/brief` | Short spoken style status |
| `POST /api/sessions/:id/message` `{text}` | Send an instruction or a slash command |
| `POST /api/sessions/:id/permission` `{decision: allow or deny}` | Answer a permission ask |
| `POST /api/sessions/:id/interrupt` | Interrupt the current turn |
| `POST /api/sessions/:id/close` | End a hosted session |
| `GET /api/tts?text=...&voice=...` | Neural speech as MP3 |
| `GET /api/events` | Server-sent events: status, needs_input, done, error, sessions |

## Layout

```
app/       the phone PWA: index.html, app.js, manifest, service worker
server/    index.js (HTTP, auth, SSE), hosted-sessions.js (Agent SDK),
           local-agents.js (transcript watcher), cloud-sessions.js (claude.ai),
           summarizer.js (briefs), tts.js (voices), start-relay.ps1 and .vbs
```

## Disclaimers

Not affiliated with Meta, Anthropic, or Microsoft. The claude.ai session list and the Edge voice service are unofficial surfaces that may change without notice; both are used read-only and fail soft. Use at your own risk on your own account.
