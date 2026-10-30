// Saves the FULL list of PodPitch MCP tools (names, descriptions, inputs) to podpitch-tools.json.
// Read-only: it only calls "initialize" and "tools/list". It never runs a tool.
//
// Usage (PowerShell):
//   $env:PODPITCH_KEY = "your_new_key"
//   node discover-podpitch-full.mjs
//   Remove-Item Env:PODPITCH_KEY
// Then attach podpitch-tools.json in the chat. The key is never written to the file.

import { writeFileSync } from "node:fs";

const url = process.argv[2] || "https://api.podpitch.com/v1/mcp";
const key = process.env.PODPITCH_KEY;
if (!key) {
  console.log('Set the key first:  $env:PODPITCH_KEY = "your_key"');
  process.exit(1);
}

let sessionId = null;
async function rpc(method, params, id) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${key}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  if (id === undefined) return null;
  const jsonText = text.trim().startsWith("{")
    ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() || "{}";
  const json = JSON.parse(jsonText);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "tpx-discover", version: "2.0" },
}, 1);
await rpc("notifications/initialized", {});

const tools = [];
let cursor;
let id = 2;
do {
  const page = await rpc("tools/list", cursor ? { cursor } : {}, id++);
  tools.push(...(page?.tools || []));
  cursor = page?.nextCursor;
} while (cursor);

writeFileSync("podpitch-tools.json", JSON.stringify({ server: init?.serverInfo, count: tools.length, tools }, null, 2));
console.log(`Saved ${tools.length} tools to podpitch-tools.json\n`);
for (const t of tools) {
  const ro = t.annotations?.readOnlyHint ? " [read-only]" : t.annotations?.destructiveHint ? " [DESTRUCTIVE]" : "";
  console.log(`${t.name}${ro}`);
}
