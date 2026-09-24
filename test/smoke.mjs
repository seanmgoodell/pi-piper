#!/usr/bin/env node
// pi-gui smoke tests — zero-dependency, runs against server.mjs with a stub `pi` (test/stub-pi.mjs).
//
//   node test/smoke.mjs
//
// Scenario order is deliberate: the EPIPE survival test kills a stub's stdin and
// (pre-fix) can crash the whole server, so it runs LAST.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47711;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond ? `  → ${String(detail ?? "")}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(50); }
  return fn();
}

function req(method, path, opts = {}) {
  return new Promise((resolve_) => {
    const headers = {};
    let body;
    if (opts.host) headers.Host = opts.host;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const u = new URL(path, BASE);
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method, path: u.pathname + u.search, headers },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve_({ status: res.statusCode, json, text: b }); });
      },
    );
    r.on("error", (e) => resolve_({ status: 0, json: null, err: String(e) }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function openSse(sid) {
  return new Promise((resolve_, reject) => {
    const events = [];
    const r = http.request({ host: "127.0.0.1", port: PORT, path: `/api/events?sid=${sid}` }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
          }
        }
      });
      resolve_({ events, has: (t) => events.some((e) => e.type === t), close: () => r.destroy() });
    });
    r.on("error", reject);
    r.end();
  });
}

function stubLogEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

let server = null;
let tmp = null;
const childPids = new Set();
const alive = () => server && server.exitCode === null;

async function main() {
  tmp = mkdtempSync(join(tmpdir(), "pi-gui-smoke-"));
  const stubLog = join(tmp, "stub.log");

  server = spawn("node", [join(ROOT, "server.mjs")], {
    env: {
      ...process.env,
      PI_GUI_PORT: String(PORT),
      PI_GUI_CWD: tmp,
      PI_BIN: join(ROOT, "test", "stub-pi.sh"),
      PI_GUI_NOTIFY: "0",
      STUB_LOG: stubLog,
      STUB_EXIT_DELAY_MS: "400", // widen the restart-race window deterministically
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (c) => (serverErr += c));
  server.on("exit", (code) => { if (code && code !== 0) console.log(`(server exited early, code ${code})\n${serverErr.slice(0, 1500)}`); });

  // ---- startup ----
  let up = false;
  for (let i = 0; i < 75; i++) {
    const r = await req("GET", "/api/info");
    if (r.status === 200) { up = true; break; }
    await sleep(200);
  }
  check("server starts and listens on 127.0.0.1", up);
  if (!up) return;

  // ---- host header validation (DNS-rebinding mitigation) ----
  const badHost = await req("GET", "/api/info", { host: "evil.example.com" });
  check("host: rejects non-loopback Host with 403", badHost.status === 403, `got ${badHost.status}`);
  const okHost = await req("GET", "/api/info");
  check("host: accepts 127.0.0.1 Host", okHost.status === 200 && okHost.json?.sessions?.length >= 1, `got ${okHost.status}`);
  const lhHost = await req("GET", "/api/info", { host: `localhost:${PORT}` });
  check("host: accepts localhost Host", lhHost.status === 200, `got ${lhHost.status}`);

  const s0 = okHost.json.sessions[0];
  childPids.add(s0.pid);
  check("initial session spawned with stub pi running", s0.running === true);

  // ---- SSE + command flow ----
  const sse0 = await openSse(s0.sid);
  const pr = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "prompt", message: "hello" }, timeoutMs: 10000 } });
  check("prompt command succeeds", pr.status === 200 && pr.json?.success === true, JSON.stringify(pr.json));
  await sleepUntil(() => sse0.has("agent_settled"), 5000);
  check("SSE: full run observed (agent_start → agent_settled)", sse0.has("agent_start") && sse0.has("message_end") && sse0.has("agent_settled"), JSON.stringify(sse0.events.map((e) => e.type)));
  const br = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "bash", command: "echo hi", id: "b1" }, timeoutMs: 10000 } });
  check("bash command returns stub output + exit code", br.json?.data?.output === "stub:echo hi\n" && br.json?.data?.exitCode === 0, JSON.stringify(br.json));
  const gm = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "get_messages" }, timeoutMs: 5000 } });
  check("get_messages succeeds", gm.json?.success === true, JSON.stringify(gm.json));
  const sm = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "set_model", provider: "stub", modelId: "stub-model" }, timeoutMs: 5000 } });
  check("set_model with modelId accepted", sm.json?.success === true, JSON.stringify(sm.json));
  const smBad = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "set_model", provider: "stub", model: "stub-model" }, timeoutMs: 5000 } });
  check("set_model with wrong key (model) rejected by stub", smBad.json?.success === false, JSON.stringify(smBad.json));

  // ---- restart race: old child must not clobber the new one ----
  const pidBefore = s0.pid;
  const rr = await req("POST", "/api/restart", { body: { sid: s0.sid } });
  if (rr.json?.pid) childPids.add(rr.json.pid);
  await sleep(1400); // let the old stub's delayed exit fire well after the new child registered
  const after = (await req("GET", "/api/sessions")).json?.find((s) => s.sid === s0.sid);
  check("restart: session still running (superseded child ignored)", after?.running === true, `running=${after?.running}`);
  check("restart: child pid changed", after?.pid && after.pid !== pidBefore, `${pidBefore} → ${after?.pid}`);
  check("restart: no spurious pi_exited broadcast", !sse0.has("pi_exited"), JSON.stringify(sse0.events.map((e) => e.type)));
  const pr2 = await req("POST", "/api/command", { body: { sid: s0.sid, command: { type: "get_state" }, timeoutMs: 5000 } });
  check("restart: commands still work afterwards", pr2.status === 200 && pr2.json?.success === true, JSON.stringify(pr2.json));
  sse0.close();

  // ---- graceful close (documented orderly shutdown via stdin) ----
  const cs3 = await req("POST", "/api/sessions", { body: { cwd: tmp } });
  if (cs3.json?.pid) childPids.add(cs3.json.pid);
  await sleep(400); // let the stub finish booting so its activity log is meaningful
  const cl3 = cs3.json?.sid ? await req("POST", "/api/close", { body: { sid: cs3.json.sid } }) : null;
  await sleep(500);
  let gone = false;
  try { process.kill(cs3.json?.pid, 0); } catch { gone = true; }
  check("close: session removed and child process exited", cl3?.json?.success === true && gone, `success=${cl3?.json?.success} exited=${gone}`);
  const entries = stubLogEntries(stubLog);
  check("close: child saw orderly stdin shutdown (stdin-end logged)", entries.some((e) => e.pid === cs3.json?.pid && e.event === "stdin-end"), `entries for pid ${cs3.json?.pid}: ` + JSON.stringify(entries.filter((e) => e.pid === cs3.json?.pid)));

  // ---- dirs + file endpoints ----
  mkdirSync(join(tmp, "subdir1"));
  mkdirSync(join(tmp, ".hiddendir"));
  writeFileSync(join(tmp, "note.md"), "# hello\n");
  const dirs = await req("GET", `/api/dirs?path=${encodeURIComponent(tmp)}`);
  check("dirs: lists directories, hides dotdirs", dirs.json?.directories?.some((d) => d.name === "subdir1") && !dirs.json.directories.some((d) => d.name === ".hiddendir"), JSON.stringify(dirs.json?.directories));
  const file = await req("GET", `/api/file?path=${encodeURIComponent(join(tmp, "note.md"))}`);
  check("file: text preview returns content", file.json?.content === "# hello\n", JSON.stringify(file.json));
  writeFileSync(join(tmp, "bin.dat"), Buffer.from([0x00, 0x01, 0x42]));
  const bin = await req("GET", `/api/file?path=${encodeURIComponent(join(tmp, "bin.dat"))}`);
  check("file: binary detection", bin.json?.binary === true, JSON.stringify(bin.json));
  const nf = await req("GET", `/api/file?path=${encodeURIComponent(join(tmp, "nope.txt"))}`);
  check("file: missing file → 400", nf.status === 400, `got ${nf.status}`);

  // ---- session limit ----
  let saw409 = false;
  let lastCreatedSid = null;
  for (let i = 0; i < 8; i++) {
    const r = await req("POST", "/api/sessions", { body: { cwd: tmp } });
    if (r.status === 200) { if (r.json?.pid) childPids.add(r.json.pid); lastCreatedSid = r.json?.sid ?? lastCreatedSid; } else if (r.status === 409) { saw409 = true; break; }
  }
  check("session limit enforced (409 at cap)", saw409);
  if (lastCreatedSid) await req("POST", "/api/close", { body: { sid: lastCreatedSid } }); // free a slot for the epipe scenario
  console.log("(stub log so far:", existsSync(stubLog) ? JSON.stringify(stubLogEntries(stubLog)) : "FILE MISSING at " + stubLog, ")");

  // ---- index.html inline script parses (server-independent) ----
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const ui = join(tmp, "ui-check.mjs");
  writeFileSync(ui, m ? m[1] : "");
  const syntax = spawnSync("node", ["--check", ui], { encoding: "utf8" });
  check("index.html: inline <script> passes node --check", !!m && syntax.status === 0, (syntax.stderr || "").slice(0, 300));

  // ---- EPIPE survival (destructive: runs last) ----
  const cs = await req("POST", "/api/sessions", { body: { cwd: tmp } });
  const s2 = cs.json;
  if (s2?.pid) childPids.add(s2.pid);
  const sse2 = s2?.sid ? await openSse(s2.sid) : null;
  const killCmd = s2?.sid ? await req("POST", "/api/command", { body: { sid: s2.sid, command: { type: "__close_stdin" }, timeoutMs: 5000 } }) : null;
  check("epipe: close-stdin handshake acked", killCmd?.json?.success === true, JSON.stringify(killCmd?.json));
  await sleep(200);
  let gs = null;
  if (s2?.sid) { try { gs = await req("POST", "/api/command", { body: { sid: s2.sid, command: { type: "get_state" }, timeoutMs: 1200 } }); } catch (e) { gs = { status: 0, err: String(e) }; } }
  check("epipe: write to broken pipe does not crash server", gs && gs.status > 0, `status=${gs?.status} err=${gs?.err ?? ""}`);
  const aliveAfter = await req("GET", "/api/info");
  check("epipe: server still serving requests afterwards", aliveAfter.status === 200, `status=${aliveAfter.status}`);
  if (sse2) sse2.close();
}

main()
  .catch((e) => { console.log("SUITE ERROR:", e); })
  .finally(async () => {
    for (const pid of childPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (server) { try { server.kill("SIGKILL"); } catch {} }
    await sleep(200);
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });