// Lists the tools a PodPitch MCP server offers (names + inputs). Read-only: it calls nothing else.
// Usage (Windows cmd):
//   set PODPITCH_KEY=your_key_here
//   node discover-podpitch.mjs https://your-podpitch-mcp-url
// The key is read from the environment and never printed.

const url = process.argv[2];
const key = process.env.PODPITCH_KEY;
if (!url || !key) {
  console.log("Usage: set PODPITCH_KEY=... then: node discover-podpitch.mjs <MCP URL>");
  process.exit(1);
}

// Try the common auth header styles until one works.
const AUTH_STYLES = [
  { Authorization: `Bearer ${key}` },
  { "x-api-key": key },
  { Authorization: key },
];

let sessionId = null;

async function rpc(auth, method, params, id) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...auth,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = id === undefined
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.slice(0, 300) };
  if (id === undefined) return { status: res.status };
  // Response may be plain JSON or Server-Sent Events ("data: {...}")
  const jsonText = text.trim().startsWith("{")
    ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() || "{}";
  return { status: res.status, json: JSON.parse(jsonText) };
}

for (const [i, auth] of AUTH_STYLES.entries()) {
  sessionId = null;
  const init = await rpc(auth, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tpx-discover", version: "1.0" },
  }, 1);
  const styleName = Object.keys(auth)[0] + (i === 2 ? " (no Bearer)" : "");
  if (init.error || init.json?.error) {
    console.log(`Auth style ${styleName}: failed (${init.status}) ${init.error || JSON.stringify(init.json.error)}`);
    continue;
  }
  console.log(`Auth style that works: ${styleName}`);
  console.log(`Server: ${JSON.stringify(init.json.result?.serverInfo || {})}`);
  console.log(`Protocol: ${init.json.result?.protocolVersion}`);
  await rpc(auth, "notifications/initialized", {});
  const list = await rpc(auth, "tools/list", {}, 2);
  if (list.error || list.json?.error) {
    console.log(`tools/list failed: ${list.error || JSON.stringify(list.json.error)}`);
    process.exit(1);
  }
  const tools = list.json.result?.tools || [];
  console.log(`\n${tools.length} tools:\n`);
  for (const t of tools) {
    console.log(`=== ${t.name}`);
    console.log(`  ${(t.description || "").replace(/\s+/g, " ").slice(0, 400)}`);
    console.log(`  input: ${JSON.stringify(t.inputSchema || {}, null, 0).slice(0, 1200)}\n`);
  }
  process.exit(0);
}
console.log("\nNo auth style worked. Check the URL and key, or ask PodPitch which header they expect.");
