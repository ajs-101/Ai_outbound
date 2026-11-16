// LinkedIn replies (Aimfox) -> Claude draft in LinkedIn chat style -> Slack card -> Approve sends it
// in the same LinkedIn conversation through the Aimfox API. Nothing is sent without a click.
//
// Flow
//   Aimfox webhook "New Reply"  ->  POST /aimfox/webhook?key=AIMFOX_WEBHOOK_SECRET
//   -> raw payload kept 7 days (GET /aimfox/last?key=RUN_SECRET shows the latest ones)
//   -> queue -> research (website + public LinkedIn) -> Claude (LinkedIn style) -> card in SLACK_LINKEDIN_CHANNEL
//   -> Approve: re-reads the conversation (not sent if someone already answered) -> Aimfox send message
//
// Aimfox does not publish its webhook payload format, so the reader below looks for the fields under
// several common names and, failing that, searches the whole payload. If a reply can't be matched to a
// conversation, the card still appears (with "Open in Aimfox"), just without the Approve button.

const AIMFOX_V2 = "https://api.aimfox.com/api/v2";
const RAW_TTL_SECONDS = 7 * 24 * 3600;
const LI_EXPIRY_MS = 72 * 3600 * 1000;   // LinkedIn Approve works for 72h
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

/* ---------- reading the Aimfox payload ---------- */

const str = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function first(obj, paths) {
  for (const p of paths) {
    const v = get(obj, p);
    if (str(v)) return str(v);
  }
  return "";
}
// Depth-first search for the first value whose key matches `keyRe` (and optionally value `valRe`).
function deepFind(obj, keyRe, valRe, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && str(v) && (!valRe || valRe.test(str(v)))) return str(v);
  }
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, keyRe, valRe, depth + 1);
    if (hit) return hit;
  }
  return "";
}
function deepFindValue(obj, valRe, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const v of Object.values(obj)) {
    if (str(v) && valRe.test(str(v))) return str(v);
    const hit = typeof v === "object" ? deepFindValue(v, valRe, depth + 1) : "";
    if (hit) return hit;
  }
  return "";
}

export function profileUrl(raw) {
  const m = String(raw || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].toLowerCase()}` : "";
}

export function parseAimfoxEvent(payload) {
  const p = payload || {};
  const d = p.data || p.payload || p.event_data || p;
  const lead = d.lead || d.target || d.profile || d.contact || d.sender || d.from || {};
  const type = first(p, ["event", "type", "event_type", "event_name", "name"]) || first(d, ["event", "type", "event_type"]);

  const publicId = first(lead, ["public_identifier", "public_id", "publicIdentifier", "username"]);
  const url = profileUrl(first(lead, ["public_url", "profile_url", "linkedin_url", "url", "linkedin"])) ||
    (publicId ? `https://www.linkedin.com/in/${publicId}` : "") || profileUrl(deepFindValue(p, /linkedin\.com\/in\//i));

  const firstName = first(lead, ["first_name", "firstName", "firstname"]);
  const lastName = first(lead, ["last_name", "lastName", "lastname"]);
  const fullName = first(lead, ["full_name", "fullName", "name"]) || [firstName, lastName].filter(Boolean).join(" ");

  const msg = d.message && typeof d.message === "object" ? d.message : {};
  const text = first(msg, ["body", "text", "content", "message"]) ||
    first(d, ["message", "text", "body", "content", "reply", "reply_text", "message_text", "last_message.body", "last_message.text"]);

  return {
    type,
    account_id: first(d, ["account_id", "accountId", "account.id", "sender_account.id", "linkedin_account.id", "owner.id"]) ||
      first(p, ["account_id", "accountId", "account.id"]) || deepFind(p, /^account_?id$/i),
    conversation_urn: first(d, ["conversation_urn", "conversationUrn", "conversation.urn", "conversation.id", "conversation_id", "thread_urn", "thread_id"]) ||
      deepFindValue(p, /urn:li:[a-z_]*(conversation|thread)/i) || deepFind(p, /conversation_?(urn|id)$/i),
    message_id: first(msg, ["id", "urn", "message_id"]) || first(d, ["message_id", "messageId", "message_urn", "event_id", "id"]) || first(p, ["id", "event_id"]),
    text: text.trim(),
    created_at: Date.parse(first(msg, ["created_at", "timestamp", "sent_at"]) || first(d, ["created_at", "timestamp", "sent_at"]) || first(p, ["created_at", "timestamp"])) || Date.now(),
    from_us: Boolean(msg.is_sender || d.is_sender || /outgoing|outbound|sent/i.test(first(d, ["direction"]) || first(msg, ["direction"]))),
    lead_id: first(lead, ["id", "lead_id", "urn"]) || first(d, ["lead_id", "leadId", "target_id"]),
    first_name: firstName || fullName.split(" ")[0] || "",
    last_name: lastName,
    name: fullName,
    headline: first(lead, ["occupation", "headline", "title", "job_title"]),
    company: first(lead, ["company_name", "company.name", "current_company.name", "current_company", "company", "organization"]),
    location: first(lead, ["location", "geo_location", "city"]),
    profile_url: url,
    campaign_id: first(d, ["campaign_id", "campaignId", "campaign.id"]) || first(p, ["campaign_id", "campaign.id"]),
    campaign_name: first(d, ["campaign_name", "campaignName", "campaign.name"]) || first(p, ["campaign_name", "campaign.name"]),
  };
}

const isReplyEvent = (ev) => !ev.type || /repl|message_received|new_message|inbox/i.test(ev.type);

/* ---------- Aimfox API ---------- */

async function aimfox(env, method, path, body) {
  const res = await fetch(`${AIMFOX_V2}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.AIMFOX_API_KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data, text: text.slice(0, 300) };
}

// Messages of a conversation, oldest first: [{ text, from_us, at }]
export function readMessages(data, accountId) {
  const pools = [data?.messages, data?.data?.messages, data?.conversation?.messages, data?.data?.conversation?.messages, data?.items, data?.data?.items, Array.isArray(data?.data) ? data.data : null, Array.isArray(data) ? data : null];
  const list = pools.find((x) => Array.isArray(x)) || [];
  return list.map((m) => {
    const sender = str(m.sender_id || m.sender?.id || m.from?.id || m.author?.id || m.sender_urn || "");
    const fromUs = Boolean(m.is_sender ?? m.is_outgoing ?? m.from_me ?? m.outgoing ?? (/out|sent/i.test(str(m.direction)) || (accountId && sender && sender === String(accountId))));
    return {
      text: str(m.body || m.text || m.content || m.message).trim(),
      from_us: fromUs,
      at: Date.parse(str(m.created_at || m.timestamp || m.sent_at || m.createdAt)) || Number(m.created_at || m.timestamp) || 0,
    };
  }).filter((m) => m.text).sort((a, b) => a.at - b.at);
}

async function fetchConversation(env, ev) {
  if (!ev.account_id || !ev.conversation_urn) return { messages: [], error: "no account or conversation in the Aimfox event" };
  const r = await aimfox(env, "GET", `/accounts/${encodeURIComponent(ev.account_id)}/conversations/${encodeURIComponent(ev.conversation_urn)}`);
  if (!r.ok) return { messages: [], error: `Aimfox conversation ${r.status}: ${r.text}` };
  return { messages: readMessages(r.data, ev.account_id) };
}

// Sends the message. Tries {message}, and {text} only if Aimfox rejected the body (4xx = nothing was sent).
async function sendMessage(env, rec, text) {
  const path = `/accounts/${encodeURIComponent(rec.account_id)}/conversations/${encodeURIComponent(rec.conversation_urn)}`;
  let r = await aimfox(env, "POST", path, { message: text });
  if (!r.ok && (r.status === 400 || r.status === 422)) r = await aimfox(env, "POST", path, { text });
  return r;
}

/* ---------- drafting ---------- */

// LinkedIn has no formatting: no blank lines, no markdown links, no sign-off.
export function linkedinText(t, signer) {
  let s = String(t || "").replace(/\r/g, "");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) => url);
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  if (signer) s = s.replace(new RegExp(`\\n\\s*-?\\s*${signer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
  // Email habit: a lone first name on the last line ("cara", "- Joan"). LinkedIn messages have no sign-off.
  const lines = s.split("\n");
  const last = (lines[lines.length - 1] || "").trim();
  if (lines.length > 1 && /^-?\s*[A-Za-z]{2,15}$/.test(last) && !/^-?\s*(thanks|thank|cheers|best|yes|yeah|sure|nice|cool|great|awesome|ok|okay)$/i.test(last)) lines.pop();
  return lines.join("\n").trim();
}

function transcript(messages, name) {
  return messages.slice(-12).map((m) => `${m.from_us ? "US" : (name || "THEM")}: ${m.text}`).join("\n");
}

async function draftLinkedin(env, deps, ev, history, research) {
  const brand = deps.brandFor(env, { campaign_id: ev.campaign_id, campaign_name: ev.campaign_name });
  const calendly = deps.calendlyFor(env, { campaign_id: ev.campaign_id, campaign_name: ev.campaign_name });
  const user = `Draft a LinkedIn reply.

Lead: ${ev.name || "(unknown)"}
Headline: ${ev.headline}
Company: ${ev.company}
Location: ${ev.location}
LinkedIn: ${ev.profile_url}
Aimfox campaign: ${ev.campaign_name}

THEIR LATEST MESSAGE:
${ev.text}

CONVERSATION SO FAR (oldest first):
${history.length ? transcript(history, ev.first_name) : "(not available, only the latest message)"}${deps.researchText(research)}`;

  const body = JSON.stringify({
    model: env.CLAUDE_MODEL,
    max_tokens: 800,
    system: deps.buildLinkedinPrompt(env, calendly, brand),
    messages: [{ role: "user", content: user }],
  });
  let res;
  let err = "";
  for (const wait of [0, 2000, 5000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body,
    });
    if (res.ok) break;
    err = `Claude ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (![403, 408, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
  }
  if (!res.ok) throw new Error(err);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const action = ["DRAFT", "ESCALATE", "NO_REPLY"].includes(obj.action) ? obj.action : "ESCALATE";
  const out = {
    brand: brand.team,
    intent: String(obj.intent || "OTHER"),
    confidence: ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "low",
    action,
    escalation_reason: String(obj.escalation_reason || ""),
    note: String(obj.note_for_human || ""),
    draft: linkedinText(deps.cleanCalendlyLinks(obj.draft || ""), ""),
  };
  if (out.action === "DRAFT" && (!out.draft || out.confidence === "low")) {
    out.action = "ESCALATE";
    out.escalation_reason = out.escalation_reason || (out.draft ? "Low confidence" : "Empty draft");
  }
  if (/\$\s?\d|\d+\s?(usd|dollars|\/mo|per month)/i.test(out.draft)) out.warning = "mentions a price (we never quote numbers)";
  return out;
}

/* ---------- webhook + queue job ---------- */

export async function handleAimfoxWebhook(request, env, ctx, url, deps) {
  const key = url.searchParams.get("key") || request.headers.get("x-webhook-secret") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.AIMFOX_WEBHOOK_SECRET || key !== env.AIMFOX_WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // Keep the raw event for 7 days (helps when Aimfox changes its format).
  ctx.waitUntil(env.HANDOFF_KV.put(`afraw:${Date.now()}`, raw.slice(0, 20000), { expirationTtl: RAW_TTL_SECONDS }).catch(() => {}));

  const ev = parseAimfoxEvent(payload);
  if (!isReplyEvent(ev) || ev.from_us || !ev.text) return new Response("ignored");

  const id = `li:${(ev.message_id || `${ev.conversation_urn}:${ev.text}`).replace(/[^\w:.-]/g, "").slice(0, 180)}`;
  if (!(await deps.claimDraft(env, id))) return new Response("duplicate");
  if (env.REPLY_QUEUE) await env.REPLY_QUEUE.send({ kind: "linkedin", id, payload });
  else ctx.waitUntil(runLinkedin(env, deps, id, payload));
  return new Response("accepted");
}

export async function runLinkedin(env, deps, id, payload) {
  const ev = parseAimfoxEvent(payload);
  try {
    const [conv, research] = await Promise.all([
      fetchConversation(env, ev),
      env.RESEARCH_ENABLED !== "false"
        ? deps.researchLead(env, { firstName: ev.first_name, lastName: ev.last_name, companyName: ev.company, headline: ev.headline, location: ev.location, linkedIn: ev.profile_url, lead_email: "" }, ev.text).catch((e) => ({ error: e.message }))
        : Promise.resolve(null),
    ]);
    const ai = await draftLinkedin(env, deps, ev, conv.messages, research);
    const rec = {
      kind: "linkedin",
      email_id: id,
      status: ai.action === "NO_REPLY" ? "no_reply" : "pending",
      account_id: ev.account_id,
      conversation_urn: ev.conversation_urn,
      lead_name: ev.name || "LinkedIn lead",
      first_name: ev.first_name,
      headline: ev.headline,
      company: ev.company,
      profile_url: ev.profile_url,
      campaign_name: ev.campaign_name,
      brand: ai.brand,
      latest: ev.text,
      reply_at: ev.created_at,
      intent: ai.intent,
      confidence: ai.confidence,
      action: ai.action,
      escalation_reason: ai.escalation_reason,
      note: ai.note,
      draft: ai.draft,
      warnings: [ai.warning, conv.error && `conversation not loaded: ${conv.error}`, (!ev.account_id || !ev.conversation_urn) && "can't send from Slack: the Aimfox event had no conversation, reply in Aimfox"].filter(Boolean),
      research: research && !research.error ? { firm_summary: research.firm_summary || "", profile_note: research.profile_note || "", pain_points: research.pain_points || [], website: research.website || "" } : null,
      created_at: Date.now(),
    };
    const channel = env.SLACK_LINKEDIN_CHANNEL || env.SLACK_REPLIES_CHANNEL;
    const msg = await deps.slackPost(env, channel, { text: `LinkedIn reply from ${rec.lead_name}`, blocks: linkedinCard(rec, deps), unfurl_links: false });
    rec.channel = msg.channel;
    rec.ts = msg.ts;
    await deps.saveDraft(env, rec);
  } catch (err) {
    console.error(`LinkedIn draft failed: ${err.message}`);
    await deps.deleteDraft(env, id);
    await deps.slackPost(env, env.SLACK_LINKEDIN_CHANNEL || env.SLACK_ESCALATIONS_CHANNEL, {
      text: `LinkedIn draft FAILED for ${ev.name}: ${err.message}`,
      blocks: [deps.section(`*LinkedIn draft failed* for ${deps.esc(ev.name || "a lead")}${ev.profile_url ? ` (<${ev.profile_url}|profile>)` : ""}\n` +
        `They wrote: ${deps.esc(ev.text.slice(0, 500))}\n\`${deps.esc(err.message).slice(0, 300)}\`\nReply in Aimfox.`)],
    }).catch(() => {});
  }
}

/* ---------- Slack card ---------- */

function linkedinCard(rec, deps, doneLine) {
  const { section, esc, quote } = deps;
  const canSend = rec.account_id && rec.conversation_urn;
  const head = `*LinkedIn* · *${esc(rec.lead_name)}*${rec.profile_url ? ` (<${rec.profile_url}|profile>)` : ""}` +
    `${rec.headline ? `\n${esc(rec.headline).slice(0, 150)}` : ""}` +
    `\n${esc(rec.campaign_name || "Aimfox")} · writing as *${esc(rec.brand)}* · intent ${esc(rec.intent)} (${esc(rec.confidence)})`;
  const blocks = [section(head), section(`*Their message:*\n${quote(rec.latest)}`)];
  if (rec.action === "DRAFT") blocks.push(section(`*Draft (LinkedIn):*\n${quote(rec.sent_text || rec.draft)}`));
  else if (rec.action === "ESCALATE") blocks.push(section(`*Needs a human:* ${esc(rec.escalation_reason || "see note")}`));
  else blocks.push(section(`*No reply needed* (${esc(rec.intent)})`));

  const r = rec.research;
  if (r && !rec.sent_text && (r.firm_summary || r.pain_points?.length)) {
    const lines = [];
    if (r.firm_summary) lines.push(esc(r.firm_summary));
    if (r.profile_note) lines.push(`Person: ${esc(r.profile_note)}`);
    for (const p of r.pain_points || []) lines.push(`Pain point (${esc(p.source)}): *${esc(p.pain)}*. Seen: ${esc(p.evidence)}`);
    blocks.push(section(`*Lead research* (team only):\n${lines.join("\n")}`));
  }
  const ctx = [];
  if (rec.note) ctx.push(`Note: ${esc(rec.note)}`);
  for (const w of rec.warnings || []) ctx.push(`⚠ ${esc(w)}`);
  if (ctx.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ctx.join("\n").slice(0, 2900) }] });

  if (doneLine) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: doneLine }] });
    return blocks;
  }
  const btn = (id, label, style) => ({ type: "button", action_id: id, value: rec.email_id, text: { type: "plain_text", text: label }, ...(style ? { style } : {}) });
  const buttons = [];
  if (rec.action === "DRAFT" && canSend) buttons.push(btn("li_approve", "Approve & send", "primary"), btn("li_edit", "Edit"), btn("li_reject", "Reject", "danger"));
  else if (canSend) buttons.push(btn("li_write", "Write reply", "primary"));
  buttons.push(btn("li_handled", "Mark handled"));
  if (rec.profile_url) buttons.push({ type: "button", action_id: "open_unibox", text: { type: "plain_text", text: "Open profile" }, url: rec.profile_url });
  blocks.push({ type: "actions", elements: buttons });
  return blocks;
}

async function updateLinkedinCard(env, deps, rec, line) {
  if (!rec.channel || !rec.ts) return;
  await deps.slackApi(env, "chat.update", { channel: rec.channel, ts: rec.ts, text: line, blocks: linkedinCard(rec, deps, line) });
}

function liModal(rec, kind) {
  const pt = (t) => ({ type: "plain_text", text: String(t).slice(0, 75) });
  if (kind === "reject") {
    return {
      type: "modal", callback_id: "li_reject_modal", private_metadata: rec.email_id, title: pt("Reject draft"), submit: pt("Reject"), close: pt("Cancel"),
      blocks: [{ type: "input", block_id: "reason", optional: true, label: pt("Why? (helps tune the AI)"), element: { type: "plain_text_input", action_id: "text", multiline: true } }],
    };
  }
  return {
    type: "modal", callback_id: "li_edit_modal", private_metadata: rec.email_id,
    title: pt(kind === "write" ? "Write LinkedIn reply" : "Edit LinkedIn reply"), submit: pt("Send"), close: pt("Cancel"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `To *${String(rec.lead_name).replace(/[<>&]/g, "")}* on LinkedIn. No blank lines, no sign-off.` } },
      { type: "input", block_id: "body", label: pt("Message"), element: { type: "plain_text_input", action_id: "text", multiline: true, initial_value: kind === "write" ? "" : String(rec.draft || "").slice(0, 2900) } },
    ],
  };
}

/* ---------- buttons ---------- */

export async function handleLinkedinAction(env, ctx, deps, payload, action, userId) {
  const id = action.value;
  if (action.action_id === "li_approve") {
    ctx.waitUntil((async () => {
      const rec = await deps.waitForDraft(env, id, 10000);
      if (!rec || rec.status === "processing") return deps.ephemeral(payload.response_url, deps.draftMissingText(rec));
      return sendLinkedin(env, deps, rec, rec.draft, userId, payload.response_url, false);
    })());
    return new Response("");
  }
  const rec = await deps.waitForDraft(env, id, 1500);
  if (!rec || rec.status === "processing") {
    ctx.waitUntil(deps.ephemeral(payload.response_url, deps.draftMissingText(rec)));
    return new Response("");
  }
  if (rec.status !== "pending") {
    ctx.waitUntil(deps.ephemeral(payload.response_url, `Already ${rec.status}${rec.acted_by ? ` by <@${rec.acted_by}>` : ""}.`));
    return new Response("");
  }
  if (action.action_id === "li_edit" || action.action_id === "li_write" || action.action_id === "li_reject") {
    const kind = action.action_id.slice(3);
    await deps.slackApi(env, "views.open", { trigger_id: payload.trigger_id, view: liModal(rec, kind) });
    return new Response("");
  }
  if (action.action_id === "li_handled") {
    ctx.waitUntil(closeLinkedin(env, deps, rec, "handled", userId, `Marked handled by <@${userId}>`));
  }
  return new Response("");
}

export async function handleLinkedinView(env, ctx, deps, payload, userId) {
  const view = payload.view || {};
  const rec = await deps.loadDraft(env, view.private_metadata);
  if (!rec || rec.status === "processing") return Response.json({ response_action: "errors", errors: { body: deps.draftMissingText(rec) } });
  if (view.callback_id === "li_edit_modal") {
    const text = linkedinText(view.state?.values?.body?.text?.value || "", "");
    if (!text) return Response.json({ response_action: "errors", errors: { body: "Message cannot be empty." } });
    ctx.waitUntil(sendLinkedin(env, deps, rec, text, userId, null, true));
    return Response.json({ response_action: "clear" });
  }
  if (view.callback_id === "li_reject_modal") {
    const reason = view.state?.values?.reason?.text?.value?.trim() || "(no reason given)";
    ctx.waitUntil((async () => {
      await closeLinkedin(env, deps, rec, "rejected", userId, `Rejected by <@${userId}>: ${deps.esc(reason)}`);
      if (env.SLACK_EDITS_CHANNEL) {
        await deps.slackPost(env, env.SLACK_EDITS_CHANNEL, {
          text: `LinkedIn draft rejected: ${rec.lead_name}`,
          blocks: [deps.section(`*LinkedIn draft rejected* by <@${userId}> · ${deps.esc(rec.lead_name)}\n*They wrote:*\n${deps.quote(rec.latest)}\n*Draft:*\n${deps.quote(rec.draft)}\n*Reason:* ${deps.esc(reason)}`)],
        }).catch(() => {});
      }
    })());
    return Response.json({ response_action: "clear" });
  }
  return new Response("");
}

async function closeLinkedin(env, deps, rec, status, userId, line) {
  const lock = await deps.swapDraft(env, rec.email_id, "pending", (r) => ({ ...r, status, acted_by: userId, acted_at: Date.now() }));
  if (lock.ok) await updateLinkedinCard(env, deps, lock.current, line);
}

async function tell(env, deps, rec, responseUrl, userId, text) {
  if (responseUrl) return deps.ephemeral(responseUrl, text).catch(() => {});
  if (rec.channel) return deps.slackPost(env, rec.channel, { thread_ts: rec.ts, text: `<@${userId}> ${text}` }).catch(() => {});
}

async function sendLinkedin(env, deps, rec, rawText, userId, responseUrl, edited) {
  const text = linkedinText(deps.cleanCalendlyLinks(rawText), "");
  if (!rec.account_id || !rec.conversation_urn) return tell(env, deps, rec, responseUrl, userId, "This reply can't be sent from Slack (no conversation in the Aimfox event). Reply in Aimfox.");
  if (Date.now() - rec.created_at > LI_EXPIRY_MS) return tell(env, deps, rec, responseUrl, userId, "This draft is older than 72 hours. Reply in Aimfox instead.");

  const lock = await deps.swapDraft(env, rec.email_id, "pending", (r) => ({ ...r, status: "sending", acted_by: userId, acted_at: Date.now() }));
  if (!lock.ok) {
    const cur = lock.current;
    return tell(env, deps, rec, responseUrl, userId, `Already ${cur?.status || "closed"}${cur?.acted_by ? ` by <@${cur.acted_by}>` : ""}. Nothing sent.`);
  }
  const fresh = lock.current;

  // Did someone already answer in Aimfox / LinkedIn after their message?
  const conv = await fetchConversation(env, fresh);
  if (!conv.error) {
    const after = fresh.reply_at || fresh.created_at - 5 * 60e3;
    const ours = conv.messages.find((m) => m.from_us && m.at > after);
    if (ours) {
      fresh.status = "answered_elsewhere";
      await deps.saveDraft(env, fresh);
      await updateLinkedinCard(env, deps, fresh, `Not sent: someone already replied on LinkedIn ${deps.slackTime(ours.at)}: "${deps.esc(ours.text.slice(0, 120))}". Clicked by <@${userId}>.`).catch(() => {});
      return tell(env, deps, fresh, responseUrl, userId, "Not sent: this lead was already answered on LinkedIn (see the card).");
    }
  } else {
    console.warn(`LinkedIn check skipped for ${fresh.email_id}: ${conv.error}`);
  }

  const r = await sendMessage(env, fresh, text);
  if (!r.ok) {
    fresh.status = "pending";
    fresh.acted_by = null;
    await deps.saveDraft(env, fresh);
    return deps.slackPost(env, fresh.channel, { thread_ts: fresh.ts, text: `LinkedIn send FAILED (Aimfox ${r.status}): ${r.text}. The draft is still pending; try again or reply in Aimfox.` }).catch(() => {});
  }
  fresh.status = "sent";
  fresh.edited = Boolean(edited && text.trim() !== (fresh.draft || "").trim());
  fresh.sent_text = text;
  fresh.sent_at = Date.now();
  await deps.saveDraft(env, fresh);
  await updateLinkedinCard(env, deps, fresh, `Sent on LinkedIn${fresh.edited ? " (edited)" : ""} by <@${userId}> ${deps.slackTime(fresh.sent_at)}`);
  if (fresh.edited && env.SLACK_EDITS_CHANNEL) {
    await deps.slackPost(env, env.SLACK_EDITS_CHANNEL, {
      text: `LinkedIn draft edited: ${fresh.lead_name}`,
      blocks: [deps.section(`*LinkedIn draft edited* by <@${userId}> · ${deps.esc(fresh.lead_name)}\n*AI draft:*\n${deps.quote(fresh.draft)}\n*Sent:*\n${deps.quote(text)}`)],
    }).catch(() => {});
  }
}

/* ---------- debugging: latest raw Aimfox events ---------- */

export async function handleAimfoxLast(env, url) {
  if (url.searchParams.get("key") !== env.RUN_SECRET) return new Response("unauthorized", { status: 401 });
  const list = await env.HANDOFF_KV.list({ prefix: "afraw:" });
  const keys = list.keys.map((k) => k.name).sort().reverse().slice(0, Number(url.searchParams.get("n") || 5));
  const out = [];
  for (const k of keys) {
    const raw = await env.HANDOFF_KV.get(k);
    let payload = raw;
    try { payload = JSON.parse(raw); } catch { /* keep text */ }
    out.push({ received: new Date(Number(k.slice(6))).toISOString(), parsed: parseAimfoxEvent(payload), payload });
  }
  return Response.json(out);
}