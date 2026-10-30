// One-time PodPitch login for the worker (OAuth with PKCE, READ-ONLY scope "podpitch:read").
// The person who owns the client campaigns runs this once on their own computer and signs in.
// It saves podpitch-oauth.json (keep it private) and checks the login works.
// The worker can only READ with this login: the "podpitch:write" scope is never requested.
//
// Usage (PowerShell, in the tpx-handoff folder):
//   node podpitch-login.mjs
// A browser opens -> sign in to PodPitch -> approve -> come back to the terminal.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";

const MCP_URL = "https://api.podpitch.com/v1/mcp";
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "podpitch:read";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// 1. Find PodPitch's login server (standard MCP OAuth discovery).
const base = new URL(MCP_URL).origin;
let resourceMeta = await getJson(`${base}/.well-known/oauth-protected-resource/v1/mcp`)
  || await getJson(`${base}/.well-known/oauth-protected-resource`);
if (!resourceMeta) {
  // Ask the MCP endpoint itself: a 401 carries a WWW-Authenticate header pointing at the metadata.
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_connected_account", arguments: {} } }),
  });
  const m = (r.headers.get("www-authenticate") || "").match(/resource_metadata="([^"]+)"/);
  if (m) resourceMeta = await getJson(m[1]);
}
const authServer = resourceMeta?.authorization_servers?.[0] || base;
const as = await getJson(`${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)
  || await getJson(`${authServer.replace(/\/$/, "")}/.well-known/openid-configuration`);
if (!as?.authorization_endpoint || !as?.token_endpoint) {
  console.log("Could not find PodPitch's login server. Send this to Claude:");
  console.log(JSON.stringify({ resourceMeta, authServer, as }, null, 2));
  process.exit(1);
}
console.log(`Login server: ${new URL(as.authorization_endpoint).origin}`);

// 2. Register this app with PodPitch (dynamic client registration), if supported.
let clientId = process.env.PODPITCH_CLIENT_ID || "";
let clientSecret = "";
if (!clientId && as.registration_endpoint) {
  const r = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "TPX Slack PodPitch Updates (read-only)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const reg = await r.json().catch(() => ({}));
  if (!r.ok || !reg.client_id) {
    console.log(`App registration failed (${r.status}): ${JSON.stringify(reg).slice(0, 300)}`);
    process.exit(1);
  }
  clientId = reg.client_id;
  clientSecret = reg.client_secret || "";
}
if (!clientId) {
  console.log("PodPitch does not allow automatic app registration. Ask PodPitch support for an OAuth client ID,");
  console.log("then run:  $env:PODPITCH_CLIENT_ID = \"...\" ; node podpitch-login.mjs");
  process.exit(1);
}

// 3. Open the PodPitch sign-in page (PKCE).
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));
const authUrl = new URL(as.authorization_endpoint);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: SCOPE,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: MCP_URL,
}).toString();

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== "/callback") { res.end(); return; }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(ok ? "<h2>PodPitch connected. You can close this tab and go back to the terminal.</h2>"
      : `<h2>Login failed: ${u.searchParams.get("error") || "state mismatch"}</h2>`);
    server.close();
    ok ? resolve(u.searchParams.get("code")) : reject(new Error(u.searchParams.get("error_description") || u.searchParams.get("error") || "state mismatch"));
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log("\nOpening the PodPitch sign-in page. If it does not open, paste this into your browser:\n");
    console.log(authUrl.toString() + "\n");
    const cmd = process.platform === "win32" ? `start "" "${authUrl}"` : process.platform === "darwin" ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
    exec(cmd, () => {});
  });
  setTimeout(() => { server.close(); reject(new Error("timed out after 5 minutes")); }, 300000);
});

// 4. Exchange the code for tokens.
const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP_URL });
if (clientSecret) form.set("client_secret", clientSecret);
const tr = await fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
const tok = await tr.json().catch(() => ({}));
if (!tr.ok || !tok.access_token) {
  console.log(`Token exchange failed (${tr.status}): ${JSON.stringify(tok).slice(0, 300)}`);
  process.exit(1);
}

// 5. Check the login works (read-only call) and save what the worker needs.
let sessionId = null;
async function rpc(body) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.access_token}` };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = r.headers.get("mcp-session-id") || sessionId;
  const t = await r.text();
  if (body.id === undefined) return null;
  const j = t.trim().startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() || "{}";
  return JSON.parse(j);
}
await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tpx-login", version: "1.0" } } });
await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
const who = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_connected_account", arguments: {} } });
const account = who?.result?.structuredContent || who?.result?.content?.[0]?.text || who?.error;

const saved = {
  token_endpoint: as.token_endpoint,
  client_id: clientId,
  client_secret: clientSecret || undefined,
  refresh_token: tok.refresh_token || "",
  scope: tok.scope || SCOPE,
  resource: MCP_URL,
};
writeFileSync("podpitch-oauth.json", JSON.stringify(saved, null, 2));
console.log(`\nConnected as: ${typeof account === "string" ? account : JSON.stringify(account)}`);
console.log(`Scope granted: ${saved.scope}`);
console.log(saved.refresh_token ? "Refresh token: received (the worker can stay logged in)." : "WARNING: no refresh token was given. Tell Claude.");
console.log("\nSaved podpitch-oauth.json. Do NOT share it in chat. Next step is in the chat instructions.");
