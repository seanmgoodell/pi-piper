# pi-gui

A tiny local web GUI for the [pi coding agent](https://github.com/badlogic/pi-mono).
Zero npm dependencies: plain Node >= 18 + one HTML file. It spawns
`pi --mode rpc`, bridges JSONL ↔ the browser over HTTP + SSE, and renders a
full chat transcript with streaming, tool calls, thinking blocks, and
multiple parallel sessions.

```
browser  <--HTTP/SSE-->  node server.mjs  <--stdin/stdout JSONL-->  pi --mode rpc
```

## Run

```sh
cd ~/pi-gui
node server.mjs          # http://127.0.0.1:4747
```

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `PI_GUI_PORT` | `4747` | listen port (127.0.0.1 only) |
| `PI_GUI_CWD` | `$PWD` | working dir for the initial session |
| `PI_BIN` | `pi` | pi executable |
| `PI_GUI_NOTIFY` | on (macOS & Linux) | `0` to disable native notifications (osascript / notify-send) |

## Setup on a new machine

Works on macOS and Linux (tested targets: macOS + CachyOS/Arch). Three
requirements: **Node >= 18**, **pi**, and this folder.

### 1. Node

```sh
# macOS (Homebrew)
brew install node

# CachyOS / Arch
sudo pacman -S nodejs          # or: sudo pacman -S nodejs-lts
```

### 2. pi

```sh
npm install -g @earendil-works/pi-coding-agent
pi --version                   # sanity check
```

Your `~/.pi/agent/` config (models, settings, auth) travels with your account —
the ollama-pro and openai-codex providers work from any machine; the local
`llamaswap` provider only works where `http://10.0.4.79:8080` is reachable.

### 3. pi-gui

```sh
git clone https://gitlab.seanlab.us/homelab/pi-gui.git ~/pi-gui
cd ~/pi-gui && node server.mjs
# open http://127.0.0.1:4747
```

### Start at login (optional)

**macOS** — System Settings → General → Login Items → add a shell script or
`/usr/bin/open http://127.0.0.1:4747` after starting the server, or a LaunchAgent:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/us.sean.pi-gui.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>us.sean.pi-gui</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string>
    <string>cd $HOME/pi-gui && exec node server.mjs</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pi-gui.log</string>
  <key>StandardErrorPath</key><string>/tmp/pi-gui.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/us.sean.pi-gui.plist
```

**CachyOS (systemd --user)** — note the PATH: `pi` and `node` must be on it:

```sh
cat > ~/.config/systemd/user/pi-gui.service <<'EOF'
[Unit]
Description=pi-gui local web GUI

[Service]
WorkingDirectory=%h/pi-gui
Environment=PATH=/usr/bin:/bin
ExecStart=/usr/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pi-gui
```

## Features

### Multiple parallel sessions (tabs)
- **⊕** in the tab bar opens a new pi process in a folder of your choice
  (max 5, server-enforced). Each session has its own cwd, model, history and SSE stream.
- **Double-click a tab** to rename it (persisted via `set_session_name`).
- **✕** closes a tab (kills that pi process). Background sessions keep running;
  a pulsing dot shows when they're mid-turn.
- **Recent projects** persist in `~/pi-gui/projects.json` and appear in the picker.
- Click the **folder pill** in the header to open the project picker (folder
  browser with parent navigation + ⌂ home).

### Chat
- Streaming assistant text (markdown + syntax-highlighted code with copy buttons),
  collapsible thinking blocks, compact one-line tool rows (click to expand args/result,
  ✕ on failed tools).
- **File peek**: click any file path in a tool row (or "View file") → side drawer
  with the file's contents (≤1MB, text only).
- **Enter** sends, **Shift+Enter** newline, **Esc** aborts the current run.

### Slash menu
Type `/` to see available commands (pi built-ins, prompt templates, skills,
extension commands). `↑↓` to navigate, `Tab`/`Enter` to select.
Prompt-template arguments (`/refactor`) are sent as-is — pi expands them.

### Bash mode
Type `!` to run a shell command directly in the session's cwd — output streams
live into the transcript (e.g. `!git status`). Bypasses the LLM.

### Queue controls
- **⇢ steer / queue** toggle: while pi is running, new messages either steer the
  current run (delivered after the in-flight tool calls) or queue until it stops.
- Queued messages show as chips above the input; **✕ all** clears the queue.

### Retry controls
On a failed turn an error bar appears: **Retry** (resends the last prompt),
**Stop retries** (`abort_retry`), and an auto-retry toggle (`set_auto_retry`).

### Context gauge
Footer shows context usage (tokens / window, %) and cost, refreshed after each
turn and compaction. Popover offers **Compact now** (`compact`) and an
auto-compaction toggle.

### Attachments
- **📎** button, paste, or drag-and-drop.
- Images (png/jpg/gif/webp, ≤10MB) go to the model natively — vision models only.
  Attaching to a text-only model warns immediately, and sending is blocked with a
  hint to switch to a vision model (input and attachments are kept).
- Text/code files (≤100KB, common extensions) are inlined into the prompt.

### Notifications
macOS native notification when a turn finishes or pi exits (`PI_GUI_NOTIFY=0` off).

## API (server)

| Method & path | Purpose |
| --- | --- |
| `GET /` | the UI (index.html) |
| `GET /api/info` | `{ sessions, maxSessions, home }` |
| `GET /api/sessions` | list sessions `{sid, cwd, name, running, pid}` |
| `POST /api/sessions` `{cwd?, name?}` | create a session (409 at the limit) |
| `POST /api/close` `{sid}` | kill a session |
| `POST /api/restart` `{sid?, cwd?}` | restart a session's pi (optionally new cwd) |
| `GET /api/events?sid=X` | SSE stream of all records for that session |
| `POST /api/command` `{sid, command, timeoutMs?}` | forward one RPC command |
| `GET /api/dirs?path=...` | directory listing for the picker |
| `GET /api/file?path=...` | file preview for the peek drawer |

## Tests

```sh
node test/smoke.mjs
```

Zero-dependency smoke suite. It runs `server.mjs` against a stub `pi`
(`test/stub-pi.mjs`) that speaks the RPC protocol, so it covers the HTTP/SSE
surface, session lifecycle (restart races, stdin-EPIPE survival, graceful
shutdown, `--session` resume, boot restore), the Host-header check, and
`index.html` script syntax — without any LLM calls.

For a deeper acceptance pass against the real `pi` binary (costs a few LLM
calls):

```sh
node test/e2e-real.mjs
```

It drives a full conversation through the server: tool use, bash mode,
history, stats, steering modes, export_html, a restart with conversation
continuity + memory check, and a vision model round-trip.

## Notes
- Local-only: binds `127.0.0.1`, rejects non-loopback `Host` headers
  (DNS-rebinding mitigation), no auth — don't port-forward it.
- Model/thinking-level selectors are per-session; switching tabs updates them
  to that session's state.
- The UI has no CDN dependencies — works fully offline.
