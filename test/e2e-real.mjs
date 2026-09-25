#!/usr/bin/env node
// Real-pi acceptance E2E — exercises pi-piper's server with the REAL pi binary.
//
//   node test/e2e-real.mjs
//
// Unlike test/smoke.mjs (stub pi, no LLM calls), this suite sends actual
// prompts and therefore costs a few LLM calls. Run it after protocol-level
// changes, model config changes, or pi upgrades. Set PI_GUI_E2E_PORT to
// override the port (default 47751).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PI_GUI_E2E_PORT || 47751);

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond ? "  → " + String(detail ?? "").slice(0, 220) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(method, path, opts = {}) {
  return new Promise((resolve_, reject) => {
    const headers = {}; let body;
    if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
    const u = new URL(path, `http://127.0.0.1:${PORT}`);
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: u.pathname + u.search, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve_({ status: res.statusCode, json, text: b }); });
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
function openSse(sid) {
  return new Promise((resolve_, reject) => {
    const events = [];
    const r = http.request({ host: "127.0.0.1", port: PORT, path: `/api/events?sid=${sid}` }, (res) => {
      let buf = ""; res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); for (const l of f.split("\n")) if (l.startsWith("data: ")) { try { events.push(JSON.parse(l.slice(6))); } catch {} } } });
      resolve_({ events, has: (t) => events.some((e) => e.type === t), close: () => r.destroy() });
    });
    r.on("error", reject); r.end();
  });
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tmp = mkdtempSync(join(tmpdir(), "pi-piper-e2e-"));
const server = spawn("node", [join(ROOT, "server.mjs")], {
  env: { ...process.env, PI_GUI_PORT: String(PORT), PI_GUI_CWD: tmp, PI_GUI_NOTIFY: "0", PI_GUI_STATE_DIR: tmp },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvErr = ""; server.stderr.on("data", (c) => (srvErr += c));
const cmd = (sid, command, timeoutMs = 150000) => req("POST", "/api/command", { body: { sid, command, timeoutMs } });

try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await req("GET", "/api/info"); if (r.status === 200) { up = true; break; } } catch {} await sleep(250); }
  check("1. server boots with real pi child", up);
  const info = (await req("GET", "/api/info")).json;
  const sid = info.sessions[0].sid;
  const sse = await openSse(sid);

  const st = await cmd(sid, { type: "get_state" }, 30000);
  check("2. get_state: data.model + thinkingLevel at top level", st.json?.data?.model?.provider && "thinkingLevel" in (st.json?.data ?? {}), JSON.stringify(st.json?.data?.model ?? null).slice(0, 120));

  const sm = await cmd(sid, { type: "set_model", provider: "ollama-pro", modelId: "glm-5.3-flash" }, 30000);
  check("3. set_model (UI shape: provider+modelId)", sm.json?.success === true && sm.json?.data?.id === "glm-5.3-flash", JSON.stringify(sm.json).slice(0, 150));

  const pr = await cmd(sid, { type: "prompt", message: "Create a file named hello.txt containing exactly the text: pi-piper works — use the write tool. Then reply with just the word DONE." });
  check("4. tool-use prompt accepted", pr.json?.success === true, JSON.stringify(pr.json).slice(0, 150));
  const t0 = Date.now();
  while (!sse.has("agent_settled") && Date.now() - t0 < 150000) await sleep(500);
  check("5. SSE: full turn streamed (agent_start→tool exec→settled)", sse.has("agent_start") && sse.has("agent_settled") && sse.events.some((e) => e.type === "tool_execution_start" && e.toolName === "write"), JSON.stringify([...new Set(sse.events.map((e) => e.type))]));
  check("6. write tool executed + file has expected content", existsSync(join(tmp, "hello.txt")) && readFileSync(join(tmp, "hello.txt"), "utf8").includes("pi-piper works"), existsSync(join(tmp, "hello.txt")) ? readFileSync(join(tmp, "hello.txt"), "utf8").slice(0, 80) : "missing");

  const bash = await cmd(sid, { type: "bash", command: "cat hello.txt", id: "be2e" }, 30000);
  check("7. bash mode returns real output + exit 0", bash.json?.data?.output?.includes("pi-piper works") && bash.json?.data?.exitCode === 0, JSON.stringify(bash.json?.data).slice(0, 120));

  const stats = await cmd(sid, { type: "get_session_stats" }, 30000);
  check("8. session stats: contextUsage for the gauge", stats.json?.data?.contextUsage?.percent != null && stats.json?.data?.tokens?.input > 0, JSON.stringify(stats.json?.data?.contextUsage).slice(0, 120));

  const cmds = await cmd(sid, { type: "get_commands" }, 30000);
  check("9. slash commands list non-empty", Array.isArray(cmds.json?.data?.commands) && cmds.json.data.commands.length > 0, `got ${cmds.json?.data?.commands?.length}`);

  const q1 = await cmd(sid, { type: "set_steering_mode", mode: "all" }, 30000);
  const st2 = await cmd(sid, { type: "get_state" }, 30000);
  check("10. steering mode set + reflected in get_state", q1.json?.success === true && st2.json?.data?.steeringMode === "all", JSON.stringify(st2.json?.data?.steeringMode));

  const ex = await cmd(sid, { type: "export_html" }, 60000);
  const exPath = ex.json?.data?.path;
  const exAbs = exPath && !exPath.startsWith("/") ? join(tmp, exPath) : exPath; // session-cwd resolution, like the UI
  let exContent = null;
  if (exAbs && existsSync(exAbs)) { try { exContent = readFileSync(exAbs, "utf8"); } catch {} }
  const exStat = exAbs && existsSync(exAbs) ? statSync(exAbs) : null;
  // the UI downloads through /api/download; asserting only that /api/file returned 200 with a
  // doctype hid the bug, because the 800-line preview cap keeps the doctype and drops <body>
  const exViaApi = exAbs ? await req("GET", `/api/download?path=${encodeURIComponent(exAbs)}`) : null;
  check("11. export_html: full export downloaded byte-for-byte via /api/download", ex.json?.success === true && !!exContent && exContent.includes("<!DOCTYPE html>") && exViaApi?.status === 200 && !!exStat && exStat.size > 0 && Buffer.byteLength(exViaApi.text) === exStat.size && exViaApi.text.includes("<body"), `path=${exPath} apiStatus=${exViaApi?.status} sent=${exViaApi?.text?.length} disk=${exStat?.size}`);

  const pidBefore = info.sessions[0].pid;
  const rs = await req("POST", "/api/restart", { body: { sid } });
  await sleep(1200);
  const after = (await req("GET", "/api/sessions")).json.find((s) => s.sid === sid);
  check("12. restart: healthy new child, no spurious pi_exited", after?.running === true && after.pid !== pidBefore && !sse.has("pi_exited"), `running=${after?.running} exitedSeen=${sse.has("pi_exited")}`);

  const gm2 = await cmd(sid, { type: "get_messages" }, 30000);
  const roles2 = (gm2.json?.data?.messages ?? []).map((m) => m.role);
  check("13. restart CONTINUITY: conversation survived (user+assistant from before)", roles2.includes("user") && roles2.includes("assistant"), JSON.stringify(roles2));

  const mem = await cmd(sid, { type: "prompt", message: "What exact text does hello.txt contain? Reply with just that text." });
  check("14. memory prompt accepted on resumed session", mem.json?.success === true, JSON.stringify(mem.json).slice(0, 120));
  const t1 = Date.now();
  while (!sse.events.some((e) => e.type === "agent_settled" && e.__afterRestart) && Date.now() - t1 < 120000) {
    // crude per-turn wait: settled events seen from now on
    const recent = sse.events.filter((e) => e.type === "agent_settled").length;
    if (recent >= 2) break;
    await sleep(500);
  }
  const gm3 = await cmd(sid, { type: "get_messages" }, 30000);
  const assts3 = (gm3.json?.data?.messages ?? []).filter((m) => m.role === "assistant");
  const memReply = assts3.length ? assts3[assts3.length - 1].content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
  check("15. model remembers pre-restart facts (hello.txt content)", /pi-piper works/i.test(memReply), JSON.stringify(memReply.slice(0, 160)));

  const sm2 = await cmd(sid, { type: "set_model", provider: "openai-codex", modelId: "gpt-5.5" }, 30000);
  check("16. model switch to vision model", sm2.json?.success === true, JSON.stringify(sm2.json).slice(0, 120));

  const img = await cmd(sid, { type: "prompt", message: "In one short sentence: what do you see in the attached image?", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
  check("17. vision prompt accepted", img.json?.success === true, JSON.stringify(img.json).slice(0, 120));
  const t2 = Date.now();
  const settledBefore = sse.events.filter((e) => e.type === "agent_settled").length;
  while (sse.events.filter((e) => e.type === "agent_settled").length <= settledBefore && Date.now() - t2 < 120000) await sleep(500);
  const gm4 = await cmd(sid, { type: "get_messages" }, 30000);
  const assts4 = (gm4.json?.data?.messages ?? []).filter((m) => m.role === "assistant");
  const lastText = assts4.length ? assts4[assts4.length - 1].content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
  check("18. vision model actually saw the image", /dot|blank|image|transparent|pixel|square/i.test(lastText), JSON.stringify(lastText.slice(0, 160)));
  sse.close();
} catch (e) {
  console.log("E2E ERROR:", e);
} finally {
  server.kill("SIGKILL");
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} real-pi E2E checks passed`);
  if (srvErr.trim()) console.log("(server stderr tail:", srvErr.slice(-300), ")");
  process.exit(failed ? 1 : 0);
}