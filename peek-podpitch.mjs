// Saves ONE small sample from each PodPitch read tool to podpitch-samples.json,
// so the Slack updates can be built on the real field names.
// READ-ONLY: only the tools in READ_ONLY below can be called. Nothing is sent, edited or scheduled.
// Long texts are cut to 300 characters; no login token is written to the file.
//
// Usage (PowerShell, in the tpx-handoff folder), after  node podpitch-login.mjs :
//   node peek-podpitch.mjs
// Then attach podpitch-samples.json in the chat.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const URL_ = "https://api.podpitch.com/v1/mcp";

// Uses the PodPitch login saved by podpitch-login.mjs (account tools need it, an API key is not enough).
async function accessToken() {
  if (!existsSync("podpitch-oauth.json")) {
    console.log("Run  node podpitch-login.mjs  first."); process.exit(1);
  }
  const o = JSON.parse(readFileSync("podpitch-oauth.json", "utf8"));
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refresh_token, client_id: o.client_id, resource: o.resource });
  if (o.client_secret) form.set("client_secret", o.client_secret);
  const r = await fetch(o.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) { console.log(`Refresh failed (${r.status}): ${JSON.stringify(t).slice(0, 200)}. Run podpitch-login.mjs again.`); process.exit(1); }
  // Some servers hand out a new refresh token each time; keep the newest one.
  if (t.refresh_token && t.refresh_token !== o.refresh_token) writeFileSync("podpitch-oauth.json", JSON.stringify({ ...o, refresh_token: t.refresh_token }, null, 2));
  return t.access_token;
}
const key = await accessToken();

const READ_ONLY = new Set([
  "get_connected_account", "list_profiles", "list_campaigns", "get_campaign", "get_campaign_drafts",
  "get_pitch_activity", "list_inbox_threads", "read_inbox_thread", "get_inbox_counts", "list_inbox_labels",
  "get_account_podcast", "get_podcast_details",
]);

let sessionId = null;
let rpcId = 1;
async function rpc(method, params, notify = false) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rpcId++, method, params };
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  if (notify) return null;
  const j = text.trim().startsWith("{") ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() || "{}";
  const json = JSON.parse(j);
  if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 300));
  return json.result;
}

async function tool(name, args = {}) {
  if (!READ_ONLY.has(name)) throw new Error(`blocked: ${name}`);
  try {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r?.isError) return { error: (r.content || []).map((c) => c.text).join(" ").slice(0, 300) };
    if (r?.structuredContent) return r.structuredContent;
    const t = (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try { return JSON.parse(t); } catch { return { text: t }; }
  } catch (e) {
    return { error: e.message };
  }
}

// Keep the shape, shrink the content: cut long strings, keep only the first 3 items of lists.
function trim(v, depth = 0) {
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => trim(x, depth + 1)).concat(v.length > 3 ? [`(+${v.length - 3} more)`] : []);
  if (v && typeof v === "object" && depth < 8) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

const firstList = (o) => Array.isArray(o) ? o : Object.values(o || {}).find(Array.isArray) || [];
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null) return o[k]; return undefined; };

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tpx-peek", version: "1.0" } });
await rpc("notifications/initialized", {}, true);

const out = {};
const step = async (label, name, args) => { process.stdout.write(`${label}... `); out[label] = await tool(name, args); console.log(out[label]?.error ? `error: ${out[label].error}` : "ok"); return out[label]; };

await step("account", "get_connected_account");
const profiles = await step("profiles", "list_profiles");
const campaigns = await step("campaigns", "list_campaigns", { limit: 10 });

const camp = firstList(campaigns)[0];
const campId = pick(camp, "id", "campaign_id");
if (campId) {
  await step("campaign_detail", "get_campaign", { campaign_id: Number(campId) });
  const drafts = await step("campaign_drafts", "get_campaign_drafts", { campaign_id: Number(campId), limit: 3 });
  const d0 = firstList(drafts)[0];
  const pid = pick(d0, "podcast_id", "entity_id", "id");
  if (pid) {
    await step("account_podcast", "get_account_podcast", { podcast_id: String(pid) });
    await step("public_podcast", "get_podcast_details", { podcast_id: String(pid) });
  }
}

await step("pitch_activity", "get_pitch_activity", {});
await step("inbox_counts", "get_inbox_counts", {});
await step("inbox_labels", "list_inbox_labels");
const threads = await step("inbox_threads", "list_inbox_threads", { limit: 3 });
const t0 = firstList(threads)[0];
const threadId = pick(t0, "thread_id", "id");
const mailbox = pick(t0, "email", "mailbox", "from_email", "account_email");
if (threadId && mailbox) await step("inbox_thread", "read_inbox_thread", { email: String(mailbox), thread_id: String(threadId) });

writeFileSync("podpitch-samples.json", JSON.stringify(trim(out), null, 2));
console.log(`\nSaved podpitch-samples.json (profiles: ${firstList(profiles).length}, campaigns: ${firstList(campaigns).length})`);
