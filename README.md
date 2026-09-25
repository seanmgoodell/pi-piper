# pi-piper

A tiny local web GUI for the [pi coding agent](https://github.com/badlogic/pi-mono).
Zero npm dependencies: plain Node >= 18 + one HTML file (current pi requires
Node >= 22.19). It spawns `pi --mode rpc`, bridges JSONL ↔ the browser over
HTTP + SSE, and renders a
full chat transcript with streaming, tool calls, thinking blocks, and
multiple parallel sessions.

```
browser  <--HTTP/SSE-->  node server.mjs  <--stdin/stdout JSONL-->  pi --mode rpc
```

## Run

```sh
cd ~/pi-piper
node server.mjs          # http://127.0.0.1:4747
```

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `PI_GUI_PORT` | `4747` | listen port (127.0.0.1 only) |
| `PI_GUI_CWD` | `$PWD` | working dir for the initial session |
| `PI_BIN` | `pi` | pi executable |
| `PI_GUI_NOTIFY` | on (macOS & Linux) | `0` to disable native notifications (osascript / notify-send) |
| `PI_GUI_STATE_DIR` | `~/.local/state/pi-piper` (`$XDG_STATE_HOME` if set; `%LOCALAPPDATA%\pi-piper` on Windows) | where `sessions.json` and `projects.json` are kept |
| `PI_GUI_PEEK_ANYWHERE` | off | `1` lets file peek / download read outside the open sessions' folders |

State used to live in `~/pi-piper/`; it is picked up from there (or from the
checkout folder) on first start and saved to the new location from then on.

## Setup on a new machine

Works on macOS, Linux, and Windows (tested targets: macOS + Arch (CachyOS)).
Three requirements: **Node >= 22.19** (for current pi), **pi**, and this folder.

### 1. Node

```sh
# macOS (Homebrew)
brew install node

# Arch (CachyOS)
sudo pacman -S --needed nodejs npm git

# Debian (Ubuntu)
sudo apt update
sudo apt install -y nodejs npm git

# Red Hat (Fedora)
sudo dnf install -y nodejs git

# openSUSE (Tumbleweed)
sudo zypper install -y nodejs git

# Alpine
sudo apk add nodejs npm git

# Windows (PowerShell)
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Distro-repo Node versions can trail pi's **>= 22.19** requirement — notably on
Debian/Ubuntu LTS and RHEL-family releases. Check `node --version`; if it's
older, install Node 22+ from NodeSource (deb.nodesource.com /
rpm.nodesource.com) or via nvm.

### 2. pi

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version                   # sanity check
```

Run `pi`, then `/login` to configure your own model provider. Authentication
is private to your account (`~/.pi/agent/auth.json`); do not share it.

### 3. pi-piper

```sh
git clone https://github.com/seanhome71/pi-piper.git ~/pi-piper
cd ~/pi-piper && node server.mjs
# open http://127.0.0.1:4747
```

### Start at login (optional)

**macOS** — System Settings → General → Login Items → add a shell script or
`/usr/bin/open http://127.0.0.1:4747` after starting the server, or a LaunchAgent:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/us.sean.pi-piper.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>us.sean.pi-piper</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string>
    <string>cd $HOME/pi-piper && exec node server.mjs</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pi-piper.log</string>
  <key>StandardErrorPath</key><string>/tmp/pi-piper.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/us.sean.pi-piper.plist
```

**Linux (systemd --user)** — tested on Arch (CachyOS); works on any systemd
distro. Note the PATH: `pi` and `node` must be on it (if `node` lives
elsewhere, use `command -v node`):

```sh
cat > ~/.config/systemd/user/pi-piper.service <<'EOF'
[Unit]
Description=pi-piper local web GUI

[Service]
WorkingDirectory=%h/pi-piper
Environment=PATH=/usr/bin:/bin
ExecStart=/usr/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pi-piper
```

**Windows** — drop a small launcher `.bat` into your Startup folder
(`Win+R` → `shell:startup`):

```bat
@echo off
cd /d %USERPROFILE%\pi-piper
start "" /min node server.mjs
```

Or register a scheduled task that runs at logon:

```powershell
schtasks /create /tn pi-piper /sc onlogon /tr "cmd /c cd /d %USERPROFILE%\pi-piper && node server.mjs"
```

Stop with `Ctrl+C` in the server terminal (that also kills all child `pi`
processes). To kill a detached instance, find the PID on the port, then kill
it:

```powershell
netstat -ano | findstr :4747
taskkill /PID <pid> /F
```

## Features

### Multiple parallel sessions (tabs)
- **⊕** in the tab bar opens a new pi process in a folder of your choice
  (max 5, server-enforced). Each session has its own cwd, model, history and SSE stream.
- **Double-click a tab** to rename it (persisted via `set_session_name`).
- **✕** closes a tab (kills that pi process). Background sessions keep running;
  a pulsing dot shows when they're mid-turn, a pulsing yellow dot when an
  extension is waiting for your answer.
- **Recent projects** persist in `projects.json` (see `PI_GUI_STATE_DIR`) and appear in the picker.
- Click the **folder pill** in the header to open the project picker (folder
  browser with parent navigation + ⌂ home).

### Chat
- Streaming assistant text (markdown + syntax-highlighted code with copy buttons),
  collapsible thinking blocks, compact one-line tool rows (click to expand args/result,
  ✕ on failed tools).
- **Follows the output**: the transcript stays pinned to the newest output while
  pi streams; scroll up to read and it stops following, **↓ Latest** (or scrolling
  back to the bottom) resumes.
- **Activity line** above the input, always visible: Working / Thinking / Writing /
  Using *tool*, elapsed time for the turn, and a yellow **no output for Ns** warning
  after 30 s of silence. Server disconnects show there too.
- **File peek**: click any file path in a tool row (or "View file") → side drawer
  with the file's contents (≤1MB, text only; files inside an open session's folder).
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
turn and compaction. Popover offers **Export HTML** (`export_html`, downloads the
saved transcript), **Compact now** (`compact`) and an auto-compaction toggle.

### Attachments
- **📎** button, paste, or drag-and-drop.
- Images (png/jpg/gif/webp, ≤10MB) go to the model natively — vision models only.
  Attaching to a text-only model warns immediately, and sending is blocked with a
  hint to switch to a vision model (input and attachments are kept).
- Text/code files (≤100KB, common extensions) are inlined into the prompt.

### Extension UI
Extension dialogs (`select`, `confirm`, `input`, `editor`) render inline with a
Cancel option; answers go back as pi's `value` / `confirmed` / `cancelled`
responses. Dialogs raised by a background tab are kept until you switch to it.
`notify` shows a toast, `setStatus` fills the footer, `setWidget` shows text
blocks above the input, `setTitle` sets the browser tab title and
`set_editor_text` fills the composer.

### Notifications
Native notification (macOS `osascript`, Linux `notify-send`) when a turn
finishes or pi exits (`PI_GUI_NOTIFY=0` off). Not available on Windows.

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
| `GET /api/file?path=...` | file preview for the peek drawer (≤1MB, first 800 lines; 403 outside the sessions' folders) |
| `GET /api/download?path=...` | raw full-file transfer (Export HTML; same folder rule) |

Browser requests to `/api/*` must be same-origin (`Origin` / `Sec-Fetch-Site`
are checked) and every `POST` must be `Content-Type: application/json`.
Non-browser clients such as `curl` send neither header and are unaffected.

## Tests

```sh
node test/smoke.mjs
```

Zero-dependency smoke suite. It runs `server.mjs` against a stub `pi`
(`test/stub-pi.mjs`) that speaks the RPC protocol, so it covers the HTTP/SSE
surface, session lifecycle (restart races, stdin-EPIPE survival, graceful
shutdown, `--session` resume, boot restore), the Host-header, CSRF and
file-access checks, and `index.html` script syntax — without any LLM calls.

For a deeper acceptance pass against the real `pi` binary (costs a few LLM
calls):

```sh
node test/e2e-real.mjs
```

It drives a full conversation through the server: tool use, bash mode,
history, stats, steering modes, export_html (full-file download), a restart with
conversation continuity + memory check, and a vision model round-trip.

## Notes
- Local-only: binds `127.0.0.1`, rejects non-loopback `Host` headers
  (DNS-rebinding mitigation) and cross-site browser requests (CSRF), serves the
  UI with a strict Content-Security-Policy. No auth — don't port-forward it.
- Model/thinking-level selectors are per-session; switching tabs updates them
  to that session's state.
- The UI has no CDN dependencies — works fully offline.
