#!/usr/bin/env node
// pi-piper server: a tiny zero-dependency bridge between a browser and a pi
// agent running in RPC mode. Supports MULTIPLE concurrent sessions
// (each = one pi child process with its own cwd, SSE stream, pending map).
//
//   GET  /api/info                   -> { sessions: [...] }
//   GET  /api/sessions               -> [{sid, cwd, name, running, pid}]
//   POST /api/sessions  {cwd?, name?} -> create a new session
//   POST /api/close     {sid}         -> kill a session's pi and drop it
//   POST /api/restart   {sid?, cwd?}  -> restart the pi child (optionally new cwd)
//   GET  /api/events?sid=X           -> SSE stream of every record for that session
//   POST /api/command {sid, command, timeoutMs?} -> forward a command, return its response
//   GET  /api/dirs?path=...          -> directory listing (for the project picker)
//   GET  /api/file?path=...          -> file preview (for the file peek panel)
//   GET  /api/download?path=...      -> raw file transfer (Export HTML; no preview caps)
//   GET  /                         -> the single-file UI
//
// Env:
//   PI_GUI_PORT       default 4747
//   PI_GUI_CWD        working directory for the initial session (default: $PWD)
//   PI_BIN            pi executable (default: "pi")
//   PI_GUI_NOTIFY=0   disable native notifications (macOS / Linux)
//   PI_GUI_STATE_DIR  where sessions.json / projects.json live
//                     (default: $XDG_STATE_HOME/pi-piper, ~/.local/state/pi-piper, or %LOCALAPPDATA%\pi-piper)
//   PI_GUI_STATE      override the sessions.json path only (used by the tests)
//   PI_GUI_PEEK_ANYWHERE=1  let /api/file + /api/download read outside the open sessions' folders
//
// The server binds 127.0.0.1 only — this is a local tool, not a web service.
// Browser requests to /api/* must be same-origin (Origin / Sec-Fetch-Site checked) and
// POSTs must be application/json, so other websites can't drive pi through your browser.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync,
  realpathSync, openSync, readSync, closeSync, createReadStream,
} from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PI_GUI_PORT || 4747);
const DEFAULT_CWD = process.env.PI_GUI_CWD || process.cwd();
const PI_BIN = process.env.PI_BIN || "pi";
const MAX_SESSIONS = 5;
const NOTIFY = process.env.PI_GUI_NOTIFY !== "0" && (process.platform === "darwin" || process.platform === "linux");
const PEEK_ANYWHERE = process.env.PI_GUI_PEEK_ANYWHERE === "1";

const sessions = new Map(); // sid -> session

// ---------------- persisted state ----------------
// Kept out of the repo checkout (and out of a hard-coded ~/pi-piper, which silently
// failed for any other clone location). Older locations are still read once so
// existing sessions/recent projects carry over.
function defaultStateDir() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pi-piper");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-piper");
}
const STATE_DIR = process.env.PI_GUI_STATE_DIR || defaultStateDir();
const RECENT_FILE = join(STATE_DIR, "projects.json");
const SESSIONS_FILE = process.env.PI_GUI_STATE || join(STATE_DIR, "sessions.json");
const LEGACY_DIRS = process.env.PI_GUI_STATE_DIR ? [] : [__dirname, join(homedir(), "pi-piper")];

function readJsonArray(file, name) {
  for (const f of [file, ...LEGACY_DIRS.map((d) => join(d, name))]) {
    try {
      const arr = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(arr)) return arr;
    } catch { /* missing or unreadable: try the next location */ }
  }
  return [];
}
const warned = new Set();
function writeJsonAtomic(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, file); // atomic replace: a crash mid-write can't leave half a file
  } catch (e) {
    if (!warned.has(file)) { warned.add(file); console.warn(`pi-piper: can't write ${file}: ${e.message}`); }
  }
}

const base = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || "/";

function loadRecent() {
  return readJsonArray(RECENT_FILE, "projects.json").filter((p) => typeof p === "string");
}
function saveRecent(dir) {
  writeJsonAtomic(RECENT_FILE, [dir, ...loadRecent().filter((p) => p !== dir)].slice(0, 8));
}
function loadSavedSessions() {
  return readJsonArray(SESSIONS_FILE, "sessions.json").filter((e) => e && typeof e.cwd === "string");
}
function saveSessions() {
  writeJsonAtomic(SESSIONS_FILE, [...sessions.values()]
    .map((s) => ({ cwd: s.cwd, name: s.name, sessionFile: s.sessionFile || null }))
    .slice(0, MAX_SESSIONS));
}
function expand(p) {
  if (p === "~") return homedir();
  if (p?.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p || ".");
}
// unguessable: a session id is part of what a request needs to drive pi
const makeSid = () => randomUUID();

function notify(title, msg) {
  if (!NOTIFY) return;
  const clean = (s) => String(s).replace(/[\n\r]/g, " ").slice(0, 160);
  if (process.platform === "darwin") {
    // pass text as argv, never spliced into AppleScript source — no quoting/escaping to get wrong
    execFile("osascript", [
      "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
      clean(title), clean(msg),
    ], () => {});
  } else {
    execFile("notify-send", ["-a", "pi-piper", clean(title), clean(msg)], () => {});
  }
}

// ---------------- session lifecycle ----------------

function createSession(cwd, name, sessionFile) {
  if (sessions.size >= MAX_SESSIONS) return null;
  const sess = {
    sid: makeSid(),
    cwd: cwd ? expand(cwd) : DEFAULT_CWD,
    name: name || null,
    sessionFile: sessionFile || null,
    pi: null, piAlive: false, piExitCode: null,
    pending: new Map(),
    clients: new Set(),
    createdAt: Date.now(),
  };
  sessions.set(sess.sid, sess);
  saveSessions();
  if (cwd) saveRecent(sess.cwd);
  startPi(sess);
  return sess;
}

function startPi(sess) {
  sess.piAlive = false;
  sess.piExitCode = null;
  const args = ["--mode", "rpc"];
  if (sess.sessionFile) args.push("--session", sess.sessionFile); // resume the conversation
  const pi = spawn(PI_BIN, args, {
    cwd: sess.cwd,
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  sess.pi = pi;

  pi.on("error", (e) => {
    if (sess.pi !== pi) return; // superseded by a restart
    sess.piAlive = false;
    failPending(sess, `pi failed to start: ${e.message}`); // "exit" may never follow a spawn error
    broadcast(sess, { type: "pi_spawn_error", error: e.message });
  });
  pi.on("exit", (code, sig) => {
    if (sess.pi !== pi) return; // superseded by a restart — ignore the old child's exit
    sess.piAlive = false;
    sess.piExitCode = code;
    failPending(sess, `pi exited (code ${code})`);
    broadcast(sess, { type: "pi_exited", code, signal: sig });
    if (sessions.has(sess.sid)) notify("pi-piper", `pi exited in ${sess.name || base(sess.cwd)}${code != null ? ` (code ${code})` : ""}`);
  });

  pi.stdout.setEncoding("utf8");
  let buf = "";
  pi.stdout.on("data", (chunk) => {
    if (sess.pi !== pi) return; // stale output from a superseded child
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); }
      catch { broadcast(sess, { type: "parse_error", line: line.slice(0, 500) }); continue; }

      if (rec.type === "response") {
        const p = sess.pending.get(rec.id);
        if (p) { sess.pending.delete(rec.id); p.resolve(rec); }
      } else {
        if (rec.type === "session_info_changed" && typeof rec.name === "string") {
          sess.name = rec.name || null;
          saveSessions();
        }
        if (rec.type === "agent_settled") {
          notify("pi-piper", `Turn complete — ${sess.name || base(sess.cwd)}`);
        }
        broadcast(sess, rec);
      }
    }
  });

  pi.stdin.on("error", () => {}); // swallow EPIPE — the child may die between the alive-check and a write

  sess.piAlive = true;

  // learn which session file this pi is writing (for restart continuity)
  sendCommand(sess, { type: "get_state" }, 10000)
    .then((rec) => {
      if (sess.pi === pi && rec.success && rec.data?.sessionFile) {
        sess.sessionFile = rec.data.sessionFile;
        saveSessions();
      }
    })
    .catch(() => {});
}

// documented orderly shutdown: close stdin so pi can dispose and exit, escalate if it lingers
function stopChild(pi) {
  return new Promise((resolve) => {
    if (!pi || pi.exitCode !== null || pi.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t1); clearTimeout(t2); resolve(); } };
    pi.once("exit", finish);
    try { pi.stdin.end(); } catch {}
    const t1 = setTimeout(() => { try { pi.kill("SIGTERM"); } catch {} }, 300);
    const t2 = setTimeout(() => { try { pi.kill("SIGKILL"); } catch {} finish(); }, 2000);
  });
}

async function closeSession(sess) {
  for (const res of sess.clients) { try { res.end(); } catch {} }
  sess.clients.clear();
  failPending(sess, "session closed");
  sessions.delete(sess.sid);
  saveSessions();
  await stopChild(sess.pi);
}

// Stop the old child *before* starting the new one: both would otherwise have the same
// --session file open for up to 2s. Concurrent restarts share one in-flight restart.
function restartPi(sess) {
  if (sess.restarting) return sess.restarting;
  sess.restarting = (async () => {
    const old = sess.pi;
    sess.pi = null; // supersede first, so the old child's exit is not reported as a crash
    sess.piAlive = false;
    failPending(sess, "pi restarting"); // its replies will never arrive
    await stopChild(old);
    if (sessions.has(sess.sid)) startPi(sess); // resumes the same session file when known
  })().finally(() => { sess.restarting = null; });
  return sess.restarting;
}

function failPending(sess, msg) {
  for (const [id, p] of sess.pending) { sess.pending.delete(id); p.reject(new Error(msg)); }
}

function broadcast(sess, rec) {
  const line = "data: " + JSON.stringify(rec) + "\n\n";
  for (const res of sess.clients) { try { res.write(line); } catch {} }
}

// ---------------- commands ----------------

function sendCommand(sess, cmd, timeoutMs) {
  if (!sess.piAlive || !sess.pi) return Promise.reject(new Error("pi is not running"));
  if (cmd.type === "extension_ui_response") {
    try { sess.pi.stdin.write(JSON.stringify(cmd) + "\n"); }
    catch (e) { return Promise.reject(e); }
    return Promise.resolve({ type: "response", success: true, command: "extension_ui_response" });
  }
  const id = "req-" + randomUUID();
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      if (sess.pending.delete(id)) rej(new Error(`timeout after ${timeoutMs}ms: ${cmd.type}`));
    }, timeoutMs);
    sess.pending.set(id, {
      resolve: (rec) => { clearTimeout(t); res(rec); },
      reject: (e) => { clearTimeout(t); rej(e); },
    });
    sess.pi.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

// ---------------- file preview ----------------

const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  json: "application/json",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
function mimeFor(name) {
  return MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
}

// /api/file and /api/download read only inside an open session's folder (or the temp dir),
// so a stray request can't pull ~/.ssh or ~/.pi/agent/auth.json. Symlinks are resolved
// first so a link inside a project can't point back out. PI_GUI_PEEK_ANYWHERE=1 opts out.
function realOrSelf(p) { try { return realpathSync(p); } catch { return resolve(p); } }
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
function checkReadable(abs) {
  if (PEEK_ANYWHERE) return null;
  const real = realOrSelf(abs);
  const roots = [...[...sessions.values()].map((s) => s.cwd), tmpdir()].map(realOrSelf);
  return roots.some((r) => isInside(real, r)) ? null : "outside the open sessions' folders: " + abs;
}

// Full-file transfer for downloads (Export HTML).
// Deliberately NOT fileContents(): that one is a preview with caps (< 1MB, first
// 800 lines) — using it here silently truncated exports, and a real pi export has
// <body> after the CSS preamble, so the truncated copy rendered as a blank page.
function streamFile(res, p) {
  const abs = expand(p);
  const denied = checkReadable(abs);
  if (denied) { sendJson(res, 403, { error: denied }); return; }
  let st;
  try { st = statSync(abs); } catch { sendJson(res, 400, { error: "no such file: " + p }); return; }
  if (!st.isFile()) { sendJson(res, 400, { error: "not a file: " + p }); return; }
  const name = abs.split(/[\\/]/).pop() || "download";
  res.writeHead(200, {
    "Content-Type": mimeFor(name),
    "Content-Length": st.size,
    "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"`,
    "Content-Security-Policy": "sandbox", // never let a downloaded file run as this origin
  });
  const rs = createReadStream(abs);
  rs.on("error", () => { try { res.destroy(); } catch {} }); // e.g. deleted between stat and open
  rs.pipe(res);
}

function fileContents(p) {
  const abs = expand(p);
  const denied = checkReadable(abs);
  if (denied) return { error: denied, status: 403 };
  let st;
  try { st = statSync(abs); } catch { return { error: "no such file: " + p }; }
  if (!st.isFile()) return { error: "not a file: " + p };
  const size = st.size;
  if (size > 1024 * 1024) {
    return { path: abs, size, binary: false, content: "", lines: 0, note: "file > 1MB — not previewed" };
  }
  const fd = openSync(abs, "r");
  const buf = Buffer.alloc(Math.min(size, 512 * 1024));
  const n = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  if ([...buf.slice(0, Math.min(1000, n))].some((b) => b === 0)) {
    return { path: abs, size, binary: true, content: "", lines: 0 };
  }
  const text = buf.slice(0, n).toString("utf8");
  const lines = text.split("\n");
  const truncated = lines.length > 800;
  return { path: abs, size, binary: false, content: lines.slice(0, 800).join("\n"), lines: lines.length, truncated };
}

// ---------------- http plumbing ----------------

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length; // byte-accurate (c is a Buffer)
      if (size > 50e6) { rej(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s), "Cache-Control": "no-store" });
  res.end(s);
}
async function readJson(req) {
  const body = await readBody(req);
  try { return body ? JSON.parse(body) : {}; } catch { return null; }
}

const LOOPBACK = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
// Why an API request is refused, or null if it's fine. The Host check stops DNS rebinding;
// Origin / Sec-Fetch-Site stop other websites (CSRF). Non-browser clients (curl, the
// tests) send neither header and are allowed. Requiring JSON on POST makes any
// cross-origin browser POST need a CORS preflight, which this server never grants.
function refusal(req) {
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host = "";
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (!LOOPBACK.has(host)) return [403, "cross-origin request refused"];
  } else if (origin === "null") return [403, "opaque-origin request refused"];
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return [403, "cross-site request refused"];
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] || ""))
    return [415, "POST body must be application/json"];
  return null;
}
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // single-file UI: inline script/style only, no third-party anything, no framing
  "Content-Security-Policy": [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:", "connect-src 'self'", "base-uri 'none'",
    "form-action 'none'", "frame-ancestors 'none'",
  ].join("; "),
};
function infoOf(sess) {
  return { sid: sess.sid, cwd: sess.cwd, name: sess.name, running: sess.piAlive, pid: sess.pi?.pid ?? null };
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding mitigation: only accept requests addressed to the loopback host
  const host = (req.headers.host || "").toLowerCase();
  if (!LOOPBACK.has(host)) {
    sendJson(res, 403, { error: "bad host" });
    return;
  }
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      // a top-level navigation (bookmark, link) is harmless; only /api/* is guarded below
      res.writeHead(200, PAGE_HEADERS);
      res.end(readFileSync(join(__dirname, "index.html")));
      return;
    }

    const refused = refusal(req);
    if (refused) { sendJson(res, refused[0], { error: refused[1] }); return; }

    if (req.method === "GET" && (u.pathname === "/api/info" || u.pathname === "/api/sessions")) {
      sendJson(res, 200, u.pathname === "/api/info"
        ? { sessions: [...sessions.values()].map(infoOf), maxSessions: MAX_SESSIONS, home: homedir() }
        : [...sessions.values()].map(infoOf));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/sessions") {
      const t = await readJson(req);
      if (!t) { sendJson(res, 400, { error: "invalid JSON body" }); return; }
      const sess = createSession(t.cwd || null, t.name || null);
      if (!sess) { sendJson(res, 409, { error: `session limit reached (${MAX_SESSIONS})` }); return; }
      sendJson(res, 200, infoOf(sess));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/close") {
      const t = await readJson(req);
      if (!t) { sendJson(res, 400, { error: "invalid JSON body" }); return; }
      const sess = sessions.get(t.sid);
      if (!sess) { sendJson(res, 404, { error: "no such session" }); return; }
      await closeSession(sess);
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/restart") {
      const t = await readJson(req);
      if (!t) { sendJson(res, 400, { error: "invalid JSON body" }); return; }
      const sess = t.sid ? sessions.get(t.sid) : sessions.values().next().value;
      if (!sess) { sendJson(res, 404, { error: "no session" }); return; }
      if (t.cwd) {
        sess.cwd = expand(t.cwd);
        sess.sessionFile = null; // different project → fresh conversation
        saveRecent(sess.cwd);
        for (const r of sess.clients) { try { r.write("data: " + JSON.stringify({ type: "cwd_changed", cwd: sess.cwd }) + "\n\n"); } catch {} }
      }
      saveSessions();
      await restartPi(sess);
      sendJson(res, 200, infoOf(sess));
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/events") {
      const sess = sessions.get(u.searchParams.get("sid"));
      if (!sess) { sendJson(res, 404, { error: "no such session" }); return; }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      sess.clients.add(res);
      const keep = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
      req.on("close", () => { sess.clients.delete(res); clearInterval(keep); });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/command") {
      const t = await readJson(req);
      if (!t) { sendJson(res, 400, { error: "invalid JSON body" }); return; }
      const { sid, command, timeoutMs } = t;
      if (!sid || !command || typeof command !== "object") { sendJson(res, 400, { error: "need { sid, command }" }); return; }
      const sess = sessions.get(sid);
      if (!sess) { sendJson(res, 404, { error: "no such session: " + sid }); return; }
      const timeout = Number(timeoutMs) || 60000;
      const rec = await sendCommand(sess, command, timeout).catch((e) => ({ type: "response", success: false, error: e.message }));
      sendJson(res, rec.success ? 200 : 502, rec);
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/dirs") {
      const p = expand(u.searchParams.get("path") || "~");
      const st = statSync(p);
      if (!st.isDirectory()) { sendJson(res, 400, { error: "not a directory: " + p }); return; }
      const entries = readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      const parent = dirname(p);
      sendJson(res, 200, {
        path: p,
        parent: parent !== p ? parent : null,
        home: homedir(),
        directories: entries.slice(0, 400).map((name) => ({ name })),
        recent: loadRecent(),
      });
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/file") {
      const out = fileContents(u.searchParams.get("path") || "");
      sendJson(res, out.error ? (out.status || 400) : 200, out);
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/download") {
      streamFile(res, u.searchParams.get("path") || "");
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("HANDLER ERROR", e.stack);
    if (!res.headersSent) sendJson(res, e.code === "ENOENT" ? 400 : 500, { error: e.message });
    else res.destroy();
  }
});

// Claim the port FIRST, then start pi. Restoring sessions before listen() meant a busy
// port crashed the server after the pi children were already running; they then died
// writing to a closed pipe (EPIPE), one stack trace per restored tab.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    const find = process.platform === "win32" ? `netstat -ano | findstr :${PORT}` : `lsof -nP -iTCP:${PORT} -sTCP:LISTEN`;
    console.error(`pi-piper: port ${PORT} is already in use: another pi-piper (or other app) is running.\n` +
      `  find it:  ${find}\n  or use another port:  PI_GUI_PORT=${PORT + 1} node server.mjs`);
  } else {
    console.error(`pi-piper: can't listen on 127.0.0.1:${PORT}: ${e.message}`);
  }
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  // restore previous sessions (or start one fresh)
  const saved = loadSavedSessions();
  if (saved.length) {
    for (const e of saved.slice(0, MAX_SESSIONS)) {
      // resume only if the session file still exists; otherwise fresh in the same cwd
      const sf = e.sessionFile && existsSync(e.sessionFile) ? e.sessionFile : null;
      createSession(e.cwd, e.name || null, sf);
    }
  } else {
    createSession(null, null);
  }
  console.log(`pi-piper: http://127.0.0.1:${PORT}  (initial cwd: ${DEFAULT_CWD}, ${sessions.size} session${sessions.size === 1 ? "" : "s"}, restored ${Math.min(saved.length, MAX_SESSIONS)}, state: ${STATE_DIR})`);
});
let shuttingDown = false;
async function killAll() {
  if (shuttingDown) return; // second Ctrl+C while children are still exiting
  shuttingDown = true;
  const all = [...sessions.values()];
  for (const s of all) for (const res of s.clients) { try { res.end(); } catch {} }
  server.close();
  // same orderly stop as closing a tab: stdin EOF, SIGTERM at 300ms, SIGKILL at 2s
  await Promise.all(all.map((s) => stopChild(s.pi)));
  process.exit(0);
}
process.on("SIGINT", killAll);
process.on("SIGTERM", killAll);
