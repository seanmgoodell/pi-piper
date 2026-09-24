#!/usr/bin/env node
// Minimal fake `pi --mode rpc` for pi-piper's smoke tests.
//
// Env:
//   STUB_LOG            append {"pid":..,"event":..} JSONL here when set
//   STUB_EXIT_DELAY_MS  on SIGTERM, delay exit this long (widens the restart-race window)
//
// Special RPC command used only by the test suite:
//   {"type":"__close_stdin"}  → ack, destroy our stdin, then stay alive forever.
//   Lets the test verify the server survives EPIPE on stdin writes while piAlive is true.
import { appendFileSync, closeSync } from "node:fs";

const LOG = process.env.STUB_LOG;
function log(event) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ pid: process.pid, event }) + "\n"); } catch {}
}
log("start");
log("argv " + process.argv.slice(2).join(" "));
const SESSION_FILE = process.env.STUB_SESSION_FILE || null;

if (process.env.STUB_EXIT_DELAY_MS) {
  process.on("SIGTERM", () => {
    log("sigterm");
    setTimeout(() => process.exit(0), Number(process.env.STUB_EXIT_DELAY_MS));
  });
} else {
  process.on("SIGTERM", () => { log("sigterm"); process.exit(0); });
}

let closeMode = false;
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { log(closeMode ? "stdin-end-forced" : "stdin-end"); if (!closeMode) process.exit(0); });

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    handle(cmd);
  }
});

function out(rec) { process.stdout.write(JSON.stringify(rec) + "\n"); }
function respond(cmd, success, data, error) {
  const r = { id: cmd.id, type: "response", command: cmd.type, success };
  if (data !== undefined) r.data = data;
  if (error !== undefined) r.error = error;
  out(r);
}

function emitRun(message) {
  const now = Date.now();
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "user", content: message, timestamp: now } });
  out({ type: "message_end", message: { role: "user", content: message, timestamp: now } });
  out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: now } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stub reply" } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stub reply" }], usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.0001 } }, stopReason: "stop", timestamp: now } });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
}

function handle(cmd) {
  switch (cmd.type) {
    case "prompt":
      emitRun(cmd.message);
      respond(cmd, true, {});
      break;
    case "__close_stdin":
      respond(cmd, true, {});
      log("stdin-destroyed");
      closeMode = true;
      // actually close fd 0 so the server's writes hit EPIPE (stream.destroy() keeps the fd open)
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.on("error", () => {});
      try { closeSync(0); } catch {}
      setInterval(() => {}, 60000); // stay alive: the server must survive EPIPE, not rely on our exit
      break;
    case "bash":
      out({ type: "bash_execution_update", id: cmd.id, delta: `stub:${cmd.command}\n` });
      respond(cmd, true, { output: `stub:${cmd.command}\n`, exitCode: 0, cancelled: false, truncated: false });
      break;
    case "get_state":
      respond(cmd, true, { model: { id: "stub-model", name: "Stub Model", provider: "stub", input: ["text"] }, thinkingLevel: "low", sessionFile: SESSION_FILE, isStreaming: false });
      break;
    case "get_available_models":
      respond(cmd, true, { models: [{ id: "stub-model", name: "Stub Model", provider: "stub", input: ["text"] }] });
      break;
    case "get_messages":
      respond(cmd, true, { messages: [] });
      break;
    case "get_session_stats":
      respond(cmd, true, { contextUsage: { tokens: 1000, contextWindow: 128000, percent: 1 }, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0.001 }, totalMessages: 2, toolCalls: 0 });
      break;
    case "get_commands":
      respond(cmd, true, { commands: [{ name: "help", description: "stub command", source: "pi" }] });
      break;
    case "set_model":
      // same contract as the real pi: the key is modelId, and model objects use `provider`
      if (cmd.modelId != null) respond(cmd, true, { model: { id: cmd.modelId, name: cmd.modelId, provider: cmd.provider, input: ["text"] } });
      else respond(cmd, false, undefined, "Model not found: " + cmd.provider + "/undefined");
      break;
    default:
      respond(cmd, true, {});
  }
}