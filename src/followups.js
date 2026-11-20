// 4-step follow-ups for leads who go quiet after we reply (email, Instantly).
//
// How it runs
//   Start  : a reply card is sent from Slack, or the worker sees someone replied by hand in Unibox.
//            Not for NOT_INTERESTED / UNSUBSCRIBE / OOO. One sequence per lead (a new reply restarts it).
//   Batch  : cron 13:07 UTC = 6:07 PM PKT. Weekends skipped (FOLLOWUP_SKIP_WEEKENDS). Every active sequence
//            that is due and has no card waiting gets a draft card in FOLLOWUP_CHANNEL (#tpx-followups).
//   Card   : Approve & send / Edit / Skip this one / Stop follow-ups. Nothing is sent without a click.
//   Timing : the next step is due FOLLOWUP_GAP_HOURS (24h) after our last message was SENT. While a card
//            waits for a click the sequence pauses, so two follow-ups never land on the same day.
//   Stops  : the lead replies (Instantly webhook), Stop is clicked, a card waits over 48h, or all steps are sent.
//            Before every send the thread is re-read: lead wrote -> stop; a teammate wrote -> clock restarts.
//
// Storage (KV)
//   fuseq:<lead email>  the sequence (JSON) + metadata {s status, d due_at, p card pending since, n step, r reminded}
//   follow-up cards live in the draft store (id "fu:<lead>:<step>:<time>") so the Approve lock is the same as replies.
//   fulog:<day>:<id>    events for the weekly report (sent, skipped, stopped, reply after step n)

const INSTANTLY = "https://api.instantly.ai/api/v2";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const SEQ_TTL = 45 * 24 * 3600;
const LOG_TTL = 60 * 24 * 3600;
const NEVER_FOLLOW = /^(NOT_INTERESTED|UNSUBSCRIBE|OOO)$/i;
const BATCH_MAX = 30;
const DUE_SLACK_MS = 4 * 3600e3;        // a step due a few hours after the batch is drafted in this batch
const REMIND_MS = 24 * 3600e3;
const EXPIRE_MS = 48 * 3600e3;

const cfg = (env) => ({
  on: env.FOLLOWUP_ENABLED !== "false",
  steps: Math.min(Math.max(Number(env.FOLLOWUP_STEPS) || 4, 1), 6),
  gapMs: (Number(env.FOLLOWUP_GAP_HOURS) || 24) * 3600e3,
  skipWeekends: env.FOLLOWUP_SKIP_WEEKENDS !== "false",
  channel: env.FOLLOWUP_CHANNEL || env.SLACK_REPLIES_CHANNEL,
});

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const seqKey = (email) => `fuseq:${String(email || "").toLowerCase()}`;

/* ---------- sequence storage ---------- */

async function loadSeq(env, email) {
  const v = await env.HANDOFF_KV.get(seqKey(email));
  return v ? JSON.parse(v) : null;
}
async function saveSeq(env, seq) {
  seq.updated_at = Date.now();
  const meta = { s: seq.status, d: seq.due_at || 0, p: seq.pending_since || 0, n: seq.step || 0, r: seq.reminded ? 1 : 0 };
  await env.HANDOFF_KV.put(seqKey(seq.lead_email), JSON.stringify(seq), { metadata: meta, expirationTtl: SEQ_TTL });
}
async function logFu(env, event, seq, extra = {}) {
  try {
    const now = Date.now();
    await env.HANDOFF_KV.put(`fulog:${day(now)}:${now}:${Math.random().toString(36).slice(2, 7)}`, "1",
      { metadata: { e: event, n: seq.step || 0, c: String(seq.campaign_name || "").slice(0, 60), ...extra }, expirationTtl: LOG_TTL });
  } catch (err) {
    console.warn(`Follow-up log failed: ${err.message}`);
  }
}

/* ---------- start / stop (called from index.js) ---------- */

const brandKeyOf = (rec) => rec.brand_key || (/AI Search Engineers/i.test(rec.brand || "") ? "asie" : "tpx");

// rec = a reply card record (sent from Slack or answered by hand). lastOurAt = when our message went out.
export async function startSequence(env, deps, rec, lastOurAt, how) {
  try {
    const c = cfg(env);
    if (!c.on || !rec?.lead_email || rec.kind === "linkedin" || rec.kind === "followup") return null;
    if (NEVER_FOLLOW.test(String(rec.intent || ""))) return null;
    const at = Number(lastOurAt) || Date.now();
    const seq = {
      lead_email: String(rec.lead_email).toLowerCase(),
      lead_name: rec.lead_name || rec.lead_email,
      eaccount: rec.eaccount,
      reply_uuid: rec.email_id,          // the lead's email we answered: follow-ups go in this thread
      subject: rec.subject || "Re:",
      campaign_name: rec.campaign_name || "",
      campaign_id: rec.campaign_id || "",
      brand_key: brandKeyOf(rec),
      lead_last_at: rec.created_at || at,
      lead_last_text: String(rec.latest || "").slice(0, 1500),
      unibox_url: rec.unibox_url || "",
      thread_channel: rec.channel || "",
      thread_ts: rec.thread_ts || rec.ts || "",
      status: "active",
      step: 0,
      last_our_at: at,
      due_at: at + c.gapMs,
      pending: null,
      pending_since: 0,
      started_by: how || "sent",
      started_at: Date.now(),
      history: [],
    };
    const old = await loadSeq(env, seq.lead_email);
    if (old?.pending) await closeCard(env, deps, old.pending, "Closed: a new reply to this lead restarted the follow-ups.").catch(() => {});
    await saveSeq(env, seq);
    await logFu(env, "started", seq, { h: how || "sent" });
    return seq;
  } catch (err) {
    console.warn(`Follow-up start failed for ${rec?.lead_email}: ${err.message}`);
    return null;
  }
}

// The lead wrote (Instantly reply webhook): stop any running sequence.
export async function stopOnLeadReply(env, deps, leadEmail) {
  try {
    const seq = await loadSeq(env, leadEmail);
    if (!seq || seq.status !== "active") return;
    if (seq.step > 0) await logFu(env, "reply", seq);
    seq.status = "stopped";
    seq.stop_reason = "lead replied";
    const pending = seq.pending;
    seq.pending = null;
    seq.pending_since = 0;
    await saveSeq(env, seq);
    if (pending) await closeCard(env, deps, pending, `Not needed: ${deps.esc(seq.lead_name)} replied. Their reply has its own card.`).catch(() => {});
  } catch (err) {
    console.warn(`Follow-up stop failed for ${leadEmail}: ${err.message}`);
  }
}

/* ---------- Instantly thread ---------- */

const stripHtml = (h) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const when = (e) => Date.parse(e.timestamp_email || e.timestamp_created || "") || 0;

// Messages of the thread, oldest first, plus what happened since our last message.
async function threadState(env, seq) {
  const headers = { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` };
  if (!seq.thread_id) {
    const r1 = await fetch(`${INSTANTLY}/emails/${seq.reply_uuid}`, { headers });
    if (r1.ok) seq.thread_id = (await r1.json()).thread_id || "";
  }
  const qs = seq.thread_id
    ? new URLSearchParams({ search: `thread:${seq.thread_id}`, limit: "50", sort_order: "desc" })
    : new URLSearchParams({ lead: seq.lead_email, limit: "50", sort_order: "desc" });
  const r2 = await fetch(`${INSTANTLY}/emails?${qs}`, { headers });
  if (!r2.ok) throw new Error(`Instantly list emails ${r2.status}`);
  const items = ((await r2.json()).items || []).filter((e) => !seq.thread_id || e.thread_id === seq.thread_id);
  const leadAfter = items.filter((e) => e.ue_type === 2 && !e.is_auto_reply && when(e) > seq.last_our_at).sort((a, b) => when(a) - when(b));
  // Our own last message is at last_our_at; anything of ours 2+ minutes later was written by someone else.
  const oursAfter = items.filter((e) => (e.ue_type === 3 || e.ue_type === 4) && when(e) > seq.last_our_at + 120e3).sort((a, b) => when(a) - when(b));
  const messages = items.slice().sort((a, b) => when(a) - when(b)).slice(-10).map((e) => ({
    from_us: e.ue_type !== 2,
    at: when(e),
    text: stripHtml(e.body?.text || e.body?.html || e.content_preview || "").slice(0, 1200),
  })).filter((m) => m.text);
  return { leadAfter: leadAfter[0] || null, oursAfter: oursAfter[0] || null, messages };
}

/* ---------- drafting ---------- */

const PURPOSE = {
  1: "Light bump tied to the last thing they said or asked. One easy question. No new pitch.",
  2: "Add value: one concrete thing that helps them decide, such as one likely pain point from LEAD RESEARCH or a show we already named in this thread. Never name a show that is not already in the thread.",
  3: "A different angle from earlier messages: what happens when their clients ask ChatGPT, Gemini or Perplexity for someone like them. One curious question.",
  4: "Polite close-out: say you'll close this out for now and the door stays open. No pressure, no guilt.",
};

function followupPrompt(n, max, daysQuiet) {
  return `

FOLLOW-UP ${n} OF ${max} (this overrides the reply rules above where they differ)
The lead has not answered our last message for ${daysQuiet} day${daysQuiet === 1 ? "" : "s"}. Write follow-up ${n}.
Purpose of this step: ${PURPOSE[n] || PURPOSE[Math.min(n, 4)]}
Rules:
- 2 to 4 short lines, then the sender's first name in lowercase on its own line. Shorter than our last message.
- It goes in the same email thread, so never re-introduce yourself or the company.
- Never repeat a line, angle or question from our earlier messages (they are in the thread below).
- Never write "just checking in", "bumping this", "following up on my last email", "circling back" or "did you see my email".
- Only add the booking link if they showed interest earlier in the thread.
- action is DRAFT, unless the thread shows we should not follow up (they said no, asked us to stop, already booked, or are clearly busy until a later date): then NO_REPLY with the reason in note_for_human.
- "podcasts" is always [].`;
}

async function draftFollowup(env, deps, seq, n, thread) {
  const brand = deps.brandByKey(seq.brand_key);
  const calendly = deps.calendlyFor(env, { campaign_id: seq.campaign_id, campaign_name: seq.campaign_name });
  const daysQuiet = Math.max(1, Math.round((Date.now() - seq.last_our_at) / 86400e3));
  let research = null;
  try { const v = await env.HANDOFF_KV.get(`research2:${seq.lead_email}`); research = v ? JSON.parse(v) : null; } catch { /* none */ }
  const transcript = thread.messages.length
    ? thread.messages.map((m) => `${m.from_us ? "US" : "LEAD"} (${new Date(m.at).toISOString().slice(0, 10)}): ${m.text}`).join("\n\n")
    : `LEAD: ${seq.lead_last_text}`;
  const user = `Write follow-up ${n} for this lead.

Sender first name (sign off with this, lowercase): ${deps.senderFirstName(seq.eaccount)}
Lead: ${seq.lead_name} <${seq.lead_email}>
Campaign: ${seq.campaign_name}
Earlier follow-ups we sent: ${seq.history.filter((h) => h.sent).map((h) => `#${h.step}: ${h.text.replace(/\s+/g, " ").slice(0, 200)}`).join(" | ") || "none"}

EMAIL THREAD (oldest first):
${transcript.slice(-9000)}${deps.researchText(research)}`;

  const body = JSON.stringify({
    model: env.CLAUDE_MODEL,
    max_tokens: 700,
    system: deps.buildSystemPrompt(env, calendly, brand) + followupPrompt(n, cfg(env).steps, daysQuiet),
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
  return {
    brand: brand.team,
    action: obj.action === "NO_REPLY" ? "NO_REPLY" : "DRAFT",
    draft: deps.cleanCalendlyLinks(String(obj.draft || "").trim()),
    note: String(obj.note_for_human || ""),
    warnings: deps.lintDraft(String(obj.draft || ""), 0),
  };
}

/* ---------- Slack card ---------- */

function cardBlocks(rec, deps, doneLine) {
  const { section, esc, quote } = deps;
  const ago = Math.max(1, Math.round((Date.now() - rec.lead_last_at) / 86400e3));
  const blocks = [
    section(`*Follow-up ${rec.step} of ${rec.steps}* · Email · writing as *${esc(rec.brand)}*\n*${esc(rec.lead_name)}* ${esc(rec.lead_email)} · ${esc(rec.campaign_name)} · last heard from ${ago} day${ago === 1 ? "" : "s"} ago`),
    section(`*Their last message:*\n${quote(String(rec.lead_last_text || "").slice(0, 600))}`),
  ];
  if (rec.our_last_text) blocks.push(section(`*Our last message:*\n${quote(rec.our_last_text.slice(0, 600))}`));
  blocks.push(section(`*${rec.sent_text ? "Sent follow-up" : "Draft follow-up"}:*\n${quote(rec.sent_text || rec.draft)}`));
  const ctx = [];
  if (rec.note) ctx.push(`Note: ${esc(rec.note)}`);
  for (const w of rec.warnings || []) ctx.push(`⚠ ${esc(w)}`);
  if (ctx.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ctx.join("\n").slice(0, 2900) }] });
  if (doneLine) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: doneLine }] });
    return blocks;
  }
  const btn = (id, label, style) => ({ type: "button", action_id: id, value: rec.email_id, text: { type: "plain_text", text: label }, ...(style ? { style } : {}) });
  // Slack refuses a card whose buttons share an action_id (invalid_blocks), so each link gets its own.
  const link = (id, label, url) => (url ? { type: "button", action_id: id, text: { type: "plain_text", text: label }, url } : null);
  blocks.push({ type: "actions", elements: [
    btn("fu_approve", "Approve & send", "primary"), btn("fu_edit", "Edit"), btn("fu_skip", "Skip this one"), btn("fu_stop", "Stop follow-ups", "danger"),
    link("open_thread", "Open thread", rec.thread_link), link("open_unibox", "Open in Unibox", rec.unibox_url),
  ].filter(Boolean) });
  return blocks;
}

async function updateCard(env, deps, rec, line) {
  if (!rec?.channel || !rec?.ts) return;
  await deps.slackApi(env, "chat.update", { channel: rec.channel, ts: rec.ts, text: line, blocks: cardBlocks(rec, deps, line) });
}

// Closes a waiting card (any status change other than a send). deps may be null during start (no Slack text).
async function closeCard(env, deps, id, line, status = "closed") {
  if (!deps) return;
  const lock = await deps.swapDraft(env, id, "pending", (r) => ({ ...r, status, acted_at: Date.now() }));
  if (lock.ok) await updateCard(env, deps, lock.current, line);
}

async function postToChannel(env, deps, msg) {
  const channel = cfg(env).channel;
  try {
    return await deps.slackPost(env, channel, msg);
  } catch (err) {
    if (!/channel_not_found|not_in_channel/.test(err.message) || !env.SLACK_REPLIES_CHANNEL || channel === env.SLACK_REPLIES_CHANNEL) throw err;
    const out = await deps.slackPost(env, env.SLACK_REPLIES_CHANNEL, msg);
    await deps.slackPost(env, env.SLACK_REPLIES_CHANNEL, { thread_ts: out.ts, text: `FOLLOWUP_CHANNEL ${channel} failed (${err.message}): invite the bot there or fix the ID. Posted here instead.` }).catch(() => {});
    return out;
  }
}

/* ---------- daily batch ---------- */

export async function runFollowups(env, deps, opts = {}) {
  const c = cfg(env);
  const out = { enabled: c.on, dry: Boolean(opts.dry), due: [], drafted: [], stopped: [], restarted: [], errors: [] };
  if (!c.on) return out;
  const dow = new Date().getUTCDay();
  if (c.skipWeekends && (dow === 0 || dow === 6) && !opts.force) return { ...out, skipped: "weekend" };

  const now = Date.now();
  const list = await env.HANDOFF_KV.list({ prefix: "fuseq:" });
  const due = list.keys.filter((k) => k.metadata?.s === "active" && !k.metadata?.p && (k.metadata?.d || 0) <= now + DUE_SLACK_MS)
    .sort((a, b) => (a.metadata.d || 0) - (b.metadata.d || 0)).slice(0, BATCH_MAX);
  out.due = due.map((k) => k.name.slice(6));
  if (opts.dry) return out;

  let posted = 0;
  let header = false;
  for (const k of due) {
    const seq = await loadSeq(env, k.name.slice(6));
    if (!seq || seq.status !== "active" || seq.pending) continue;
    try {
      const thread = await threadState(env, seq);
      if (thread.leadAfter) {
        // Normally the reply webhook already stopped it; this catches a missed webhook.
        if (seq.step > 0) await logFu(env, "reply", seq);
        seq.status = "stopped"; seq.stop_reason = "lead replied";
        await saveSeq(env, seq); out.stopped.push(seq.lead_email); continue;
      }
      if (thread.oursAfter) {
        // A teammate wrote by hand: no bump on top of it, the clock restarts from their message.
        seq.last_our_at = when(thread.oursAfter); seq.due_at = seq.last_our_at + c.gapMs;
        await saveSeq(env, seq); out.restarted.push(seq.lead_email); continue;
      }
      const n = seq.step + 1;
      const ai = await draftFollowup(env, deps, seq, n, thread);
      if (ai.action === "NO_REPLY") {
        seq.status = "stopped"; seq.stop_reason = `AI: ${ai.note || "should not follow up"}`;
        await saveSeq(env, seq); await logFu(env, "stopped", seq, { r: "ai" }); out.stopped.push(seq.lead_email); continue;
      }
      if (!header) {
        header = true;
        await postToChannel(env, deps, { text: `Follow-ups for today: ${due.length} lead${due.length === 1 ? "" : "s"} went quiet. Review the cards below.` }).catch(() => {});
      }
      const ourLast = [...thread.messages].reverse().find((m) => m.from_us);
      const leadLast = [...thread.messages].reverse().find((m) => !m.from_us);
      const rec = {
        kind: "followup",
        email_id: `fu:${seq.lead_email}:${n}:${now}`,
        status: "pending",
        seq_email: seq.lead_email,
        step: n,
        steps: c.steps,
        lead_name: seq.lead_name,
        lead_email: seq.lead_email,
        campaign_name: seq.campaign_name,
        brand: ai.brand,
        lead_last_at: leadLast?.at || seq.lead_last_at,
        lead_last_text: leadLast?.text || seq.lead_last_text,
        our_last_text: ourLast?.text || "",
        draft: ai.draft,
        note: ai.note,
        warnings: ai.warnings,
        thread_link: seq.thread_channel && seq.thread_ts ? await deps.permalink(env, seq.thread_channel, seq.thread_ts).catch(() => "") : "",
        unibox_url: seq.unibox_url || "",
        created_at: Date.now(),
      };
      const msg = await postToChannel(env, deps, { text: `Follow-up ${n} of ${c.steps}: ${seq.lead_name}`, blocks: cardBlocks(rec, deps), unfurl_links: false });
      rec.channel = msg.channel; rec.ts = msg.ts;
      await deps.saveDraft(env, rec);
      seq.pending = rec.email_id; seq.pending_since = Date.now(); seq.reminded = false;
      await saveSeq(env, seq);
      posted++;
      out.drafted.push(`${seq.lead_email} (#${n})`);
    } catch (err) {
      out.errors.push(`${seq.lead_email}: ${err.message}`);
    }
  }
  return out;
}

// Every 15 minutes: remind about cards waiting 24h, expire cards waiting 48h.
export async function followupReminders(env, deps) {
  if (!cfg(env).on) return;
  const now = Date.now();
  const list = await env.HANDOFF_KV.list({ prefix: "fuseq:" });
  for (const k of list.keys) {
    const m = k.metadata || {};
    if (m.s !== "active" || !m.p) continue;
    const age = now - m.p;
    if (age < REMIND_MS || (age < EXPIRE_MS && m.r)) continue;
    const seq = await loadSeq(env, k.name.slice(6));
    if (!seq?.pending) continue;
    const card = await deps.loadDraft(env, seq.pending).catch(() => null);
    if (age >= EXPIRE_MS) {
      seq.status = "stopped"; seq.stop_reason = "card waited over 48h";
      const id = seq.pending; seq.pending = null; seq.pending_since = 0;
      await saveSeq(env, seq);
      await logFu(env, "stopped", seq, { r: "expired" });
      await closeCard(env, deps, id, "Expired: this follow-up waited over 48 hours, so the sequence stopped. Reply from Unibox if still needed.", "expired").catch(() => {});
    } else if (card?.channel) {
      const who = String(env.SLACK_APPROVERS || "").split(",").map((s) => s.trim()).filter(Boolean).map((u) => `<@${u}>`).join(" ");
      await deps.slackPost(env, card.channel, { thread_ts: card.ts, text: `${who} this follow-up for ${seq.lead_name} has waited 24 hours. It expires in 24 hours.` }).catch(() => {});
      seq.reminded = true;
      await saveSeq(env, seq);
    }
  }
}

/* ---------- buttons ---------- */

function editModal(rec) {
  const pt = (t) => ({ type: "plain_text", text: String(t).slice(0, 75) });
  return {
    type: "modal", callback_id: "fu_edit_modal", private_metadata: rec.email_id,
    title: pt(`Edit follow-up ${rec.step}`), submit: pt("Send"), close: pt("Cancel"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `To *${String(rec.lead_email).replace(/[<>&]/g, "")}*, in the same email thread.` } },
      { type: "input", block_id: "body", label: pt("Follow-up"), element: { type: "plain_text_input", action_id: "text", multiline: true, initial_value: String(rec.draft || "").slice(0, 2900) } },
    ],
  };
}

export async function handleFollowupAction(env, ctx, deps, payload, action, userId) {
  const rec = await deps.loadDraft(env, action.value);
  if (!rec) {
    ctx.waitUntil(deps.ephemeral(payload.response_url, "This follow-up was not found (older than 7 days?)."));
    return new Response("");
  }
  if (rec.status !== "pending") {
    ctx.waitUntil(deps.ephemeral(payload.response_url, `Already ${rec.status}${rec.acted_by ? ` by <@${rec.acted_by}>` : ""}.`));
    return new Response("");
  }
  if (action.action_id === "fu_edit") {
    await deps.slackApi(env, "views.open", { trigger_id: payload.trigger_id, view: editModal(rec) });
    return new Response("");
  }
  if (action.action_id === "fu_approve") ctx.waitUntil(sendFollowup(env, deps, rec, rec.draft, userId, payload.response_url, false));
  if (action.action_id === "fu_skip") ctx.waitUntil(skipOrStop(env, deps, rec, userId, "skip"));
  if (action.action_id === "fu_stop") ctx.waitUntil(skipOrStop(env, deps, rec, userId, "stop"));
  return new Response("");
}

export async function handleFollowupView(env, ctx, deps, payload, userId) {
  const view = payload.view || {};
  const rec = await deps.loadDraft(env, view.private_metadata);
  if (!rec) return Response.json({ response_action: "errors", errors: { body: "Follow-up not found." } });
  const text = String(view.state?.values?.body?.text?.value || "").trim();
  if (!text) return Response.json({ response_action: "errors", errors: { body: "Follow-up cannot be empty." } });
  ctx.waitUntil(sendFollowup(env, deps, rec, text, userId, null, true));
  return Response.json({ response_action: "clear" });
}

async function tell(env, deps, rec, responseUrl, userId, text) {
  if (responseUrl) return deps.ephemeral(responseUrl, text).catch(() => {});
  if (rec.channel) return deps.slackPost(env, rec.channel, { thread_ts: rec.ts, text: `<@${userId}> ${text}` }).catch(() => {});
}

async function skipOrStop(env, deps, rec, userId, what) {
  const c = cfg(env);
  const lock = await deps.swapDraft(env, rec.email_id, "pending", (r) => ({ ...r, status: what === "skip" ? "skipped" : "stopped", acted_by: userId, acted_at: Date.now() }));
  if (!lock.ok) return;
  const seq = await loadSeq(env, rec.seq_email);
  if (seq && seq.pending === rec.email_id) {
    seq.pending = null; seq.pending_since = 0;
    if (what === "stop") {
      seq.status = "stopped"; seq.stop_reason = `stopped by ${userId}`;
    } else {
      seq.step = rec.step;
      seq.history.push({ step: rec.step, skipped: true, at: Date.now() });
      seq.due_at = Date.now() + c.gapMs;
      if (seq.step >= c.steps) seq.status = "done";
    }
    await saveSeq(env, seq);
    await logFu(env, what === "skip" ? "skipped" : "stopped", { ...seq, step: rec.step }, { r: what === "stop" ? "button" : "" });
  }
  await updateCard(env, deps, lock.current, what === "skip"
    ? `Skipped by <@${userId}>.${rec.step >= c.steps ? " That was the last step." : ` Follow-up ${rec.step + 1} comes in the next batch.`}`
    : `Follow-ups stopped by <@${userId}>. Nothing more goes to this lead.`);
}

async function sendFollowup(env, deps, rec, rawText, userId, responseUrl, edited) {
  const c = cfg(env);
  const text = deps.cleanCalendlyLinks(rawText);
  const lock = await deps.swapDraft(env, rec.email_id, "pending", (r) => ({ ...r, status: "sending", acted_by: userId, acted_at: Date.now() }));
  if (!lock.ok) return tell(env, deps, rec, responseUrl, userId, `Already ${lock.current?.status || "closed"}. Nothing sent.`);
  const card = lock.current;
  const seq = await loadSeq(env, card.seq_email);
  const release = async (status, line) => {
    card.status = status;
    await deps.saveDraft(env, card);
    await updateCard(env, deps, card, line).catch(() => {});
  };
  if (!seq || seq.status !== "active" || seq.pending !== card.email_id) {
    await release("closed", "Closed: this lead's follow-ups were stopped or restarted. Nothing sent.");
    return tell(env, deps, card, responseUrl, userId, "Not sent: the sequence for this lead is no longer running.");
  }

  // Last check: did the lead or a teammate write since our last message?
  let thread = null;
  try { thread = await threadState(env, seq); } catch (err) { console.warn(`Follow-up thread check skipped: ${err.message}`); }
  if (thread?.leadAfter) {
    seq.status = "stopped"; seq.stop_reason = "lead replied"; seq.pending = null; seq.pending_since = 0;
    if (seq.step > 0) await logFu(env, "reply", seq);
    await saveSeq(env, seq);
    await release("closed", `Not sent: ${deps.esc(seq.lead_name)} replied ${deps.slackTime(when(thread.leadAfter))}. Clicked by <@${userId}>.`);
    return tell(env, deps, card, responseUrl, userId, "Not sent: the lead replied, so the follow-ups stopped.");
  }
  if (thread?.oursAfter) {
    seq.last_our_at = when(thread.oursAfter); seq.due_at = seq.last_our_at + c.gapMs; seq.pending = null; seq.pending_since = 0;
    await saveSeq(env, seq);
    await release("closed", `Not sent: someone on the team wrote ${deps.slackTime(seq.last_our_at)}. The follow-up clock restarted from that message.`);
    return tell(env, deps, card, responseUrl, userId, "Not sent: a teammate already wrote in this thread.");
  }

  const res = await fetch(`${INSTANTLY}/emails/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      reply_to_uuid: seq.reply_uuid,
      eaccount: seq.eaccount,
      subject: seq.subject,
      body: { text: deps.textWithLinks(text, []), html: deps.textToHtml(text, []) },
    }),
  });
  if (!res.ok) {
    const err = (await res.text()).slice(0, 300);
    card.status = "pending"; card.acted_by = null;
    await deps.saveDraft(env, card);
    return deps.slackPost(env, card.channel, { thread_ts: card.ts, text: `Send FAILED (Instantly ${res.status}): ${err}. The follow-up is still pending.` }).catch(() => {});
  }

  const sentAt = Date.now();
  card.status = "sent"; card.sent_text = text; card.sent_at = sentAt;
  card.edited = Boolean(edited && text.trim() !== String(card.draft || "").trim());
  await deps.saveDraft(env, card);
  seq.step = card.step;
  seq.history.push({ step: card.step, sent: true, text, at: sentAt, by: userId });
  seq.last_our_at = sentAt; seq.due_at = sentAt + c.gapMs; seq.pending = null; seq.pending_since = 0;
  if (seq.step >= c.steps) { seq.status = "done"; seq.stop_reason = `all ${c.steps} follow-ups sent`; }
  await saveSeq(env, seq);
  await logFu(env, "sent", seq, { ed: card.edited ? 1 : 0 });
  await updateCard(env, deps, card, `Sent${card.edited ? " (edited)" : ""} by <@${userId}> ${deps.slackTime(sentAt)}${seq.status === "done" ? " · last follow-up, sequence done" : ` · next one in ${Math.round(c.gapMs / 3600e3)}h if no reply`}`);
  if (seq.thread_channel && seq.thread_ts) {
    await deps.slackPost(env, seq.thread_channel, { thread_ts: seq.thread_ts, text: `Follow-up ${card.step} of ${c.steps} sent by <@${userId}>.` }).catch(() => {});
  }
}

/* ---------- backfill: replies sent before follow-ups existed ---------- */

// Reads the reply-card log (log:<day>:<email id>, written for the weekly report) and starts a sequence for
// every reply we sent (or answered in Unibox) in the last `days` days, unless the lead already has one.
// Leads who replied since are caught by the batch's thread check and stopped before any card is drafted.
export async function backfillSequences(env, deps, opts = {}) {
  const days = Math.min(Math.max(Number(opts.days) || 5, 1), 14);
  const out = { dry: Boolean(opts.dry), days, started: [], skipped: [] };
  const now = Date.now();
  for (let i = 0; i <= days; i++) {
    const list = await env.HANDOFF_KV.list({ prefix: `log:${day(now - i * 86400e3)}:` });
    for (const k of list.keys) {
      const m = k.metadata || {};
      const id = k.name.split(":").slice(2).join(":");
      if (!["sent", "answered_elsewhere"].includes(m.s)) continue;
      if (NEVER_FOLLOW.test(String(m.i || ""))) { out.skipped.push(`${id}: ${m.i}`); continue; }
      const rec = await deps.loadDraft(env, id).catch(() => null);
      if (!rec?.lead_email) { out.skipped.push(`${id}: draft not found`); continue; }
      const at = rec.sent_at || rec.answered_elsewhere?.at || m.t1 || rec.acted_at;
      if (!at || now - at > days * 86400e3) continue;
      const existing = await loadSeq(env, rec.lead_email);
      if (existing && existing.status === "active") { out.skipped.push(`${rec.lead_email}: already has a sequence`); continue; }
      if (existing && existing.started_at > at) { out.skipped.push(`${rec.lead_email}: newer sequence already ran`); continue; }
      if (!opts.dry) await startSequence(env, deps, rec, at, "backfill");
      out.started.push(`${rec.lead_email} (our reply ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC)`);
    }
  }
  return out;
}

/* ---------- manual links ---------- */

// /followups/run?key=RUN_SECRET[&dry=1][&force=1]   /followups/list?key=RUN_SECRET
// /followups/backfill?key=RUN_SECRET&days=5[&dry=1]
export async function handleFollowupRoute(env, url, deps) {
  if (url.searchParams.get("key") !== env.RUN_SECRET) return new Response("unauthorized", { status: 401 });
  try {
    if (url.pathname.endsWith("/backfill")) {
      return Response.json(await backfillSequences(env, deps, { days: url.searchParams.get("days"), dry: url.searchParams.get("dry") === "1" }));
    }
    if (url.pathname.endsWith("/list")) {
      const list = await env.HANDOFF_KV.list({ prefix: "fuseq:" });
      return Response.json(list.keys.map((k) => ({
        lead: k.name.slice(6), status: k.metadata?.s, step: k.metadata?.n,
        due: k.metadata?.d ? new Date(k.metadata.d).toISOString() : "", card_waiting_since: k.metadata?.p ? new Date(k.metadata.p).toISOString() : "",
      })));
    }
    return Response.json(await runFollowups(env, deps, { dry: url.searchParams.get("dry") === "1", force: url.searchParams.get("force") === "1" }));
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}