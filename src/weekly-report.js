// Weekly outbound report (Feature 4). Posted every Monday to SLACK_REPORT_CHANNEL
// (falls back to SLACK_REPLIES_CHANNEL). Read-only: it only reads Instantly analytics and our own logs.
//
// Where the numbers come from
//   Email:      Instantly  GET /campaigns/analytics  (this week and the week before, for the arrows)
//   Reply desk: one small log entry per reply card  (KV  log:<YYYY-MM-DD>:<email_id>, summary in metadata)
//               written by index.js every time a draft changes (pending, sent, rejected, ...)
//   LinkedIn:   one entry per handoff run           (KV  hlog:<YYYY-MM-DD>:<time>)
//   PodPitch:   one entry per run that posted       (KV  pplog:<YYYY-MM-DD>:<time>)
// Log entries live 60 days.

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const DAY = 24 * 3600 * 1000;
export const LOG_TTL_SECONDS = 60 * 24 * 3600;
const PENDING_EXPIRY_MS = 48 * 3600 * 1000;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;

/* ---------- writing the logs (called from index.js) ---------- */

// One entry per reply card, overwritten as its status changes. Never throws.
export async function logDraft(env, rec) {
  try {
    if (!rec?.email_id || !rec.created_at || rec.status === "processing" || rec.status === "sending") return;
    if (rec.kind === "followup") return;   // follow-ups have their own log (fulog:)
    const meta = {
      s: rec.status,
      a: rec.action || "",
      i: String(rec.intent || "").slice(0, 30),
      c: String(rec.campaign_name || "").slice(0, 70),
      b: String(rec.brand || "").slice(0, 30),
      e: rec.edited ? 1 : 0,
      t0: rec.created_at,
      t1: rec.sent_at || rec.acted_at || 0,
      u: rec.acted_by || "",
      p: (rec.podcasts || []).length,
      pt: rec.podcast_thread ? 1 : 0,
      pe: rec.podcast_error ? 1 : 0,
      w: (rec.warnings || []).length,
    };
    await env.HANDOFF_KV.put(`log:${day(rec.created_at)}:${rec.email_id}`, "1", { metadata: meta, expirationTtl: LOG_TTL_SECONDS });
  } catch (err) {
    console.warn(`Report log failed for ${rec?.email_id}: ${err.message}`);
  }
}

export async function logHandoff(env, s) {
  try {
    if (!s || s.dryRun) return;
    const now = Date.now();
    await env.HANDOFF_KV.put(`hlog:${day(now)}:${now}`, "1", {
      metadata: { m: s.moved || 0, f: s.failed || 0, n: s.skippedNoLinkedIn || 0 }, expirationTtl: LOG_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(`Handoff log failed: ${err.message}`);
  }
}

// kind: "replies" (host replies posted) or "matches" (new-match digest)
export async function logPodpitch(env, kind, report) {
  try {
    if (!report || report.dry) return;
    const posted = report.posted || [];
    const n = kind === "matches" ? posted.reduce((t, p) => t + (p.new_matches || 0), 0) : posted.length;
    if (!n) return;
    const now = Date.now();
    await env.HANDOFF_KV.put(`pplog:${day(now)}:${now}:${kind}`, "1", { metadata: { k: kind, n }, expirationTtl: LOG_TTL_SECONDS });
  } catch (err) {
    console.warn(`PodPitch log failed: ${err.message}`);
  }
}

/* ---------- building the report ---------- */

async function listMeta(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.HANDOFF_KV.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) out.push({ name: k.name, ...(k.metadata || {}) });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function logsBetween(env, base, from, to) {
  const all = [];
  for (let t = from; t < to; t += DAY) all.push(...(await listMeta(env, `${base}:${day(t)}:`)));
  return all;
}

// Cards from before the log existed (old KV drafts): read them once so the first reports are complete.
async function legacyDrafts(env, from, to, known, cap = 300) {
  const out = [];
  let cursor;
  let reads = 0;
  do {
    const page = await env.HANDOFF_KV.list({ prefix: "draft:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const id = k.name.slice(6);
      if (known.has(id) || reads >= cap) continue;
      reads++;
      const v = await env.HANDOFF_KV.get(k.name).catch(() => null);
      const r = v ? JSON.parse(v) : null;
      if (!r?.created_at || r.created_at < from || r.created_at >= to || r.status === "processing") continue;
      out.push({ name: `legacy:${id}`, s: r.status, a: r.action || "", i: r.intent || "", c: r.campaign_name || "", b: r.brand || "",
        e: r.edited ? 1 : 0, t0: r.created_at, t1: r.sent_at || 0, u: r.acted_by || "", p: (r.podcasts || []).length,
        pt: r.podcast_thread ? 1 : 0, pe: r.podcast_error ? 1 : 0, w: (r.warnings || []).length });
    }
    cursor = page.list_complete || reads >= cap ? null : page.cursor;
  } while (cursor);
  return out;
}

async function instantlyAnalytics(env, from, to) {
  const qs = new URLSearchParams({ start_date: day(from), end_date: day(to - DAY) });
  const res = await fetch(`${INSTANTLY_BASE}/campaigns/analytics?${qs}`, { headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` } });
  if (!res.ok) throw new Error(`Instantly analytics ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.items || data.result || [];
}

const sum = (rows, f) => rows.reduce((t, r) => t + (Number(r[f]) || 0), 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "–");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const pl = (x, one, many = `${one}s`) => `${n(x)} ${Number(x) === 1 ? one : many}`;
function arrow(now, before) {
  if (!before && !now) return "";
  if (!before) return " (new)";
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? " (same as last week)" : ` (${d > 0 ? "▲" : "▼"}${Math.abs(d)}% vs last week)`;
}
function countBy(rows, f) {
  const m = new Map();
  for (const r of rows) { const k = r[f] || "unknown"; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function duration(ms) {
  if (!ms) return "–";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
const range = (from, to) => {
  const f = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(from)} – ${f(to - DAY)}`;
};

export async function buildWeeklyReport(env, opts = {}) {
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), 28);
  const to = startOfDay(Date.now());
  const from = to - days * DAY;
  const prevFrom = from - days * DAY;
  const errors = [];

  // Email (Instantly)
  let rows = [];
  let prevRows = [];
  try {
    [rows, prevRows] = await Promise.all([instantlyAnalytics(env, from, to), instantlyAnalytics(env, prevFrom, from)]);
  } catch (err) {
    errors.push(err.message);
  }
  const email = {
    sent: sum(rows, "emails_sent_count"), prevSent: sum(prevRows, "emails_sent_count"),
    newLeads: sum(rows, "new_leads_contacted_count"),
    replied: sum(rows, "reply_count_unique"), prevReplied: sum(prevRows, "reply_count_unique"),
    auto: sum(rows, "reply_count_automatic_unique"),
    opps: sum(rows, "total_opportunities"), prevOpps: sum(prevRows, "total_opportunities"),
    oppValue: sum(rows, "total_opportunity_value"),
    bounced: sum(rows, "bounced_count"),
    campaigns: rows.filter((r) => r.emails_sent_count || r.reply_count).sort((a, b) => b.emails_sent_count - a.emails_sent_count),
  };

  // Reply desk
  const cards = await logsBetween(env, "log", from, to);
  const prevCards = await logsBetween(env, "log", prevFrom, from);
  if (opts.legacy !== false) {
    const known = new Set([...cards, ...prevCards].map((c) => c.name.split(":").pop()));
    cards.push(...(await legacyDrafts(env, from, to, known).catch((e) => { errors.push(`old drafts: ${e.message}`); return []; })));
  }
  const now = Date.now();
  const st = (s) => cards.filter((c) => c.s === s);
  const sent = st("sent");
  const desk = {
    total: cards.length, prevTotal: prevCards.length,
    drafted: cards.filter((c) => c.a === "DRAFT").length,
    escalated: cards.filter((c) => c.a === "ESCALATE").length,
    noReply: cards.filter((c) => c.a === "NO_REPLY" || c.s === "no_reply").length,
    sent: sent.length,
    sentAsIs: sent.filter((c) => !c.e).length,
    sentEdited: sent.filter((c) => c.e).length,
    rejected: st("rejected").length,
    handled: st("handled").length,
    elsewhere: st("answered_elsewhere").length,
    waiting: cards.filter((c) => c.s === "pending" && now - c.t0 <= PENDING_EXPIRY_MS).length,
    expired: cards.filter((c) => c.s === "pending" && now - c.t0 > PENDING_EXPIRY_MS).length,
    medianToSend: median(sent.filter((c) => c.t1 > c.t0).map((c) => c.t1 - c.t0)),
    warnings: cards.filter((c) => c.w).length,
    intents: countBy(cards, "i").slice(0, 5),
    brands: countBy(cards, "b"),
    campaigns: countBy(cards, "c"),
    people: countBy(sent.filter((c) => c.u), "u"),
    podThreads: cards.filter((c) => c.pt).length,
    podWithShows: cards.filter((c) => c.p > 0).length,
    podErrors: cards.filter((c) => c.pe).length,
  };

  // LinkedIn + PodPitch
  const hl = await logsBetween(env, "hlog", from, to);
  const linkedin = { runs: hl.length, moved: sum(hl, "m"), failed: sum(hl, "f"), noLinkedIn: sum(hl, "n") };
  const pp = await logsBetween(env, "pplog", from, to);
  const podpitch = {
    hostReplies: sum(pp.filter((x) => x.k === "replies"), "n"),
    newMatches: sum(pp.filter((x) => x.k === "matches"), "n"),
  };

  // Follow-ups (fulog: written by followups.js)
  const fl = await logsBetween(env, "fulog", from, to);
  const ev = (e) => fl.filter((x) => x.e === e);
  const followups = {
    started: ev("started").length,
    sent: ev("sent").length,
    edited: ev("sent").filter((x) => x.ed).length,
    skipped: ev("skipped").length,
    stopped: ev("stopped").length,
    expired: ev("stopped").filter((x) => x.r === "expired").length,
    repliesByStep: [1, 2, 3, 4, 5, 6].map((k) => ev("reply").filter((x) => x.n === k).length),
  };

  return { from, to, days, range: range(from, to), email, desk, linkedin, podpitch, followups, errors };
}

/* ---------- Slack message ---------- */

export function reportBlocks(r, esc) {
  const e = r.email;
  const d = r.desk;
  const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: String(text).slice(0, 2990) } });
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Weekly outbound report · ${r.range}`, emoji: false } },
  ];

  // Email
  const camp = e.campaigns.slice(0, 8).map((c) =>
    `• ${esc(c.campaign_name)}: ${n(c.emails_sent_count)} sent · ${n(c.reply_count_unique)} replied · ${n(c.total_opportunities)} opp. · bounce ${pct(c.bounced_count, c.emails_sent_count)}`);
  blocks.push(section(
    `*Email (Instantly)*\n` +
    `${n(e.sent)} emails sent${arrow(e.sent, e.prevSent)} · ${n(e.newLeads)} new leads contacted\n` +
    `${n(e.replied)} leads replied${arrow(e.replied, e.prevReplied)}${e.auto ? ` (${n(e.auto)} automatic replies)` : ""} · reply rate ${pct(e.replied, e.newLeads)}\n` +
    `${n(e.opps)} opportunities${arrow(e.opps, e.prevOpps)}${e.oppValue ? ` · $${n(e.oppValue)} pipeline value` : ""} · bounce rate ${pct(e.bounced, e.sent)}` +
    (camp.length ? `\n${camp.join("\n")}` : "")));

  // Reply desk
  const outcome = [
    `${d.sent} sent (${d.sentAsIs} as written, ${d.sentEdited} edited)`,
    d.elsewhere && `${d.elsewhere} answered in Unibox`,
    d.handled && `${d.handled} marked handled`,
    d.rejected && `${d.rejected} rejected`,
    d.waiting && `${d.waiting} still waiting`,
    d.expired && `${d.expired} never answered (over 48h)`,
  ].filter(Boolean).join(" · ");
  blocks.push(section(
    `*Reply desk (Slack cards)*\n` +
    `${pl(d.total, "reply", "replies")} came in${arrow(d.total, d.prevTotal)}: ${d.drafted} drafted · ${d.escalated} needed a human · ${d.noReply} no reply needed\n` +
    `${outcome}\n` +
    `Drafts sent as written: ${pct(d.sentAsIs, d.sent)} · median time to send: ${duration(d.medianToSend)}` +
    (d.intents.length ? `\nTop intents: ${d.intents.map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}` : "") +
    (d.brands.length > 1 ? `\nBy company: ${d.brands.map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}` : "") +
    (d.people.length ? `\nSent by: ${d.people.map(([u, v]) => `<@${u}> ${v}`).join(" · ")}` : "")));

  // Podcasts + LinkedIn
  blocks.push(section(
    `*Podcasts (PodPitch)*\n` +
    `${pl(d.podThreads, "podcast reply", "podcast replies")} · ${pl(d.podWithShows, "draft")} with real show picks${d.podErrors ? ` · PodPitch did not answer ${pl(d.podErrors, "time")}` : ""}\n` +
    `${pl(r.podpitch.hostReplies, "host reply", "host replies")} posted for clients · ${pl(r.podpitch.newMatches, "new podcast match", "new podcast matches")}`));
  blocks.push(section(
    `*LinkedIn (Aimfox)*\n` +
    (r.linkedin.runs
      ? `${n(r.linkedin.moved)} leads moved to Aimfox · ${r.linkedin.failed} failed · ${r.linkedin.noLinkedIn} had no LinkedIn (${pl(r.linkedin.runs, "daily run")})`
      : "No handoff runs logged this week.")));

  const f = r.followups || { started: 0, sent: 0, repliesByStep: [] };
  if (f.started || f.sent) {
    const replies = f.repliesByStep.map((v, i) => (v ? `after #${i + 1}: ${v}` : "")).filter(Boolean).join(" · ");
    blocks.push(section(
      `*Follow-ups*\n` +
      `${pl(f.started, "sequence")} started · ${pl(f.sent, "follow-up")} sent (${f.edited} edited) · ${f.skipped} skipped · ${f.stopped} stopped${f.expired ? ` (${f.expired} expired unapproved)` : ""}\n` +
      `Lead replies after a follow-up: ${replies || "none yet"}`));
  }

  // Worth a look
  const flags = [];
  for (const c of e.campaigns) {
    if (c.emails_sent_count >= 200 && c.bounced_count / c.emails_sent_count > 0.03) {
      flags.push(`${esc(c.campaign_name)} bounce rate is ${pct(c.bounced_count, c.emails_sent_count)} (keep it under 3%): clean the list or check the inboxes.`);
    }
  }
  if (d.expired) flags.push(`${d.expired} reply card${d.expired > 1 ? "s were" : " was"} never answered within 48 hours.`);
  if (d.sent >= 5 && d.sentEdited / d.sent > 0.5) flags.push(`More than half of sent drafts were edited first: check #outbound-edits for patterns to add to the guidance.`);
  if (d.podErrors >= 3) flags.push(`PodPitch did not answer ${d.podErrors} times, so those drafts had no show picks.`);
  if (e.sent && e.prevSent && e.sent < e.prevSent * 0.6) flags.push(`Sending dropped ${Math.round((1 - e.sent / e.prevSent) * 100)}% from last week: check campaign status and inbox health.`);
  if (f.expired) flags.push(`${pl(f.expired, "follow-up card")} expired without approval: check #tpx-followups daily.`);
  if (r.linkedin.failed) flags.push(`${r.linkedin.failed} LinkedIn handoffs failed: see #aimfox-updates.`);
  if (flags.length) blocks.push(section(`*Worth a look*\n${flags.map((f) => `• ${f}`).join("\n")}`));
  if (r.errors.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Some numbers are missing: ${esc(r.errors.join("; ")).slice(0, 400)}` }] });
  return blocks;
}

export async function runWeeklyReport(env, deps, opts = {}) {
  const r = await buildWeeklyReport(env, opts);
  let channel = env.SLACK_REPORT_CHANNEL || env.SLACK_REPLIES_CHANNEL;
  let note = "";
  if (!opts.dry) {
    const msg = {
      text: `Weekly outbound report ${r.range}: ${r.email.sent} sent, ${r.email.replied} replied, ${r.desk.sent} replies sent from Slack`,
      blocks: reportBlocks(r, deps.esc),
      unfurl_links: false,
    };
    try {
      await deps.slackPost(env, channel, msg);
    } catch (err) {
      // Wrong ID, or a private channel the bot was never invited to: post in the replies channel instead.
      const fallback = env.SLACK_REPLIES_CHANNEL;
      if (!/channel_not_found|not_in_channel|is_archived/.test(err.message) || !fallback || fallback === channel) {
        throw new Error(`${err.message} (channel ${channel})`);
      }
      note = `SLACK_REPORT_CHANNEL ${channel} failed (${err.message.replace(/^Slack chat\.postMessage: /, "")}): invite the bot there or fix the ID. Posted in the replies channel instead.`;
      msg.blocks = [...msg.blocks, { type: "context", elements: [{ type: "mrkdwn", text: deps.esc(note) }] }];
      await deps.slackPost(env, fallback, msg);
      channel = fallback;
    }
  }
  return { posted: !opts.dry, channel, note, ...r };
}