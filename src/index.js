// TPX outbound worker (Cloudflare Workers, JavaScript)
//
// 1. LinkedIn handoff (cron, daily 05:00 UTC + manual /run):
//    Instantly leads that finished a sequence with no reply -> Aimfox campaign targets.
// 2. Slack reply approval:
//    Instantly reply_received webhook -> Claude drafts a reply -> Slack card with
//    [Approve & send] [Edit] [Reject] -> on approval the worker sends it via the Instantly API
//    from the same inbox, in the same thread. Nothing is ever sent without a click.
// 4. PodPitch client updates (cron every 15 min + daily digest): host replies and new matches
//    from PodPitch -> #podpitch-clients-updates. Read-only PodPitch login (secret PODPITCH_OAUTH).
// 3. Lead research (ON HOLD; needs the REPLY_QUEUE binding, Workers Paid): before drafting, reads the lead's
//    website and runs an AI visibility check (Claude web search). One website detail may be used
//    in the draft; the visibility result is shown on the Slack card only.
//
// Routes
//   GET  /                       health check
//   GET  /run?key=RUN_SECRET     manual LinkedIn handoff (&dry=1 to preview)
//   GET  /aimfox/campaigns?key=RUN_SECRET   all Instantly + Aimfox campaign IDs and the current mapping
//   POST /instantly/reply?key=INSTANTLY_WEBHOOK_SECRET   Instantly webhook (event: reply_received)
//   POST /slack/interact         Slack interactivity (buttons + modals)
//   GET  /podpitch/run?key=RUN_SECRET[&dry=1][&since_hours=48]   PodPitch host replies now
//   GET  /podpitch/digest?key=RUN_SECRET[&dry=1]                 PodPitch new-matches digest now
//
// Secrets (npx wrangler secret put NAME):
//   INSTANTLY_API_KEY, AIMFOX_API_KEY, RUN_SECRET, SLACK_WEBHOOK_URL,
//   ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, INSTANTLY_WEBHOOK_SECRET
// Vars (wrangler.jsonc): CAMPAIGN_MAP, CLAUDE_MODEL, CALENDLY_URL, SLACK_APPROVERS,
//   SLACK_REPLIES_CHANNEL, SLACK_ESCALATIONS_CHANNEL, SLACK_EDITS_CHANNEL, PODPITCH_MCP_URL,
//   QUERY_MODEL, RESEARCH_ENABLED ("true"/"false"), RESEARCH_MODEL (optional)
// Secrets also: PODPITCH_OAUTH (PodPitch login for client updates); PODPITCH_API_KEY optional
// KV: HANDOFF_KV (handoff done-markers, drafts, lead threads, research cache)
// Queue: REPLY_QUEUE (producer + consumer "tpx-replies"); without it replies run inline as before

import { buildSystemPrompt, cleanCalendlyLinks, calendlyFor, brandFor } from './prompt.js';
export { PodpitchAuth } from './podpitch-auth.js';
import { isPodcastThread, findPodcastCandidates, addListenLinks } from './podpitch.js';
import { researchLead, shouldResearch } from './research.js';
import { runPodpitchUpdates, runPodpitchDigest } from './podpitch-updates.js';

const PODPITCH_POLL_CRON = '*/15 * * * *'; // host replies
const PODPITCH_DIGEST_CRON = '30 12 * * *'; // 12:30 UTC = 5:30 PM PKT, new matches digest

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const AIMFOX_BASE = 'https://api.aimfox.com/api/v3';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SLACK_API = 'https://slack.com/api';

const AIMFOX_DELAY_MS = 1100; // Aimfox: 60 requests/minute
const AIMFOX_BATCH = 25; // profiles per Aimfox request
const PAGE_SIZE = 100; // Instantly leads/list max page size
const MAX_PER_RUN = 300; // LinkedIn handoff safety cap per run
const DRAFT_TTL_SECONDS = 7 * 24 * 3600; // drafts kept 7 days in KV
const LEAD_THREAD_TTL_SECONDS = 180 * 24 * 3600; // one Slack thread per lead, remembered 180 days
const DRAFT_EXPIRY_MS = 48 * 3600 * 1000; // approve buttons stop working after 48h
const SLACK_MAX_AGE_SECONDS = 300; // reject Slack requests older than 5 minutes (replay protection)
const CLAUDE_RETRY_DELAYS_MS = [2000, 5000]; // 2 retries; total stays inside the ~30s background limit

export default {
	// Queue consumer: each message is one Instantly reply (or a Slack "Retry draft").
	// runDraft never throws (it posts a failure card with a Retry button), so every message is acked.
	async queue(batch, env) {
		for (const msg of batch.messages) {
			const { event, colo, retriedBy } = msg.body || {};
			if (event?.email_id) await runDraft(env, event, colo || 'queue', retriedBy);
			msg.ack();
		}
	},

	async scheduled(event, env, ctx) {
		if (event.cron === PODPITCH_POLL_CRON) {
			ctx.waitUntil(runPodpitchUpdates(env, { slackPost }).catch((e) => podpitchAlert(env, 'updates', e)));
			return;
		}
		if (event.cron === PODPITCH_DIGEST_CRON) {
			ctx.waitUntil(runPodpitchDigest(env, { slackPost }).catch((e) => podpitchAlert(env, 'digest', e)));
			return;
		}
		ctx.waitUntil(
			runHandoff(env).catch((e) =>
				aimfoxPost(env, `LinkedIn handoff FAILED: ${e.message}`, [
					section(`*LinkedIn handoff FAILED*\n\`${esc(e.message).slice(0, 400)}\``),
				]),
			),
		);
	},

	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		try {
			if (url.pathname === '/run') return handleRun(request, env, url);
			if (url.pathname === '/aimfox/campaigns') return handleCampaignList(env, url);
			if (url.pathname === '/podpitch/run' || url.pathname === '/podpitch/digest') return handlePodpitchRun(env, url);
			if (url.pathname === '/instantly/reply' && request.method === 'POST') return handleInstantlyReply(request, env, ctx, url);
			if (url.pathname === '/slack/interact' && request.method === 'POST') return handleSlackInteract(request, env, ctx);
			return new Response('ok');
		} catch (err) {
			console.error(err);
			return Response.json({ error: err.message }, { status: 500 });
		}
	},
};

/* =========================================================================
 * PODPITCH CLIENT UPDATES (manual run + failure alert)
 * ========================================================================= */

async function handlePodpitchRun(env, url) {
	if (url.searchParams.get('key') !== env.RUN_SECRET) return new Response('unauthorized', { status: 401 });
	const opts = { dry: url.searchParams.get('dry') === '1', sinceHours: Number(url.searchParams.get('since_hours') || 0) };
	try {
		const fn = url.pathname.endsWith('/digest') ? runPodpitchDigest : runPodpitchUpdates;
		return Response.json(await fn(env, { slackPost }, opts));
	} catch (err) {
		return Response.json({ error: err.message }, { status: 500 });
	}
}

// Alerts in #outbound-escalations, without spam:
//  * login problems: right away (a person must run podpitch-login.mjs again)
//  * temporary problems (PodPitch slow or down): only after 3 failed runs in a row (~45 min)
//  * at most one alert per 6 hours
async function podpitchAlert(env, what, err) {
	console.error(`PodPitch ${what} failed: ${err.message}`);
	const login = /login|PODPITCH_OAUTH|401/i.test(err.message);
	const fails = Number((await env.HANDOFF_KV.get('pp:fails')) || 0) + 1;
	await env.HANDOFF_KV.put('pp:fails', String(fails), { expirationTtl: 24 * 3600 });
	if (!login && fails < 3) return;
	if (await env.HANDOFF_KV.get('pp:alerted')) return;
	await env.HANDOFF_KV.put('pp:alerted', '1', { expirationTtl: 6 * 3600 });
	const action = login
		? 'Action needed: run `node podpitch-login.mjs` again, then update the PODPITCH_OAUTH secret.'
		: `Failed ${fails} runs in a row. It keeps retrying every 15 minutes; nothing is lost, missed replies post once PodPitch responds.`;
	await slackPost(env, env.SLACK_ESCALATIONS_CHANNEL, {
		text: `PodPitch ${what} failed: ${err.message}`,
		blocks: [section(`*PodPitch ${what} failed*\n\`${esc(err.message).slice(0, 400)}\`\n${action}`)],
	}).catch(() => {});
}

/* =========================================================================
 * 1. LINKEDIN HANDOFF -> Aimfox  (report in #aimfox-updates)
 * ========================================================================= */

async function handleRun(request, env, url) {
	if (url.searchParams.get('key') !== env.RUN_SECRET) return new Response('unauthorized', { status: 401 });
	try {
		return Response.json(await runHandoff(env, url.searchParams.get('dry') === '1'));
	} catch (err) {
		await aimfoxPost(env, `LinkedIn handoff FAILED: ${err.message}`, [
			section(`*LinkedIn handoff FAILED*\n\`${esc(err.message).slice(0, 400)}\``),
		]);
		return Response.json({ error: err.message }, { status: 500 });
	}
}

async function runHandoff(env, dryRun = false) {
	const map = JSON.parse(env.CAMPAIGN_MAP || '{}');
	const summary = { dryRun, moved: 0, failed: 0, skippedNoLinkedIn: 0, alreadyDone: 0, campaigns: [], details: [] };
	const aimfoxNames = await aimfoxCampaignNames(env);

	for (const [instantlyCampaign, aimfoxCampaign] of Object.entries(map)) {
		const camp = {
			instantly_id: instantlyCampaign,
			instantly_name: await instantlyCampaignName(env, instantlyCampaign),
			aimfox_id: aimfoxCampaign,
			aimfox_name: aimfoxNames[aimfoxCampaign] || aimfoxCampaign,
			moved: [],
			failed: [],
			noLinkedIn: [],
			alreadyDone: 0,
		};
		summary.campaigns.push(camp);
		let cursor;
		let queue = [];
		do {
			const page = await listCompletedNoReply(env, instantlyCampaign, cursor);
			for (const lead of page.items || []) {
				if (summary.moved + queue.length >= MAX_PER_RUN) break;
				if (await env.HANDOFF_KV.get(`done:${lead.id}`)) {
					summary.alreadyDone++;
					camp.alreadyDone++;
					continue;
				}
				const p = lead.payload || {};
				const profileUrl = cleanLinkedIn(p.linkedIn || p.linkedin || p.LinkedIn);
				if (!profileUrl) {
					summary.skippedNoLinkedIn++;
					camp.noLinkedIn.push(leadLabel(lead));
					continue;
				}
				// Same person in two campaigns: add the LinkedIn profile to Aimfox only once.
				if (queue.some((q) => q.profileUrl === profileUrl) || (await env.HANDOFF_KV.get(`doneurl:${profileUrl}`))) {
					summary.alreadyDone++;
					camp.alreadyDone++;
					continue;
				}
				queue.push({ lead, profileUrl });
				if (queue.length >= AIMFOX_BATCH) {
					await flushHandoff(env, aimfoxCampaign, queue, summary, camp, dryRun);
					queue = [];
				}
			}
			cursor = page.next_starting_after;
		} while (cursor && summary.moved + queue.length < MAX_PER_RUN);
		if (queue.length) await flushHandoff(env, aimfoxCampaign, queue, summary, camp, dryRun);
	}

	await postHandoffReport(env, summary);
	return summary;
}

const leadLabel = (lead) => {
	const p = lead.payload || {};
	const name = [lead.first_name || p.firstName, lead.last_name || p.lastName].filter(Boolean).join(' ');
	const company = lead.company_name || p.companyName || '';
	return `${name || lead.email}${company ? ` (${company})` : ''}`;
};

async function flushHandoff(env, aimfoxCampaign, batch, summary, camp, dryRun) {
	if (dryRun) {
		for (const { lead, profileUrl } of batch) camp.moved.push({ label: leadLabel(lead), email: lead.email, url: profileUrl });
		summary.moved += batch.length;
		return;
	}
	const res = await fetch(`${AIMFOX_BASE}/campaigns/${aimfoxCampaign}/targets`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.AIMFOX_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			type: 'profile_url',
			profiles: batch.map(({ lead, profileUrl }) => ({
				profile_url: profileUrl,
				custom_variables: {
					first_name: lead.first_name || lead.payload?.firstName || '',
					company: lead.company_name || lead.payload?.companyName || '',
				},
			})),
		}),
	});
	if (!res.ok) {
		const err = `Aimfox ${res.status}: ${(await res.text()).slice(0, 200)}`;
		summary.failed += batch.length;
		summary.details.push(err);
		for (const { lead } of batch) camp.failed.push(`${leadLabel(lead)}: ${err}`);
		await sleep(AIMFOX_DELAY_MS);
		return;
	}
	const data = await res.json().catch(() => ({}));
	const failedSet = new Set(
		(data.failed || []).map((f) => cleanLinkedIn(typeof f === 'string' ? f : f?.profile_url || f?.profile) || String(f)),
	);
	for (const { lead, profileUrl } of batch) {
		if (failedSet.has(profileUrl)) {
			summary.failed++;
			camp.failed.push(`${leadLabel(lead)}: Aimfox rejected the profile`);
			continue;
		}
		await env.HANDOFF_KV.put(
			`done:${lead.id}`,
			JSON.stringify({ email: lead.email, profileUrl, aimfoxCampaign, at: new Date().toISOString() }),
		);
		await env.HANDOFF_KV.put(`doneurl:${profileUrl}`, lead.id);
		camp.moved.push({ label: leadLabel(lead), email: lead.email, url: profileUrl });
		summary.moved++;
	}
	await sleep(AIMFOX_DELAY_MS);
}

// Daily report: totals, then per campaign who moved to LinkedIn, who failed and who has no LinkedIn URL.
async function postHandoffReport(env, s) {
	const title =
		`*LinkedIn handoff${s.dryRun ? ' (dry run, nothing sent to Aimfox)' : ''}*: ` +
		`${s.moved} ${s.dryRun ? 'would move' : 'moved'} to Aimfox · ${s.failed} failed · ${s.skippedNoLinkedIn} no LinkedIn · ${s.alreadyDone} already done`;
	const blocks = [section(title)];
	if (!s.campaigns.length) blocks.push(section('No campaigns are mapped yet. Add them to CAMPAIGN_MAP in wrangler.jsonc.'));
	for (const c of s.campaigns) {
		const lines = [
			`*${esc(c.instantly_name)}* → Aimfox *${esc(c.aimfox_name)}*`,
			`${c.moved.length} ${s.dryRun ? 'would move' : 'moved'} · ${c.failed.length} failed · ${c.noLinkedIn.length} no LinkedIn · ${c.alreadyDone} already done`,
		];
		if (c.moved.length) {
			lines.push(...c.moved.slice(0, 15).map((m) => `• <${m.url}|${esc(m.label)}>`));
			if (c.moved.length > 15) lines.push(`…and ${c.moved.length - 15} more`);
		}
		if (c.failed.length)
			lines.push(`Failed: ${esc(c.failed.slice(0, 5).join('; '))}${c.failed.length > 5 ? ` …+${c.failed.length - 5}` : ''}`);
		if (c.noLinkedIn.length)
			lines.push(
				`No LinkedIn URL: ${esc(c.noLinkedIn.slice(0, 8).join(', '))}${c.noLinkedIn.length > 8 ? ` …+${c.noLinkedIn.length - 8}` : ''}`,
			);
		blocks.push({ type: 'divider' }, section(lines.join('\n')));
	}
	const text = title.replace(/\*/g, '');
	await aimfoxPost(env, text, blocks.slice(0, 48));
}

// Posts to #aimfox-updates with the bot; falls back to the old webhook if the channel var is missing.
async function aimfoxPost(env, text, blocks) {
	if (env.SLACK_AIMFOX_CHANNEL && env.SLACK_BOT_TOKEN) {
		try {
			await slackPost(env, env.SLACK_AIMFOX_CHANNEL, { text, blocks, unfurl_links: false });
			return;
		} catch (err) {
			console.warn(`Aimfox report to Slack failed: ${err.message}`);
		}
	}
	await notify(env, text);
}

async function instantlyCampaignName(env, id) {
	try {
		const res = await fetch(`${INSTANTLY_BASE}/campaigns/${id}`, { headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` } });
		if (!res.ok) return id;
		return (await res.json()).name || id;
	} catch {
		return id;
	}
}

// Lists Aimfox campaigns with the worker's AIMFOX_API_KEY. Aimfox has had list endpoints under v2 and v3,
// so each known shape is tried; the first that answers wins.
async function listAimfoxCampaigns(env) {
	const tries = [
		{ url: 'https://api.aimfox.com/api/v2/campaigns', method: 'GET' },
		{ url: `${AIMFOX_BASE}/campaigns`, method: 'GET' },
		{ url: `${AIMFOX_BASE}/campaigns:search`, method: 'POST', body: '{}' },
	];
	const errors = [];
	for (const t of tries) {
		try {
			const res = await fetch(t.url, {
				method: t.method,
				headers: { Authorization: `Bearer ${env.AIMFOX_API_KEY}`, 'Content-Type': 'application/json' },
				...(t.body ? { body: t.body } : {}),
			});
			if (!res.ok) {
				errors.push(`${t.method} ${t.url}: ${res.status}`);
				continue;
			}
			const data = await res.json();
			const list = Array.isArray(data) ? data : data.campaigns || data.data || data.items || data.results || [];
			return {
				source: `${t.method} ${t.url}`,
				campaigns: list.map((c) => ({
					id: c.id || c.campaign_id || c.uuid,
					name: c.name || c.title || '',
					state: c.state || c.status || '',
					type: c.type || '',
					targets: c.targets_count ?? c.target_count ?? c.targets ?? c.stats?.targets ?? undefined,
				})),
			};
		} catch (err) {
			errors.push(`${t.method} ${t.url}: ${err.message}`);
		}
	}
	return { campaigns: [], errors };
}

async function aimfoxCampaignNames(env) {
	const { campaigns } = await listAimfoxCampaigns(env).catch(() => ({ campaigns: [] }));
	return Object.fromEntries(campaigns.filter((c) => c.id).map((c) => [c.id, c.name]));
}

// GET /aimfox/campaigns?key=RUN_SECRET : every Instantly + Aimfox campaign with its ID, and what is mapped now.
async function handleCampaignList(env, url) {
	if (url.searchParams.get('key') !== env.RUN_SECRET) return new Response('unauthorized', { status: 401 });
	const STATUS = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed', 4: 'running subsequences' };
	const instantly = [];
	let after = null;
	for (let page = 0; page < 5; page++) {
		const qs = new URLSearchParams({ limit: '100', ...(after ? { starting_after: after } : {}) });
		const res = await fetch(`${INSTANTLY_BASE}/campaigns?${qs}`, { headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` } });
		if (!res.ok) {
			instantly.push({ error: `Instantly ${res.status}` });
			break;
		}
		const data = await res.json();
		for (const c of data.items || []) instantly.push({ id: c.id, name: c.name, status: STATUS[c.status] ?? c.status });
		if (!data.next_starting_after || !(data.items || []).length) break;
		after = data.next_starting_after;
	}
	const aimfox = await listAimfoxCampaigns(env);
	const map = JSON.parse(env.CAMPAIGN_MAP || '{}');
	return Response.json(
		{
			current_mapping: map,
			instantly_campaigns: instantly,
			aimfox,
			how_to_map: 'CAMPAIGN_MAP in wrangler.jsonc: {"<instantly id>":"<aimfox id>", ...}',
		},
		{ headers: { 'Content-Type': 'application/json' } },
	);
}

async function listCompletedNoReply(env, campaignId, startingAfter) {
	const body = { campaign: campaignId, filter: 'FILTER_VAL_COMPLETED_NO_REPLY', limit: PAGE_SIZE };
	if (startingAfter) body.starting_after = startingAfter;
	const res = await fetch(`${INSTANTLY_BASE}/leads/list`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Instantly leads/list ${res.status}: ${await res.text()}`);
	return res.json();
}

function cleanLinkedIn(raw) {
	if (!raw || typeof raw !== 'string') return null;
	try {
		const u = new URL(raw.trim());
		if (!u.hostname.endsWith('linkedin.com')) return null;
		const m = u.pathname.match(/^\/in\/([^/]+)/);
		return m ? `https://www.linkedin.com/in/${m[1]}/` : null;
	} catch {
		return null;
	}
}

/* =========================================================================
 * 2a. INSTANTLY WEBHOOK -> CLAUDE DRAFT -> SLACK CARD
 * ========================================================================= */

async function handleInstantlyReply(request, env, ctx, url) {
	if (url.searchParams.get('key') !== env.INSTANTLY_WEBHOOK_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}
	const event = await request.json().catch(() => null);
	if (!event || event.event_type !== 'reply_received' || !event.email_id) {
		return new Response('ignored');
	}

	// Dedupe: Instantly can retry a webhook; one email_id = one Slack card.
	const key = `draft:${event.email_id}`;
	if (await env.HANDOFF_KV.get(key)) return new Response('duplicate');
	await env.HANDOFF_KV.put(key, JSON.stringify({ status: 'processing' }), { expirationTtl: DRAFT_TTL_SECONDS });

	// Which Cloudflare data centre ran this (helps diagnose region blocks such as Claude 403)
	const colo = request.cf?.colo || '?';

	// Answer Instantly right away; research + drafting run in the background.
	await startDraft(env, ctx, event, colo);
	return new Response('accepted');
}

// With the queue (Workers Paid) the job has minutes to finish and research runs.
// Without it we fall back to the old ~30s background run and research is skipped.
async function startDraft(env, ctx, event, colo, retriedBy) {
	if (env.REPLY_QUEUE) {
		try {
			await env.REPLY_QUEUE.send({ event, colo, retriedBy: retriedBy || null });
			return;
		} catch (err) {
			console.warn(`Queue send failed (${err.message}), drafting inline`);
		}
	}
	ctx.waitUntil(runDraft(env, event, colo, retriedBy, { inline: true }));
}

// Drafts a reply; on failure keeps the event so the team can press "Retry draft" in Slack.
async function runDraft(env, event, colo, retriedBy, opts = {}) {
	const key = `draft:${event.email_id}`;
	try {
		await processReply(env, event, opts);
		await env.HANDOFF_KV.delete(`failed:${event.email_id}`);
	} catch (err) {
		console.error(`Draft failed (colo ${colo}): ${err.message}`);
		await env.HANDOFF_KV.delete(key);
		await env.HANDOFF_KV.put(`failed:${event.email_id}`, JSON.stringify(event), { expirationTtl: DRAFT_TTL_SECONDS });
		await slackPost(env, env.SLACK_ESCALATIONS_CHANNEL, {
			text: `Draft FAILED for ${event.lead_email}: ${err.message}`,
			blocks: [
				section(
					`*Draft failed* for ${esc(event.lead_email)} (${esc(event.campaign_name || '')})${retriedBy ? ` · retry by <@${retriedBy}>` : ''}\n` +
						`\`${esc(err.message).slice(0, 300)}\`\nCloudflare location: ${esc(colo)}`,
				),
				actionsBlock([
					{ type: 'button', style: 'primary', action_id: 'retry_draft', value: event.email_id, text: pt('Retry draft') },
					urlButton('Open in Unibox', event.unibox_url),
				]),
			],
		}).catch(() => {});
	}
}

async function processReply(env, event, opts = {}) {
	const latest = latestMessage(event.reply_text || event.reply_text_snippet || '');
	const senderFirst = senderFirstName(event.email_account);
	const leadName = [event.firstName, event.lastName].filter(Boolean).join(' ') || event.lead_email;

	// Lead research (queue only: it can take 20-60s) and PodPitch run side by side. Neither is fatal.
	const doResearch = env.RESEARCH_ENABLED !== 'false' && !opts.inline && shouldResearch(latest);
	const [pod, research] = await Promise.all([
		isPodcastThread(event) ? findPodcastCandidates(env, event, latest) : Promise.resolve(null),
		doResearch ? researchLead(env, event, latest).catch((e) => ({ error: e.message })) : Promise.resolve(null),
	]);
	if (pod?.error) console.warn(`PodPitch: ${pod.error}`);
	if (research?.error) console.warn(`Research: ${research.error}`);

	const ai = await draftWithClaude(env, event, latest, senderFirst, pod?.candidates || [], research);

	// Keep only shows that really came back from PodPitch (never invented ones).
	const podcasts = pickRealShows(ai.podcasts, pod?.candidates || []);
	// Make sure each pick has an Apple / Spotify link (read-only details lookup if search had none).
	if (podcasts.length) await addListenLinks(env, podcasts, pod?.session);

	// Safety net: check the draft against our hard rules.
	const warnings = ai.action === 'DRAFT' ? lintDraft(ai.draft, podcasts.length) : [];
	if (ai.action === 'DRAFT' && podcasts.length) {
		const missing = podcasts.filter((p) => !findShow(ai.draft, p));
		if (missing.length) warnings.push(`draft does not mention: ${missing.map((p) => p.name).join(', ')}`);
	}
	const invented = (ai.podcasts || [])
		.map((c) => String(c?.name || ''))
		.filter((n) => n && !podcasts.some((p) => p.name.toLowerCase() === n.toLowerCase()));
	if (ai.action === 'DRAFT' && invented.length) warnings.push(`show not from PodPitch, remove it: ${invented.join(', ')}`);
	// Hard stop: a draft that names podcasts PodPitch did not return must never be one-click sendable.
	const listsShows =
		/(a few|some|couple of|\d)\s+(shows|podcasts)|(shows|podcasts)\s+(we'?d|we would|i'?d|to)\s+(look at|suggest|recommend|pitch)/i.test(
			ai.draft || '',
		);
	if (ai.action === 'DRAFT' && (invented.length || (!podcasts.length && listsShows))) {
		ai.action = 'ESCALATE';
		ai.escalation_reason = `Draft named podcasts that did not come from PodPitch${pod?.error ? ` (PodPitch: ${pod.error})` : ''}. Write the reply by hand, or press Retry once PodPitch responds.`;
		ai.note_for_human = `Blocked draft: ${String(ai.draft).slice(0, 300)}`;
	}
	if (ai.action === 'DRAFT' && !ai.draft.trim()) {
		ai.action = 'ESCALATE';
		ai.escalation_reason = 'Model returned an empty draft';
	}
	if (ai.action === 'DRAFT' && ai.confidence === 'low') {
		ai.action = 'ESCALATE';
		ai.escalation_reason = ai.escalation_reason || 'Low confidence';
	}

	const record = {
		status: ai.action === 'NO_REPLY' ? 'no_reply' : 'pending',
		email_id: event.email_id,
		eaccount: event.email_account,
		subject: event.reply_subject || 'Re:',
		lead_email: event.lead_email,
		lead_name: leadName,
		campaign_name: event.campaign_name || '',
		brand: brandFor(env, event).team,
		unibox_url: event.unibox_url || '',
		latest,
		intent: ai.intent,
		confidence: ai.confidence,
		action: ai.action,
		escalation_reason: ai.escalation_reason || '',
		note: ai.note_for_human || '',
		follow_up_date: ai.follow_up_date || '',
		draft: ai.draft || '',
		warnings,
		podcast_thread: Boolean(pod),
		podcasts,
		podcast_queries: pod?.queries || [],
		podcast_error: pod?.error || '',
		research: research
			? {
					website: research.website || '',
					firm_summary: research.firm_summary || '',
					personal_hook: research.personal_hook || '',
					ai_visibility: research.ai_visibility || null,
					confidence: research.confidence || '',
					cached: Boolean(research.cached),
					error: research.error || '',
					site_error: research.site_error || '',
					search_error: research.search_error || '',
				}
			: null,
		created_at: Date.now(),
	};

	// One Slack thread per lead: the first card starts it, every later reply from the
	// same lead (any campaign) is posted inside it, so the whole conversation stays together.
	const naturalChannel = ai.action === 'ESCALATE' ? env.SLACK_ESCALATIONS_CHANNEL : env.SLACK_REPLIES_CHANNEL;
	const leadKey = `lead:${String(event.lead_email || '').toLowerCase()}`;
	const existing = event.lead_email ? JSON.parse((await env.HANDOFF_KV.get(leadKey)) || 'null') : null;
	const card = {
		text: `${record.action === 'ESCALATE' ? 'Escalation' : 'Reply'} from ${leadName}`,
		blocks: cardBlocks(record),
	};

	let msg;
	let threadTs;
	if (existing?.channel && existing?.ts) {
		try {
			// reply_broadcast also shows it in the channel so nobody misses a new reply
			msg = await slackPost(env, existing.channel, { ...card, thread_ts: existing.ts, reply_broadcast: true });
			threadTs = existing.ts;
		} catch (err) {
			console.warn(`Thread post failed (${err.message}), starting a new thread`);
		}
	}
	if (!msg) {
		msg = await slackPost(env, naturalChannel, card);
		threadTs = msg.ts;
		await env.HANDOFF_KV.put(leadKey, JSON.stringify({ channel: msg.channel, ts: msg.ts, started: Date.now() }), {
			expirationTtl: LEAD_THREAD_TTL_SECONDS,
		});
	} else {
		// Keep the lead's thread alive while the conversation continues
		await env.HANDOFF_KV.put(leadKey, JSON.stringify(existing), { expirationTtl: LEAD_THREAD_TTL_SECONDS });
		// An escalation inside a thread that lives in #tpx-outbound-replies still pings #outbound-escalations
		if (ai.action === 'ESCALATE' && existing.channel !== env.SLACK_ESCALATIONS_CHANNEL && env.SLACK_ESCALATIONS_CHANNEL) {
			const link = await permalink(env, msg.channel, msg.ts);
			await slackPost(env, env.SLACK_ESCALATIONS_CHANNEL, {
				text: `Escalation from ${leadName}`,
				blocks: [
					section(
						`*Needs a human:* ${esc(leadName)} (${esc(record.campaign_name)}): ${esc(record.escalation_reason || 'see card')}\n${link ? `<${link}|Open the conversation thread>` : "See the lead's thread in the replies channel."}`,
					),
				],
			}).catch((e) => console.warn(`Escalation ping failed: ${e.message}`));
		}
	}

	record.channel = msg.channel;
	record.ts = msg.ts;
	record.thread_ts = threadTs;
	await saveDraft(env, record);
}

async function permalink(env, channel, ts) {
	try {
		const qs = new URLSearchParams({ channel, message_ts: ts });
		const res = await fetch(`${SLACK_API}/chat.getPermalink?${qs}`, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
		const data = await res.json();
		return data.ok ? data.permalink : null;
	} catch {
		return null;
	}
}

function pickRealShows(chosen, candidates) {
	if (!Array.isArray(chosen) || !candidates.length) return [];
	const out = [];
	for (const c of chosen) {
		const id = String(c?.id || '');
		const name = String(c?.name || '')
			.toLowerCase()
			.trim();
		const match = candidates.find((s) => (id && s.id && s.id === id) || (name && s.name.toLowerCase().trim() === name));
		if (match && !out.some((o) => o.name === match.name)) {
			out.push({
				id: match.id,
				name: match.name,
				url: match.url,
				apple: match.apple || '',
				spotify: match.spotify || '',
				genre: match.genre,
				why: String(c.why || '').slice(0, 200),
				aliases: showAliases(match.name, c.draft_name),
			});
		}
		if (out.length >= 3) break;
	}
	return out;
}

// The ways a show may be written in the draft: the text Claude says it used, the full name,
// the title before a colon or dash ("This Is Getting Old: Moving Towards..." -> "This Is Getting Old"),
// and the name without a trailing "Podcast" / "with Dr. X". Longest first so the fullest match wins.
function showAliases(name, draftName) {
	const n = String(name || '').trim();
	const list = [
		String(draftName || '').trim(),
		n,
		n.split(/\s*[:|–—]\s*|\s+-\s+/)[0],
		n.replace(/\s+(podcast|show)$/i, ''),
		n.split(/\s+with\s+/i)[0],
	];
	return [...new Set(list.map((x) => x.trim()).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
}

// Finds where a show is named in a text (case-insensitive). Returns {index, text} or null.
function findShow(text, show) {
	const low = String(text).toLowerCase();
	for (const a of show.aliases?.length ? show.aliases : [show.name]) {
		const i = low.indexOf(a.toLowerCase());
		if (i !== -1) return { index: i, text: String(text).slice(i, i + a.length) };
	}
	return null;
}

function candidatesText(candidates, podcastThread = false) {
	if (!candidates.length) {
		return podcastThread
			? '\n\nPODCAST CANDIDATES: none available right now. Do NOT name any podcast or show. Offer to send a tailored shortlist and share the call link instead.'
			: '';
	}
	const lines = candidates.map(
		(s, i) =>
			`${i + 1}. id=${s.id || 'none'} | ${s.name}${s.genre ? ` | genre: ${s.genre}` : ''}${s.description ? ` | ${s.description.slice(0, 220)}` : ''}`,
	);
	return `\n\nPODCAST CANDIDATES (real shows from PodPitch; you may only name shows from this list):\n${lines.join('\n')}`;
}

// Only the website facts go to the drafter. The AI visibility result stays on the card.
function researchText(r) {
	if (!r || (!r.firm_summary && !r.personal_hook)) return '';
	return (
		`\n\nLEAD RESEARCH (from their website; you may use at most ONE detail, only if it fits naturally):\n` +
		`Firm: ${r.firm_summary || ''}\nDetail you could mention: ${r.personal_hook || 'none'}`
	);
}

async function draftWithClaude(env, event, latest, senderFirst, candidates = [], research = null) {
	if (!env.CLAUDE_MODEL) throw new Error('CLAUDE_MODEL var is not set');
	const userContent = `Draft a reply to this prospect email.

Sender first name (sign off with this, lowercase): ${senderFirst}
Sending inbox: ${event.email_account || ''}
Campaign: ${event.campaign_name || ''}
Lead: ${[event.firstName, event.lastName].filter(Boolean).join(' ')} <${event.lead_email || ''}>
Company: ${event.companyName || event.shortName || ''}
Location: ${event.location || event.City || ''}
Title: ${event.jobTitle || ''}
Headline: ${String(event.headline || '').slice(0, 300)}
Industry: ${[event.industry, event.subIndustry].filter(Boolean).join(' / ')}
Company website: ${event.companyWebsite || event.website || ''}
Company description: ${String(event.companyDescription || '').slice(0, 400)}
Subject: ${event.reply_subject || ''}

LATEST MESSAGE FROM THE PROSPECT:
${latest}

FULL THREAD (newest first, includes our earlier emails):
${(event.reply_text || '').slice(0, 6000)}${researchText(research)}${candidatesText(candidates, isPodcastThread(event))}`;

	const body = JSON.stringify({
		model: env.CLAUDE_MODEL,
		max_tokens: 1000,
		system: buildSystemPrompt(env, calendlyFor(env, event), brandFor(env, event)),
		messages: [{ role: 'user', content: userContent }],
	});

	// Retry temporary failures: 403 (region block on one route), 429 (rate limit), 5xx / 529 (overloaded).
	let res;
	let lastErr = '';
	for (let attempt = 0; attempt < CLAUDE_RETRY_DELAYS_MS.length + 1; attempt++) {
		if (attempt > 0) await sleep(CLAUDE_RETRY_DELAYS_MS[attempt - 1]);
		res = await fetch(ANTHROPIC_URL, {
			method: 'POST',
			headers: {
				'x-api-key': env.ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
			body,
		});
		if (res.ok) break;
		lastErr = `Claude ${res.status}: ${(await res.text()).slice(0, 300)}`;
		if (![403, 408, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
		console.warn(`${lastErr} (attempt ${attempt + 1})`);
	}
	if (!res.ok) throw new Error(lastErr);
	const data = await res.json();
	const text = (data.content || [])
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('');
	return parseModelJson(text);
}

function parseModelJson(text) {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1) throw new Error('Claude did not return JSON');
	const obj = JSON.parse(text.slice(start, end + 1));
	const action = ['DRAFT', 'ESCALATE', 'NO_REPLY'].includes(obj.action) ? obj.action : 'ESCALATE';
	return {
		intent: String(obj.intent || 'OTHER'),
		confidence: ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'low',
		action,
		escalation_reason: String(obj.escalation_reason || ''),
		draft: cleanCalendlyLinks(obj.draft || ''),
		follow_up_date: String(obj.follow_up_date || ''),
		note_for_human: String(obj.note_for_human || ''),
		podcasts: Array.isArray(obj.podcasts) ? obj.podcasts.slice(0, 3) : [],
	};
}

// Strip the quoted thread so reviewers see only what the prospect just wrote.
function latestMessage(text) {
	let src = String(text).replace(/\r/g, '');
	// Quoted history that arrives on the same line: "... alone  > On Oct 21, 2026, at 8:24 AM, Angela <a@b.co> wrote: > ..."
	const inline = src.search(/\s>?\s*On\s[^\n]{0,40}\d[^\n]{0,160}?\bwrote:/);
	if (inline > 0) src = src.slice(0, inline);
	const lines = src.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*>/.test(line)) break;
		if (/^\s*On .+wrote:\s*$/i.test(line)) break;
		// "On Thu, Oct 15, 2026 at 9:45 AM Jane <jane@x.co>" + "wrote:" on the next line(s)
		if (/^\s*On\s.+\d/.test(line) && /^\s*(.*\s)?wrote:\s*$/i.test(lines.slice(i + 1, i + 3).join(' '))) break;
		if (/^\s*wrote:\s*$/i.test(line)) break;
		if (/^\s*-{2,}\s*Original Message/i.test(line)) break;
		if (/^\s*From:\s.+/i.test(line) && out.length) break;
		out.push(line);
	}
	return (
		out
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim() || String(text).slice(0, 500)
	);
}

function senderFirstName(eaccount) {
	const local = String(eaccount || '').split('@')[0] || '';
	return local.split(/[._-]/)[0].toLowerCase() || 'team';
}

const BANNED = [
	'delve',
	'leverage',
	'streamline',
	'robust',
	'seamless',
	'elevate',
	'unlock',
	'empower',
	'game-changer',
	'cutting-edge',
	'comprehensive',
	'synergy',
	'rest assured',
	'i hope this finds you well',
	"i'd be happy to assist",
	'thank you so much for your interest',
	'i wanted to reach out',
	'just circling back',
	'touch base',
	'at your earliest convenience',
	'guarantee',
];

function lintDraft(draft, showCount = 0) {
	const t = String(draft);
	const low = t.toLowerCase();
	const w = [];
	for (const b of BANNED) if (low.includes(b)) w.push(`contains "${b}"`);
	if (/[—–]/.test(t)) w.push('em/en dash');
	if (t.includes('!')) w.push('exclamation mark');
	if (/^\s*([-*•]|\d+\.)\s/m.test(t)) w.push('bullet list');
	if (/\b(chatgpt|gemini|perplexity|ai)\b[^.]{0,40}\bwill (recommend|rank|list|name)/i.test(t)) w.push('promises AI will recommend');
	const words = (t.match(/\b\w+\b/g) || []).length;
	if (words > (showCount ? 140 : 90)) w.push(`${words} words (long)`);
	return w;
}

/* =========================================================================
 * 2b. SLACK INTERACTIVITY (buttons + modals)
 * ========================================================================= */

async function handleSlackInteract(request, env, ctx) {
	const raw = await request.text();
	if (!(await verifySlack(request, raw, env.SLACK_SIGNING_SECRET))) {
		return new Response('bad signature', { status: 401 });
	}
	const payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
	const userId = payload.user?.id;

	if (payload.type === 'block_actions') {
		const action = payload.actions?.[0] || {};
		if (action.action_id === 'open_unibox') return new Response('');

		if (!isApprover(env, userId)) {
			ctx.waitUntil(ephemeral(payload.response_url, 'You are not on the approver list for outbound replies.'));
			return new Response('');
		}
		const emailId = action.value;

		if (action.action_id === 'retry_draft') {
			const saved = await env.HANDOFF_KV.get(`failed:${emailId}`);
			if (!saved) {
				ctx.waitUntil(ephemeral(payload.response_url, 'Nothing to retry (already drafted, or older than 7 days).'));
				return new Response('');
			}
			const event = JSON.parse(saved);
			await env.HANDOFF_KV.put(`draft:${emailId}`, JSON.stringify({ status: 'processing' }), { expirationTtl: DRAFT_TTL_SECONDS });
			ctx.waitUntil(
				(async () => {
					await slackApi(env, 'chat.update', {
						channel: payload.channel?.id,
						ts: payload.message?.ts,
						text: `Retrying draft for ${event.lead_email}`,
						blocks: [
							section(
								`*Retrying draft* for ${esc(event.lead_email)} (requested by <@${userId}>). The new card will appear in the usual channel.`,
							),
						],
					}).catch(() => {});
					await startDraft(env, ctx, event, request.cf?.colo || '?', userId);
				})(),
			);
			return new Response('');
		}

		const rec = await loadDraft(env, emailId);
		if (!rec) {
			ctx.waitUntil(
				ephemeral(
					payload.response_url,
					'This draft was not found. It may be older than 7 days, or it was created before the move to the new worker. Reply from Unibox.',
				),
			);
			return new Response('');
		}

		switch (action.action_id) {
			case 'approve':
				ctx.waitUntil(sendReply(env, rec, rec.draft, userId, payload.response_url, false));
				return new Response('');

			case 'edit': // modal must open within 3 seconds of the click, so do it before answering
			case 'write':
				if (!(await guardPending(rec, payload.response_url))) return new Response('');
				await slackApi(env, 'views.open', { trigger_id: payload.trigger_id, view: editModal(rec, action.action_id === 'write') });
				return new Response('');

			case 'reject':
				if (!(await guardPending(rec, payload.response_url))) return new Response('');
				await slackApi(env, 'views.open', { trigger_id: payload.trigger_id, view: rejectModal(rec) });
				return new Response('');

			case 'handled':
				if (!(await guardPending(rec, payload.response_url))) return new Response('');
				ctx.waitUntil(closeCard(env, rec, 'handled', userId, `Marked handled by <@${userId}>`));
				return new Response('');
		}
		return new Response('');
	}

	if (payload.type === 'view_submission') {
		const view = payload.view || {};
		const emailId = view.private_metadata;
		if (!isApprover(env, userId)) {
			return Response.json({ response_action: 'errors', errors: { body: 'You are not on the approver list.' } });
		}
		const rec = await loadDraft(env, emailId);
		if (!rec) return Response.json({ response_action: 'errors', errors: { body: 'Draft not found.' } });

		if (view.callback_id === 'edit_modal') {
			const text = view.state?.values?.body?.text?.value?.trim() || '';
			if (!text) return Response.json({ response_action: 'errors', errors: { body: 'Reply cannot be empty.' } });
			ctx.waitUntil(sendReply(env, rec, text, userId, null, true));
			return Response.json({ response_action: 'clear' });
		}
		if (view.callback_id === 'reject_modal') {
			const reason = view.state?.values?.reason?.text?.value?.trim() || '(no reason given)';
			ctx.waitUntil(
				(async () => {
					await closeCard(env, rec, 'rejected', userId, `Rejected by <@${userId}>: ${esc(reason)}`);
					await logEdit(env, rec, null, userId, reason);
				})(),
			);
			return Response.json({ response_action: 'clear' });
		}
	}
	return new Response('');
}

async function sendReply(env, rec, rawText, userId, responseUrl, edited) {
	// Last line of defence: no tracking tags on Calendly links in anything we send,
	// including text a person typed or pasted in the Edit / Write reply box.
	const text = cleanCalendlyLinks(rawText);
	// Re-read and lock to stop double sends (two clicks, two people).
	const fresh = await loadDraft(env, rec.email_id);
	if (!fresh || fresh.status !== 'pending') {
		const who = fresh?.acted_by ? ` by <@${fresh.acted_by}>` : '';
		if (responseUrl) await ephemeral(responseUrl, `Already ${fresh?.status || 'closed'}${who}. Nothing sent.`);
		return;
	}
	if (Date.now() - fresh.created_at > DRAFT_EXPIRY_MS) {
		if (responseUrl) await ephemeral(responseUrl, 'This draft is older than 48 hours. Reply from Unibox instead.');
		return;
	}
	fresh.status = 'sending';
	fresh.acted_by = userId;
	await saveDraft(env, fresh);

	const res = await fetch(`${INSTANTLY_BASE}/emails/reply`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			reply_to_uuid: fresh.email_id,
			eaccount: fresh.eaccount,
			subject: fresh.subject,
			body: { text: textWithLinks(text, fresh.podcasts), html: textToHtml(text, fresh.podcasts) },
		}),
	});

	if (!res.ok) {
		const err = (await res.text()).slice(0, 300);
		fresh.status = 'pending';
		fresh.acted_by = null;
		await saveDraft(env, fresh);
		await slackPost(env, fresh.channel, {
			thread_ts: fresh.thread_ts || fresh.ts,
			text: `Send FAILED (Instantly ${res.status}): ${err}. The draft is still pending, try again or reply from Unibox.`,
		});
		return;
	}

	fresh.status = 'sent';
	fresh.sent_text = text;
	fresh.sent_at = Date.now();
	await saveDraft(env, fresh);
	await updateCard(env, fresh, `Sent${edited ? ' (edited)' : ''} by <@${userId}> ${slackTime(fresh.sent_at)}`);
	if (edited && text.trim() !== (fresh.draft || '').trim()) await logEdit(env, fresh, text, userId, null);
}

async function closeCard(env, rec, status, userId, line) {
	const fresh = (await loadDraft(env, rec.email_id)) || rec;
	if (fresh.status !== 'pending') return;
	fresh.status = status;
	fresh.acted_by = userId;
	await saveDraft(env, fresh);
	await updateCard(env, fresh, line);
}

async function guardPending(rec, responseUrl) {
	if (rec.status === 'pending') return true;
	const who = rec.acted_by ? ` by <@${rec.acted_by}>` : '';
	await ephemeral(responseUrl, `Already ${rec.status}${who}.`);
	return false;
}

// Tuning loop: every edit or rejection lands in #outbound-edits.
async function logEdit(env, rec, finalText, userId, reason) {
	if (!env.SLACK_EDITS_CHANNEL) return;
	const blocks = [
		section(
			`*${finalText ? 'Edited before send' : 'Rejected'}* by <@${userId}> · ${esc(rec.lead_name)} · ${esc(rec.campaign_name)} · intent ${esc(rec.intent)}`,
		),
		section(`*Prospect wrote:*\n${quote(rec.latest)}`),
		section(`*AI draft:*\n${quote(rec.draft || '(none)')}`),
	];
	if (finalText) blocks.push(section(`*Sent instead:*\n${quote(finalText)}`));
	if (reason) blocks.push(section(`*Reason:* ${esc(reason)}`));
	await slackPost(env, env.SLACK_EDITS_CHANNEL, { text: 'Draft edit log', blocks });
}

/* =========================================================================
 * SLACK UI
 * ========================================================================= */

function cardBlocks(rec, doneLine) {
	const header =
		`*${esc(rec.lead_name)}* <mailto:${rec.lead_email}|${esc(rec.lead_email)}>\n` +
		`${esc(rec.campaign_name)}${rec.brand ? ` · writing as *${esc(rec.brand)}*` : ''} · from ${esc(rec.eaccount)} · intent *${esc(rec.intent)}* (${esc(rec.confidence)})`;
	const blocks = [section(header), section(`*Their reply:*\n${quote(rec.latest)}`)];

	if (rec.sent_text) {
		blocks.push(section(`*Sent reply:*\n${slackLinkShows(quote(rec.sent_text), rec.podcasts)}`));
	} else if (rec.action === 'DRAFT') {
		blocks.push(section(`*Draft reply:*\n${slackLinkShows(quote(rec.draft), rec.podcasts)}`));
	} else if (rec.action === 'ESCALATE') {
		blocks.push(section(`*Needs a human:* ${esc(rec.escalation_reason || 'see note')}`));
	} else {
		blocks.push(section(`*No reply needed* (${esc(rec.intent)})`));
	}

	if (rec.research && !rec.sent_text && (rec.research.firm_summary || rec.research.ai_visibility?.query)) {
		const r = rec.research;
		const v = r.ai_visibility || {};
		const found = v.found === 'yes' ? 'Shows up' : v.found === 'no' ? 'Does NOT show up' : 'Unclear';
		const lines = [];
		if (r.firm_summary) lines.push(`${esc(r.firm_summary)}${r.website ? ` (<${r.website}|site>)` : ''}`);
		if (r.personal_hook) lines.push(`Hook: ${esc(r.personal_hook)}`);
		if (v.query && !r.search_error) {
			lines.push(`AI visibility for "${esc(v.query)}": *${found}*${v.position_note ? `. ${esc(v.position_note)}` : ''}`);
			if (v.competitors?.length) lines.push(`Showing instead: ${esc(v.competitors.join(', '))}`);
		}
		blocks.push(
			section(
				`*Lead research* (team only${r.confidence ? `, ${esc(r.confidence)} confidence` : ''}${r.cached ? ', cached' : ''}):\n${lines.join('\n')}`,
			),
		);
	}

	if (rec.podcasts?.length) {
		const lines = rec.podcasts.map(
			(p) =>
				`• ${p.url ? `<${p.url}|${esc(p.name)}>` : `*${esc(p.name)}* (no listen link found)`}` +
				`${p.genre ? ` (${esc(p.genre)})` : ''}${p.why ? `: ${esc(p.why)}` : ''}` +
				`${p.apple && p.spotify ? ` · <${p.spotify}|Spotify>` : ''}`,
		);
		blocks.push(section(`*Podcast picks (PodPitch):*\n${lines.join('\n')}`));
	}

	const ctxLines = [];
	if (rec.research?.error) ctxLines.push(`Research failed: ${esc(rec.research.error.slice(0, 200))}`);
	else if (rec.research?.site_error && !rec.research?.firm_summary)
		ctxLines.push(`Research: website not readable (${esc(rec.research.site_error)})`);
	if (rec.research?.search_error) ctxLines.push(`AI visibility check skipped: ${esc(rec.research.search_error.slice(0, 160))}`);
	if (rec.podcast_thread) {
		if (rec.podcast_error && !rec.podcasts?.length) ctxLines.push(`PodPitch: ${esc(rec.podcast_error)}. Add shows by hand if needed.`);
		else if (!rec.podcasts?.length) ctxLines.push('PodPitch: no shows used in this draft.');
		if (rec.podcast_queries?.length) ctxLines.push(`PodPitch searched: ${esc(rec.podcast_queries.join(' | '))}`);
	}
	if (rec.note) ctxLines.push(`Note: ${esc(rec.note)}`);
	if (rec.follow_up_date) ctxLines.push(`Follow up on ${esc(rec.follow_up_date)}`);
	if (rec.warnings?.length) ctxLines.push(`WARNING: ${esc(rec.warnings.join(', '))}`);
	if (ctxLines.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctxLines.join('\n') }] });

	if (doneLine) {
		blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: doneLine }] });
		if (rec.unibox_url) blocks.push(actionsBlock([urlButton('Open in Unibox', rec.unibox_url)]));
		return blocks;
	}

	const id = rec.email_id;
	if (rec.action === 'DRAFT') {
		blocks.push(
			actionsBlock([
				{
					type: 'button',
					style: 'primary',
					action_id: 'approve',
					value: id,
					text: pt('Approve & send'),
					confirm: {
						title: pt('Send this reply?'),
						text: pt(`It goes to ${rec.lead_email} from ${rec.eaccount}.`),
						confirm: pt('Send'),
						deny: pt('Cancel'),
					},
				},
				{ type: 'button', action_id: 'edit', value: id, text: pt('Edit') },
				{ type: 'button', style: 'danger', action_id: 'reject', value: id, text: pt('Reject') },
				urlButton('Open in Unibox', rec.unibox_url),
			]),
		);
	} else if (rec.action === 'ESCALATE') {
		blocks.push(
			actionsBlock([
				{ type: 'button', style: 'primary', action_id: 'write', value: id, text: pt('Write reply') },
				{ type: 'button', action_id: 'handled', value: id, text: pt('Mark handled') },
				urlButton('Open in Unibox', rec.unibox_url),
			]),
		);
	} else if (rec.unibox_url) {
		blocks.push(actionsBlock([urlButton('Open in Unibox', rec.unibox_url)]));
	}
	return blocks;
}

function editModal(rec, blank) {
	return {
		type: 'modal',
		callback_id: 'edit_modal',
		private_metadata: rec.email_id,
		title: pt(blank ? 'Write reply' : 'Edit reply'),
		submit: pt('Send'),
		close: pt('Cancel'),
		blocks: [
			section(`To *${esc(rec.lead_email)}* from *${esc(rec.eaccount)}*\n*They wrote:*\n${quote(rec.latest).slice(0, 2500)}`),
			{
				type: 'input',
				block_id: 'body',
				label: pt('Reply'),
				element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: blank ? '' : rec.draft.slice(0, 2900) },
			},
		],
	};
}

function rejectModal(rec) {
	return {
		type: 'modal',
		callback_id: 'reject_modal',
		private_metadata: rec.email_id,
		title: pt('Reject draft'),
		submit: pt('Reject'),
		close: pt('Cancel'),
		blocks: [
			{
				type: 'input',
				block_id: 'reason',
				optional: true,
				label: pt('Why? (helps tune the AI)'),
				element: { type: 'plain_text_input', action_id: 'text', multiline: true },
			},
		],
	};
}

async function updateCard(env, rec, doneLine) {
	if (!rec.channel || !rec.ts) return;
	await slackApi(env, 'chat.update', { channel: rec.channel, ts: rec.ts, text: doneLine, blocks: cardBlocks(rec, doneLine) });
}

const pt = (text) => ({ type: 'plain_text', text: String(text).slice(0, 75), emoji: false });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2990) } });
const actionsBlock = (elements) => ({ type: 'actions', elements: elements.filter(Boolean) });
const urlButton = (label, url) => (url ? { type: 'button', action_id: 'open_unibox', text: pt(label), url } : null);
const esc = (s) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
const quote = (s) =>
	esc(String(s || '').slice(0, 2500))
		.split('\n')
		.map((l) => `>${l}`)
		.join('\n');
const slackTime = (ms) => `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;

/* =========================================================================
 * HELPERS: Slack API, signature, KV, misc
 * ========================================================================= */

async function slackApi(env, method, body) {
	const res = await fetch(`${SLACK_API}/${method}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify(body),
	});
	const data = await res.json();
	if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
	return data;
}

const slackPost = (env, channel, msg) => {
	if (!channel) throw new Error('Slack channel ID var is not set');
	return slackApi(env, 'chat.postMessage', { channel, unfurl_links: false, ...msg });
};

async function ephemeral(responseUrl, text) {
	if (!responseUrl) return;
	await fetch(responseUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
	});
}

async function verifySlack(request, raw, secret) {
	const ts = request.headers.get('X-Slack-Request-Timestamp');
	const sig = request.headers.get('X-Slack-Signature');
	if (!ts || !sig || !secret) return false;
	if (Math.abs(Date.now() / 1000 - Number(ts)) > SLACK_MAX_AGE_SECONDS) return false;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${raw}`));
	const expected = 'v0=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

function isApprover(env, userId) {
	const list = String(env.SLACK_APPROVERS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 && list.includes(userId);
}

async function loadDraft(env, emailId) {
	if (!emailId) return null;
	const v = await env.HANDOFF_KV.get(`draft:${emailId}`);
	if (!v) return null;
	const rec = JSON.parse(v);
	return rec.status === 'processing' ? null : rec;
}

const saveDraft = (env, rec) => env.HANDOFF_KV.put(`draft:${rec.email_id}`, JSON.stringify(rec), { expirationTtl: DRAFT_TTL_SECONDS });

// Email HTML: every URL becomes a link, and each podcast name becomes a link to its Apple / Spotify page.
// Names are matched in whatever text is sent, so this also works after someone edits the draft.
function textToHtml(text, podcasts = []) {
	const shows = (podcasts || []).filter((p) => p?.url && p?.name);
	return String(text)
		.replace(/\r/g, '')
		.split('\n')
		.map((l) => {
			if (!l.trim()) return '<div><br /></div>';
			let h = esc(l);
			const marks = [];
			// [anchor text](https://...) -> clean link
			h = h.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, u) => {
				marks.push(`<a href="${u}">${label}</a>`);
				return `\u0000${marks.length - 1}\u0000`;
			});
			// a bare booking link still gets clean anchor text
			h = h.replace(/https?:\/\/(?:www\.)?calendly\.com\/[^\s<>"'\u0000]+/g, (u) => {
				marks.push(`<a href="${u}">book a time here</a>`);
				return `\u0000${marks.length - 1}\u0000`;
			});
			shows.forEach((p) => {
				const f = findShow(h, { ...p, aliases: (p.aliases || [p.name]).map(esc) });
				if (f) {
					marks.push(`<a href="${esc(p.url)}">${f.text}</a>`);
					h = h.slice(0, f.index) + `\u0000${marks.length - 1}\u0000` + h.slice(f.index + f.text.length);
				}
			});
			h = h.replace(/https?:\/\/[^\s<>"'\u0000]+/g, (u) => `<a href="${u}">${u}</a>`);
			h = h.replace(/\u0000(\d+)\u0000/g, (_, n) => marks[Number(n)]);
			return `<div>${h}</div>`;
		})
		.join('');
}

// Plain-text version of the email: "anchor (url)" for markdown links, listen link after each podcast name.
function textWithLinks(text, podcasts = []) {
	let t = String(text).replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
	for (const p of podcasts || []) {
		if (!p?.url || !p?.name) continue;
		const f = findShow(t, p);
		if (f) t = t.slice(0, f.index + f.text.length) + ` (${p.url})` + t.slice(f.index + f.text.length);
	}
	return t;
}

// Slack card: show podcast names in the draft as clickable links, same as the email will.
function slackLinkShows(quoted, podcasts = []) {
	// markdown links in the draft show as clickable anchor text on the card too
	let q = quoted.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');
	for (const p of podcasts || []) {
		if (!p?.url || !p?.name) continue;
		const f = findShow(q, { ...p, aliases: (p.aliases || [p.name]).map(esc) });
		if (f) q = q.slice(0, f.index) + `<${p.url}|${f.text}>` + q.slice(f.index + f.text.length);
	}
	return q;
}

async function notify(env, text) {
	if (!env.SLACK_WEBHOOK_URL) return;
	await fetch(env.SLACK_WEBHOOK_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text }),
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
