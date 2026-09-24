#!/usr/bin/env node
// pi-gui server: a tiny zero-dependency bridge between a browser and a pi
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
//   GET  /                         -> the single-file UI
//
// Env:
//   PI_GUI_PORT  default 4747
//   PI_GUI_CWD   working directory for the initial session (default: $PWD)
//   PI_BIN       pi executable (default: "pi")
//   PI_GUI_NOTIFY=0 to disable macOS notifications
//
// The server binds 127.0.0.1 only — this is a local tool, not a web service.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PI_GUI_PORT || 4747);
const DEFAULT_CWD = process.env.PI_GUI_CWD || process.cwd();
const PI_BIN = process.env.PI_BIN || "pi";
const MAX_SESSIONS = 5;
const NOTIFY = process.env.PI_GUI_NOTIFY !== "0" && (process.platform === "darwin" || process.platform === "linux");

const sessions = new Map(); // sid -> session
const RECENT_FILE = join(homedir(), "pi-gui", "projects.json");
const SESSIONS_FILE = process.env.PI_GUI_STATE || join(homedir(), "pi-gui", "sessions.json");

const base = (p) => (p || "").split("/").filter(Boolean).pop() || "/";

function loadRecent() {
  try {
    const arr = JSON.parse(readFileSync(RECENT_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch { return []; }
}
function saveRecent(dir) {
  try {
    const arr = [dir, ...loadRecent().filter((p) => p !== dir)].slice(0, 8);
    writeFileSync(RECENT_FILE, JSON.stringify(arr, null, 2) + "\n");
  } catch {}
}
function loadSavedSessions() {
  try {
    const arr = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.cwd === "string") : [];
  } catch { return []; }
}
function saveSessions() {
  try {
    const arr = [...sessions.values()]
      .map((s) => ({ cwd: s.cwd, name: s.name, sessionFile: s.sessionFile || null }))
      .slice(0, MAX_SESSIONS);
    writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2) + "\n");
  } catch {}
}
function expand(p) {
  if (p === "~") return homedir();
  if (p?.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p || ".");
}
function makeSid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function notifyMac(title, msg) {
  if (!NOTIFY) return;
  const clean = (s) => String(s).replace(/["\n\r]/g, " ").slice(0, 160);
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${clean(msg)}" with title "${clean(title)}"`], () => {});
  } else {
    execFile("notify-send", ["-a", "pi-gui", clean(title), clean(msg)], () => {});
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
    broadcast(sess, { type: "pi_spawn_error", error: e.message });
  });
  pi.on("exit", (code, sig) => {
    if (sess.pi !== pi) return; // superseded by a restart — ignore the old child's exit
    sess.piAlive = false;
    sess.piExitCode = code;
    failPending(sess, `pi exited (code ${code})`);
    broadcast(sess, { type: "pi_exited", code, signal: sig });
    if (sessions.has(sess.sid)) notifyMac("pi-gui", `pi exited in ${sess.name || base(sess.cwd)}${code != null ? ` (code ${code})` : ""}`);
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
          notifyMac("pi-gui", `Turn complete — ${sess.name || base(sess.cwd)}`);
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
function stopPi(sess) {
  return new Promise((resolve) => {
    const pi = sess.pi;
    if (!pi || pi.exitCode !== null) return resolve();
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
  await stopPi(sess);
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
  const id = "req-" + Math.random().toString(36).slice(2, 10);
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

function fileContents(p) {
  const abs = expand(p);
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
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}
function infoOf(sess) {
  return { sid: sess.sid, cwd: sess.cwd, name: sess.name, running: sess.piAlive, pid: sess.pi?.pid ?? null };
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding mitigation: only accept requests addressed to the loopback host
  const host = (req.headers.host || "").toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}` && host !== `[::1]:${PORT}`) {
    sendJson(res, 403, { error: "bad host" });
    return;
  }
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(__dirname, "index.html")));
      return;
    }

    if (req.method === "GET" && (u.pathname === "/api/info" || u.pathname === "/api/sessions")) {
      sendJson(res, 200, u.pathname === "/api/info"
        ? { sessions: [...sessions.values()].map(infoOf), maxSessions: MAX_SESSIONS, home: homedir() }
        : [...sessions.values()].map(infoOf));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/sessions") {
      const body = await readBody(req);
      let t = {};
      try { t = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
      const sess = createSession(t.cwd || null, t.name || null);
      if (!sess) { sendJson(res, 409, { error: `session limit reached (${MAX_SESSIONS})` }); return; }
      sendJson(res, 200, infoOf(sess));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/close") {
      const t = JSON.parse((await readBody(req)) || "{}");
      const sess = sessions.get(t.sid);
      if (!sess) { sendJson(res, 404, { error: "no such session" }); return; }
      await closeSession(sess);
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/restart") {
      const t = JSON.parse((await readBody(req)) || "{}");
      const sess = t.sid ? sessions.get(t.sid) : sessions.values().next().value;
      if (!sess) { sendJson(res, 404, { error: "no session" }); return; }
      if (t.cwd) {
        sess.cwd = expand(t.cwd);
        sess.sessionFile = null; // different project → fresh conversation
        saveRecent(sess.cwd);
        for (const r of sess.clients) { try { r.write("data: " + JSON.stringify({ type: "cwd_changed", cwd: sess.cwd }) + "\n\n"); } catch {} }
      }
      saveSessions();
      stopPi(sess); // graceful, in the background — supersession guards handle the overlap
      startPi(sess); // resumes the same session file when known
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
      req.on("close", () => sess.clients.delete(res));
      const keep = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
      req.on("close", () => clearInterval(keep));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/command") {
      const body = await readBody(req);
      let t = {};
      try { t = JSON.parse(body || "{}"); } catch { sendJson(res, 400, { error: "invalid JSON body" }); return; }
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
      sendJson(res, out.error ? 400 : 200, out);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("HANDLER ERROR", e.stack);
    sendJson(res, 500, { error: e.message });
  }
});

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
server.listen(PORT, "127.0.0.1", () => {
  console.log(`pi-gui: http://127.0.0.1:${PORT}  (initial cwd: ${DEFAULT_CWD}, ${sessions.size} session${sessions.size === 1 ? "" : "s"}, restored ${Math.min(saved.length, MAX_SESSIONS)})`);
});
function killAll() {
  for (const s of sessions.values()) { try { s.pi?.stdin.end(); } catch {} }
  setTimeout(() => {
    for (const s of sessions.values()) { try { s.pi?.kill("SIGKILL"); } catch {} }
    process.exit(0);
  }, 400);
}
process.on("SIGINT", killAll);
process.on("SIGTERM", killAll);
