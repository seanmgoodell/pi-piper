#!/usr/bin/env node
// pi-piper smoke tests — zero-dependency, runs against server.mjs with a stub `pi` (test/stub-pi.mjs).
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
    Object.assign(headers, opts.headers || {}); // e.g. browser-style Origin / Sec-Fetch-Site
    const u = new URL(path, BASE);
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method, path: u.pathname + u.search, headers },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve_({ status: res.statusCode, json, text: b, headers: res.headers }); });
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
  tmp = mkdtempSync(join(tmpdir(), "pi-piper-smoke-"));
  const stubLog = join(tmp, "stub.log");

  const stubSessionFile = join(tmp, "stub-session.jsonl"); // must exist for boot-restore resume
  writeFileSync(stubSessionFile, "{\"type\":\"session\",\"version\":3}\n");
  const serverEnv = () => ({
    ...process.env,
    PI_GUI_PORT: String(PORT),
    PI_GUI_CWD: tmp,
    PI_BIN: join(ROOT, "test", "stub-pi.sh"),
    PI_GUI_NOTIFY: "0",
    PI_GUI_STATE_DIR: tmp, // sessions.json + projects.json — never the user's real state
    STUB_LOG: stubLog,
    STUB_SESSION_FILE: stubSessionFile,
    STUB_EXIT_DELAY_MS: "400", // widen the restart-race window deterministically
  });

  server = spawn("node", [join(ROOT, "server.mjs")], {
    env: serverEnv(),
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

  // ---- second instance on a busy port: clear error, exit 1, no pi spawned ----
  const startsBefore = stubLogEntries(stubLog).filter((e) => e.event === "start").length;
  const dup = spawnSync("node", [join(ROOT, "server.mjs")], { env: serverEnv(), encoding: "utf8", timeout: 10000 });
  await sleep(300); // a stray child would have logged "start" by now
  const startsAfter = stubLogEntries(stubLog).filter((e) => e.event === "start").length;
  check("port in use: second server exits 1 with a clear message", dup.status === 1 && /pi-piper: port \d+ is already in use/.test(dup.stderr), `status=${dup.status} stderr=${(dup.stderr || "").slice(0, 200)}`);
  check("port in use: no pi child spawned (no orphan EPIPE crashes)", startsAfter === startsBefore, `${startsBefore} → ${startsAfter}`);

  // ---- UI missing (folder moved while running): readable 500, not an empty response ----
  {
    const dir = join(tmp, "moved");
    mkdirSync(dir);
    writeFileSync(join(dir, "server.mjs"), readFileSync(join(ROOT, "server.mjs"))); // no index.html beside it
    const port2 = PORT + 1;
    const s2 = spawn("node", [join(dir, "server.mjs")], { env: { ...serverEnv(), PI_GUI_PORT: String(port2), PI_GUI_STATE_DIR: join(tmp, "state2") }, stdio: "ignore" });
    const get2 = () => new Promise((res_) => {
      const r = http.get({ host: "127.0.0.1", port: port2, path: "/" }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => res_({ status: res.statusCode, text: b })); });
      r.on("error", (e) => res_({ status: 0, err: e.code }));
    });
    let r2 = { status: 0 };
    for (let i = 0; i < 40 && r2.status === 0 && r2.err !== "ECONNRESET"; i++) { await sleep(150); r2 = await get2(); }
    check("page: missing index.html → 500 with an explanation (not an empty response)", r2.status === 500 && /can't read its UI/.test(r2.text || ""), JSON.stringify(r2).slice(0, 200));
    s2.kill("SIGKILL");
  }

  // ---- CSRF: other websites must not be able to drive pi through the browser ----
  const xOrigin = await req("POST", "/api/sessions", { body: {}, headers: { Origin: "https://evil.example.com" } });
  check("csrf: cross-origin POST refused (403)", xOrigin.status === 403, `got ${xOrigin.status}`);
  const xSite = await req("GET", "/api/sessions", { headers: { "Sec-Fetch-Site": "cross-site" } });
  check("csrf: Sec-Fetch-Site cross-site refused (403)", xSite.status === 403, `got ${xSite.status}`);
  const plain = await req("POST", "/api/sessions", { headers: { "Content-Type": "text/plain" } });
  check("csrf: non-JSON POST refused (415) — no preflight-free form/text POSTs", plain.status === 415, `got ${plain.status}`);
  const sameOrigin = await req("GET", "/api/info", { headers: { Origin: `http://127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" } });
  check("csrf: same-origin browser request allowed", sameOrigin.status === 200, `got ${sameOrigin.status}`);
  const page = await req("GET", "/", { headers: { "Sec-Fetch-Site": "cross-site" } });
  check("page: UI served on navigation, with CSP + nosniff", page.status === 200 && /default-src 'none'/.test(page.headers?.["content-security-policy"] || "") && page.headers?.["x-content-type-options"] === "nosniff", JSON.stringify(page.headers));

  const s0 = okHost.json.sessions[0];
  childPids.add(s0.pid);
  check("initial session spawned with stub pi running", s0.running === true);
  check("session ids are UUIDs (unguessable)", /^[0-9a-f-]{36}$/.test(s0.sid), s0.sid);

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
  const entriesR = stubLogEntries(stubLog);
  check("restart: resumed with --session <file> (continuity)", entriesR.some((e) => e.pid === rr.json?.pid && e.event === `argv --mode rpc --session ${stubSessionFile}`), JSON.stringify(entriesR.filter((e) => e.pid === rr.json?.pid).map((e) => e.event)));
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
  const outside = await req("GET", `/api/file?path=${encodeURIComponent(join(ROOT, "README.md"))}`);
  check("file: path outside the sessions' folders refused (403)", outside.status === 403, `got ${outside.status}`);
  const dlOutside = await req("GET", `/api/download?path=${encodeURIComponent(join(ROOT, "README.md"))}`);
  check("download: path outside the sessions' folders refused (403)", dlOutside.status === 403, `got ${dlOutside.status}`);
  const nf = await req("GET", `/api/file?path=${encodeURIComponent(join(tmp, "nope.txt"))}`);
  check("file: missing file → 400", nf.status === 400, `got ${nf.status}`);

  // ---- /api/download: full-file transfer used by Export HTML ----
  // Regression: the export used to be fetched through /api/file, whose 800-line preview
  // cap cut a real 440 KB export down to 17 KB — and since pi's export puts <body>
  // after the ~1100-line CSS preamble, the downloaded copy rendered as a blank page.
  const bigHtml = "<!DOCTYPE html>\n<html><head><style>\n" + "  .x {}\n".repeat(1200) + "</style></head>\n<body><p>the transcript</p></body></html>\n";
  const bigPath = join(tmp, "pi-session-big.html");
  writeFileSync(bigPath, bigHtml);
  const dl = await req("GET", `/api/download?path=${encodeURIComponent(bigPath)}`);
  check("download: full file, no 800-line preview truncation", dl.text.length === bigHtml.length && dl.text.includes("<body>"), `sent=${dl.text.length} of ${bigHtml.length}`);
  check("download: html content-type + attachment disposition", /text\/html/.test(dl.headers?.["content-type"] || "") && /attachment/.test(dl.headers?.["content-disposition"] || ""), JSON.stringify(dl.headers));
  const huge = "A".repeat(1024 * 1024 + 4096); // > 1MB: /api/file returns empty content here
  writeFileSync(join(tmp, "huge.html"), huge);
  const dlHuge = await req("GET", `/api/download?path=${encodeURIComponent(join(tmp, "huge.html"))}`);
  check("download: > 1MB streams fully (peek cap does not apply)", dlHuge.text.length === huge.length, `sent=${dlHuge.text.length} of ${huge.length}`);
  const dlMissing = await req("GET", `/api/download?path=${encodeURIComponent(join(tmp, "nope.html"))}`);
  check("download: missing file → 400 JSON", dlMissing.status === 400 && !!dlMissing.json?.error, `status=${dlMissing.status}`);
  const dlDir = await req("GET", `/api/download?path=${encodeURIComponent(tmp)}`);
  check("download: directory → 400 JSON", dlDir.status === 400 && !!dlDir.json?.error, `status=${dlDir.status}`);
  const preview = await req("GET", `/api/file?path=${encodeURIComponent(bigPath)}`);
  check("file: peek preview still capped at 800 lines", preview.json?.truncated === true && preview.json.content.length < bigHtml.length, JSON.stringify(preview.json?.truncated));

  // ---- session limit ----
  let saw409 = false;
  let lastCreatedSid = null;
  for (let i = 0; i < 8; i++) {
    const r = await req("POST", "/api/sessions", { body: { cwd: tmp } });
    if (r.status === 200) { if (r.json?.pid) childPids.add(r.json.pid); lastCreatedSid = r.json?.sid ?? lastCreatedSid; } else if (r.status === 409) { saw409 = true; break; }
  }
  check("session limit enforced (409 at cap)", saw409);
  const recent = existsSync(join(tmp, "projects.json")) ? JSON.parse(readFileSync(join(tmp, "projects.json"), "utf8")) : null;
  check("state: recent projects written to PI_GUI_STATE_DIR", Array.isArray(recent) && recent.includes(tmp), JSON.stringify(recent));
  if (lastCreatedSid) await req("POST", "/api/close", { body: { sid: lastCreatedSid } }); // free a slot for the epipe scenario
  console.log("(stub log so far:", existsSync(stubLog) ? JSON.stringify(stubLogEntries(stubLog)) : "FILE MISSING at " + stubLog, ")");

  // ---- index.html inline script parses (server-independent) ----
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  const ui = join(tmp, "ui-check.mjs");
  writeFileSync(ui, m ? m[1] : "");
  const syntax = spawnSync("node", ["--check", ui], { encoding: "utf8" });
  check("index.html: inline <script> passes node --check", !!m && syntax.status === 0, (syntax.stderr || "").slice(0, 300));

  // ---- boot restore: kill the server, restart it, sessions come back ----
  const beforeBoot = (await req("GET", "/api/sessions")).json ?? [];
  server.kill("SIGKILL");
  await sleepUntil(() => server.exitCode !== null, 5000);
  server = spawn("node", [join(ROOT, "server.mjs")], { env: serverEnv(), stdio: ["ignore", "pipe", "pipe"] });
  serverErr = "";
  server.stderr.on("data", (c) => (serverErr += c));
  let restored = false;
  for (let i = 0; i < 75; i++) { const r = await req("GET", "/api/info"); if (r.status === 200) { restored = true; break; } await sleep(200); }
  const restoredList = restored ? ((await req("GET", "/api/sessions")).json ?? []) : [];
  check("boot: server restarts and restores sessions", restored && restoredList.length >= Math.min(beforeBoot.length, 5), `before=${beforeBoot.length} after=${restoredList.length}`);
  const entriesB = stubLogEntries(stubLog);
  check("boot: restored sessions resume with --session <file>", restoredList.some((s) => entriesB.some((e) => e.pid === s.pid && e.event === `argv --mode rpc --session ${stubSessionFile}`)), JSON.stringify(restoredList.map((s) => s.pid)));

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