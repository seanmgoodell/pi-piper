# Deploying pi-gui on a fresh machine (from a git bundle)

You received `pi-gui.bundle` — a single-file copy of the whole repository
(history included). No GitLab access needed. This version of pi requires
**Node ≥ 22.19**, plus **git** and a configured **pi**. Steps below are written for
CachyOS / Arch Linux; adapt the package commands for other distros.

## 1. Node, npm, and git

```sh
sudo pacman -S --needed nodejs npm git
node --version     # must be ≥ 22.19 for this version of pi
```

## 2. pi

```sh
# Skip the install if pi is already installed and working.
sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version       # sanity check
```

## 3. Configure at least one model provider

pi-gui uses whatever providers your pi is configured with. Run `pi`, type
`/login`, and choose a provider; pi walks you through subscription sign-in or
adding an API key. Try a short prompt inside pi to confirm it works. Credentials
are stored privately under `~/.pi/agent/`; **do not copy Dad's credentials**.
If you already use pi with a working model, skip this step.

If you instead set an API key in `.bashrc`/`.zshrc` (for example,
`GEMINI_API_KEY`), it works when starting the GUI from that shell, but a
systemd user service **will not inherit your shell profile**. Use `/login` for
the optional service below, or explicitly configure its environment securely.

## 4. Unpack pi-gui

```sh
cd ~
git clone ~/Downloads/pi-gui.bundle pi-gui
cd pi-gui
```

(`git clone` works on a bundle exactly like on a remote URL.)

## 5. Run it

```sh
node server.mjs
```

Open **http://127.0.0.1:4747** in a browser. Tabs = one pi session each; the
**＋** button starts a session in any folder. Your open tabs and their
conversations are restored automatically after a server restart (the
session list lives in `~/pi-gui/sessions.json`).

## 6. Verify the install (optional, no LLM calls)

```sh
node test/smoke.mjs       # expects: 35/35 checks passed
```

## 7. Start at login (optional)

```sh
mkdir -p ~/.config/systemd/user
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

If your `node` lives elsewhere (`command -v node`), use that path in
`ExecStart`.

## 8. Updating when Dad sends a new bundle

Replace the old bundle file and pull:

```sh
cd ~/pi-gui
git pull ~/Downloads/pi-gui.bundle main
```

(If the server runs as a systemd service: `systemctl --user restart pi-gui`.)

## Notes

- The server binds **127.0.0.1 only** and rejects non-loopback Host headers —
  it is a local tool; don't port-forward it.
- Everything pi-gui needs is in the repo: one Node file + one HTML file, zero
  npm dependencies, no build step.
- pi must be working before pi-gui is useful: start `pi` in a terminal and
  try a prompt if anything looks off.