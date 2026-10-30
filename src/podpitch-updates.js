// PodPitch client updates -> Slack #podpitch-clients-updates
//
//  * Every 15 minutes: new podcast host replies in the PodPitch inbox (positive reply, meeting
//    requested, ...) are posted with the client's name, the host's message, booking links,
//    Apple / Spotify / YouTube links and audience metrics.
//  * Once a day: a digest per client of NEW podcast matches added to their campaign.
//
// READ-ONLY. Uses the PodPitch login saved by podpitch-login.mjs (scope podpitch:read) and only
// the tools in READ_TOOLS. Tools that send, edit or schedule anything cannot be called.
//
// Secret:  PODPITCH_OAUTH   (contents of podpitch-oauth.json)
// Vars:    PODPITCH_UPDATES_CHANNEL, PODPITCH_SKIP_CATEGORIES, PODPITCH_OUR_DOMAINS
// KV keys: pp:refresh, pp:access, pp:meta, pp:watermark, ppthread:<id>, ppseen:<campaign>, pp:alerted

const MCP_URL = 'https://api.podpitch.com/v1/mcp';
const READ_TOOLS = new Set([
	'list_campaigns',
	'list_profiles',
	'list_inbox_threads',
	'read_inbox_thread',
	'get_account_podcast',
	'get_campaign_drafts',
]);
const TIMEOUT_MS = 20000; // PodPitch can be slow; each request also gets one retry
const META_TTL_MS = 6 * 3600 * 1000; // campaigns + profiles cached 6 hours
const MAX_POSTS_PER_RUN = 4; // keeps each run inside the free plan's 50-request limit
const FIRST_RUN_LOOKBACK_HOURS = 48; // first run only: post replies from the last 48 hours
const THREAD_PAGE = 25;
const DIGEST_DRAFT_PAGE = 50;
const DIGEST_MAX_PAGES = 6;
const DIGEST_DETAILS = 5; // shows per client that get full metrics in the digest

const BOOKING_HOSTS =
	/(calendly\.com|oncehub\.com|zcal\.co|savvycal\.com|acuityscheduling\.com|tidycal\.com|meetings\.hubspot\.com|\bcal\.com|youcanbook\.me|appointlet\.com|squadcast\.fm|riverside\.fm|streamyard\.com|zencastr\.com|calendar\.app\.google|calendar\.google\.com\/calendar\/appointments|bookings?\.)/i;

/* =========================================================================
 * 1. HOST REPLIES (every 15 minutes)
 * ========================================================================= */

export async function runPodpitchUpdates(env, deps, opts = {}) {
	const dry = Boolean(opts.dry);
	const channel = env.PODPITCH_UPDATES_CHANNEL;
	if (!channel) throw new Error('PODPITCH_UPDATES_CHANNEL var is not set');
	const skip = new Set(
		String(env.PODPITCH_SKIP_CATEGORIES ?? 'negative_reply')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const ours = ourDomains(env);

	const pp = await connect(env);
	const meta = await loadMeta(env, pp);

	const stored = await env.HANDOFF_KV.get('pp:watermark');
	const sinceHours = Number(opts.sinceHours || 0);
	const watermark = sinceHours
		? Date.now() - sinceHours * 3600e3
		: stored
			? Number(stored)
			: Date.now() - FIRST_RUN_LOOKBACK_HOURS * 3600e3;

	// Newest first; walk back until we reach what we already handled.
	const fresh = [];
	let cursor = null;
	for (let page = 0; page < 3; page++) {
		const res = await pp.call('list_inbox_threads', { limit: THREAD_PAGE, ...(cursor ? { cursor } : {}) });
		const items = res?.data || res?.threads || [];
		let reachedOld = false;
		for (const t of items) {
			const ts = Date.parse(t.timestamp || '') || 0;
			if (ts <= watermark) {
				reachedOld = true;
				break;
			}
			fresh.push(t);
		}
		if (reachedOld || !res?.has_more || !res?.next_cursor) break;
		cursor = res.next_cursor;
	}

	const report = { dry, watermark: new Date(watermark).toISOString(), found: fresh.length, posted: [], skipped: [] };
	let newest = watermark;

	// Oldest first so the channel reads in order.
	for (const t of fresh.reverse()) {
		const ts = Date.parse(t.timestamp) || 0;
		const label = `${t.target || t.name || t.from_address} (${t.category || 'no label'})`;
		if (
			ours.some((d) =>
				String(t.from_address || '')
					.toLowerCase()
					.endsWith(d),
			)
		) {
			// Newest email is ours (e.g. the team already answered). The host's reply before it may
			// still be unposted, so look for it, unless this thread is only our own outreach.
			if (t.category === 'user_sent' || isSkipped(t, skip)) {
				report.skipped.push(`${label}: our own message`);
				newest = Math.max(newest, ts);
				continue;
			}
			if (report.posted.length >= MAX_POSTS_PER_RUN) {
				report.skipped.push(`${label}: next run (limit per run)`);
				continue;
			}
			const seenTs = Number(await env.HANDOFF_KV.get(`ppthread:${t.thread_id}`)) || 0;
			const card = await buildReplyCard(env, pp, meta, t, ours, { minHostTs: Math.max(seenTs, Date.now() - 7 * 86400e3) });
			if (!card) {
				report.skipped.push(`${label}: our own message (host reply already posted or older than 7 days)`);
				newest = Math.max(newest, ts);
				continue;
			}
			if (!dry) {
				await deps.slackPost(env, channel, { text: card.text, blocks: card.blocks, unfurl_links: false, unfurl_media: false });
				await env.HANDOFF_KV.put(`ppthread:${t.thread_id}`, String(ts), { expirationTtl: 180 * 24 * 3600 });
			}
			report.posted.push({ ...card.summary, note: 'host reply found under our newer message' });
			newest = Math.max(newest, ts);
			continue;
		}
		if (isSkipped(t, skip)) {
			report.skipped.push(`${label}: category skipped`);
			newest = Math.max(newest, ts);
			continue;
		}
		const seen = await env.HANDOFF_KV.get(`ppthread:${t.thread_id}`);
		if (seen && Number(seen) >= ts) {
			report.skipped.push(`${label}: already posted`);
			newest = Math.max(newest, ts);
			continue;
		}
		if (report.posted.length >= MAX_POSTS_PER_RUN) {
			report.skipped.push(`${label}: next run (limit per run)`);
			continue;
		}

		const card = await buildReplyCard(env, pp, meta, t, ours);
		if (!dry) {
			await deps.slackPost(env, channel, { text: card.text, blocks: card.blocks, unfurl_links: false, unfurl_media: false });
			await env.HANDOFF_KV.put(`ppthread:${t.thread_id}`, String(ts), { expirationTtl: 180 * 24 * 3600 });
		}
		report.posted.push(card.summary);
		newest = Math.max(newest, ts);
	}

	// Only move the watermark past items we actually handled (posted or deliberately skipped).
	const deferred = report.skipped.some((s) => s.endsWith('(limit per run)'));
	if (!dry && !sinceHours && !deferred && newest > watermark) await env.HANDOFF_KV.put('pp:watermark', String(newest));
	if (!dry && !stored && !sinceHours && !deferred) await env.HANDOFF_KV.put('pp:watermark', String(Math.max(newest, watermark)));
	await env.HANDOFF_KV.delete('pp:alerted');
	await env.HANDOFF_KV.delete('pp:fails');
	return report;
}

// Skip by PodPitch label key (e.g. "negative_reply") or by its display name ("Out of office" -> "out_of_office").
function isSkipped(t, skip) {
	const key = String(t.category || '').toLowerCase();
	const label = String(t.ai_label_name || '')
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '_');
	return (key && skip.has(key)) || (label && skip.has(label));
}

async function buildReplyCard(env, pp, meta, t, ours, opts = {}) {
	const client = resolveClient(meta, t);

	// Full thread: the host's latest message + any booking links.
	let hostMsg = null;
	let firstPitch = '';
	try {
		const th = await pp.call('read_inbox_thread', { email: t.email, thread_id: t.thread_id });
		const msgs = th?.messages || [];
		firstPitch = msgs[0]?.snippet || '';
		hostMsg = [...msgs].reverse().find((m) => !ours.some((d) => fromEmail(m.from).endsWith(d))) || null;
	} catch (err) {
		console.warn(`PodPitch read thread ${t.thread_id}: ${err.message}`);
	}
	// Used when our message is newest: only continue if the host's reply is newer than what we posted.
	if (opts.minHostTs) {
		const hostTs = Date.parse(hostMsg?.date || '') || 0;
		if (!hostMsg || hostTs <= opts.minHostTs) return null;
	}
	if (client.unsure && firstPitch) Object.assign(client, resolveClient(meta, t, firstPitch));
	// Exact answer: which campaign actually contains this podcast (cached per podcast).
	if (client.unsure) {
		const exact = await campaignForEntity(env, pp, meta, t);
		if (exact) Object.assign(client, { name: clientForCampaign(meta, exact), campaign: exact.name, unsure: false });
	}

	const rawBody = hostMsg?.body || hostMsg?.snippet || t.preview || '';
	const text = trimMessage(latestOnly(htmlToText(rawBody)));
	const bookings = findBookingLinks(rawBody);

	// Podcast metrics
	let show = null;
	if (t.entity_id && t.database === 'podcast') {
		try {
			show = await pp.call('get_account_podcast', { podcast_id: String(t.entity_id) });
		} catch (err) {
			console.warn(`PodPitch podcast ${t.entity_id}: ${err.message}`);
		}
	}
	const m = metrics(show);
	const title = show?.title || t.target || 'Podcast';
	const status = statusLabel(t, bookings.length > 0);
	const sender = hostMsg?.from || `${t.name || ''} <${t.from_address || ''}>`;
	const when = Date.parse(t.timestamp) || Date.now();

	const header =
		`*${esc(client.name)}* · ${esc(status)}\n` +
		`*Podcast:* ${m.apple ? `<${m.apple}|${esc(title)}>` : `*${esc(title)}*`}${m.host ? ` · Host: ${esc(m.host)}` : ''}\n` +
		`*From:* ${esc(sender)} · <!date^${Math.floor(when / 1000)}^{date_short_pretty} {time}|${new Date(when).toISOString()}>`;

	const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: header.slice(0, 2990) } }];
	if (show?.image_url || t.target_avatar) {
		blocks[0].accessory = { type: 'image', image_url: show?.image_url || t.target_avatar, alt_text: title.slice(0, 100) };
	}
	if (text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Their message:*\n${quote(text)}`.slice(0, 2990) } });
	if (bookings.length)
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: `*Booking link:* ${bookings.map((u) => `<${u}|${esc(shortUrl(u))}>`).join('  ·  ')}` },
		});
	if (m.line) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: m.line }] });
	blocks.push({
		type: 'context',
		elements: [
			{
				type: 'mrkdwn',
				text: `Campaign: ${esc(client.campaign || 'unknown')} · Inbox: ${esc(t.email || '')} · ${t.message_count || '?'} messages in thread${client.unsure ? ' · client guessed, please check' : ''}`,
			},
		],
	});

	const buttons = [
		m.apple && button('Apple Podcasts', m.apple),
		m.spotify && button('Spotify', m.spotify),
		m.youtube && button('YouTube', m.youtube),
		bookings[0] && button('Booking link', bookings[0]),
	].filter(Boolean);
	if (buttons.length) blocks.push({ type: 'actions', elements: buttons });

	return {
		text: `${client.name}: ${status} from ${title}`,
		blocks,
		summary: { client: client.name, podcast: title, status, from: sender, bookings, metrics: m.line, message: text.slice(0, 200) },
	};
}

/* =========================================================================
 * 2. DAILY DIGEST OF NEW MATCHES
 * ========================================================================= */

export async function runPodpitchDigest(env, deps, opts = {}) {
	const dry = Boolean(opts.dry);
	const channel = env.PODPITCH_UPDATES_CHANNEL;
	const pp = await connect(env);
	const meta = await loadMeta(env, pp, true);
	const active = meta.campaigns.filter((c) => c.status && c.status !== 'off' && !c.paused);
	const report = { dry, campaigns: active.map((c) => c.name), posted: [] };

	for (const c of active) {
		const ids = [];
		const names = {};
		for (let page = 0, offset = 0; page < DIGEST_MAX_PAGES; page++) {
			const res = await pp.call('get_campaign_drafts', { campaign_id: Number(c.id), limit: DIGEST_DRAFT_PAGE, offset });
			for (const d of res?.drafts || []) {
				ids.push(String(d.entity_id));
				names[d.entity_id] = d.target || d.entity_id;
			}
			if (res?.next_offset == null || !(res?.drafts || []).length) break;
			offset = res.next_offset;
		}
		const key = `ppseen:${c.id}`;
		const prev = JSON.parse((await env.HANDOFF_KV.get(key)) || 'null');
		const newIds = prev ? ids.filter((id) => !prev.includes(id)) : [];
		if (!dry) await env.HANDOFF_KV.put(key, JSON.stringify([...new Set([...(prev || []), ...ids])].slice(-5000)));
		if (!prev) {
			report.posted.push({ client: clientForCampaign(meta, c), note: `tracking started (${ids.length} existing matches)` });
			continue;
		}
		if (!newIds.length) continue;

		const client = clientForCampaign(meta, c);
		const lines = [];
		for (const [i, id] of newIds.slice(0, 15).entries()) {
			if (i < DIGEST_DETAILS) {
				let show = null;
				try {
					show = await pp.call('get_account_podcast', { podcast_id: id });
				} catch {
					/* names only */
				}
				const m = metrics(show);
				const title = show?.title || names[id];
				lines.push(
					`• ${m.apple ? `<${m.apple}|${esc(title)}>` : esc(title)}${m.spotify ? ` (<${m.spotify}|Spotify>)` : ''}${m.short ? ` · ${m.short}` : ''}`,
				);
			} else {
				lines.push(`• ${esc(names[id])}`);
			}
		}
		if (newIds.length > 15) lines.push(`…and ${newIds.length - 15} more`);
		const text =
			`*${esc(client)}*: ${newIds.length} new podcast match${newIds.length === 1 ? '' : 'es'} today\n` +
			`Campaign: ${esc(c.name)}\n${lines.join('\n')}`;
		if (!dry)
			await deps.slackPost(env, channel, {
				text: `${client}: ${newIds.length} new podcast matches`,
				blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2990) } }],
				unfurl_links: false,
			});
		report.posted.push({ client, campaign: c.name, new_matches: newIds.length });
	}
	return report;
}

/* =========================================================================
 * Clients, campaigns, metrics
 * ========================================================================= */

async function loadMeta(env, pp, force = false) {
	const cached = JSON.parse((await env.HANDOFF_KV.get('pp:meta')) || 'null');
	if (!force && cached && Date.now() - cached.at < META_TTL_MS) return cached;
	const campaigns = [];
	let before = null;
	for (let page = 0; page < 3; page++) {
		const res = await pp.call('list_campaigns', { limit: 50, ...(before ? { before_id: before } : {}) });
		for (const c of res?.campaigns || []) {
			campaigns.push({
				id: c.id,
				name: c.name,
				status: c.status,
				paused: c.paused,
				profile_id: c.profile_id,
				database: c.database,
				from_email: c.from_email || [],
			});
		}
		if (!res?.next_before_id || !(res?.campaigns || []).length) break;
		before = res.next_before_id;
	}
	const profiles = {};
	try {
		const res = await pp.call('list_profiles', {});
		for (const p of res?.profiles || []) profiles[p.id] = { name: p.name, company: p.company || '' };
	} catch (err) {
		console.warn(`PodPitch profiles: ${err.message}`);
	}
	const meta = { at: Date.now(), campaigns, profiles };
	await env.HANDOFF_KV.put('pp:meta', JSON.stringify(meta));
	return meta;
}

// Asks PodPitch which of the campaigns sending from this inbox contains the podcast.
// Result cached 90 days per podcast, so each podcast costs these lookups only once.
async function campaignForEntity(env, pp, meta, t) {
	if (!t.entity_id) return null;
	const key = `ppentity:${t.entity_id}:${String(t.email || '').toLowerCase()}`;
	const cachedId = await env.HANDOFF_KV.get(key);
	if (cachedId) return meta.campaigns.find((c) => String(c.id) === cachedId) || null;
	const inbox = String(t.email || '').toLowerCase();
	const fromInbox = meta.campaigns.filter((c) => (c.from_email || []).map((e) => e.toLowerCase()).includes(inbox));
	// Active campaigns first; at most 4 lookups per reply (free plan: 50 requests per run).
	const ordered = [...fromInbox.filter((c) => c.status !== 'off'), ...fromInbox.filter((c) => c.status === 'off')].slice(0, 4);
	for (const c of ordered) {
		try {
			const r = await pp.call('get_campaign_drafts', { campaign_id: Number(c.id), entity_id: String(t.entity_id), limit: 1 });
			if ((r?.drafts || []).some((d) => String(d.entity_id) === String(t.entity_id))) {
				await env.HANDOFF_KV.put(key, String(c.id), { expirationTtl: 90 * 24 * 3600 });
				return c;
			}
		} catch (err) {
			console.warn(`PodPitch drafts lookup ${c.id}: ${err.message}`);
		}
	}
	return null;
}

function clientForCampaign(meta, c) {
	const p = meta.profiles[c.profile_id];
	if (p?.name) return p.company ? `${p.name} (${p.company})` : p.name;
	return String(c.name || 'Unknown client')
		.split(/\s+[-–|]\s*|\s*-\s+/)[0]
		.trim();
}

// Which client a host reply belongs to: the active campaign sending from that inbox;
// if several share the inbox, the one whose client name appears in the pitch.
function resolveClient(meta, t, extraText = '') {
	const inbox = String(t.email || '').toLowerCase();
	const fromInbox = meta.campaigns.filter((c) => (c.from_email || []).map((e) => e.toLowerCase()).includes(inbox));
	const pool = fromInbox.filter((c) => c.status !== 'off').length ? fromInbox.filter((c) => c.status !== 'off') : fromInbox;
	const hay = `${t.subject || ''} ${t.preview || ''} ${extraText}`.toLowerCase();
	const named = pool.filter((c) => {
		const p = meta.profiles[c.profile_id];
		const first = String(p?.name || c.name || '')
			.split(/\s+/)[0]
			.toLowerCase();
		const full = String(p?.name || '').toLowerCase();
		return (full && hay.includes(full)) || (first.length > 2 && hay.includes(first));
	});
	const pick = named.length === 1 ? named[0] : pool.length === 1 ? pool[0] : named[0] || null;
	if (!pick) return { name: `Unknown client (${t.email || '?'})`, campaign: '', unsure: true };
	return { name: clientForCampaign(meta, pick), campaign: pick.name, unsure: !(named.length === 1 || pool.length === 1) };
}

function metrics(show) {
	if (!show) return { line: '', short: '' };
	const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? null : Number(n).toLocaleString('en-US'));
	const yt = (show.social_followers || []).find((s) => s.social_platform === 'youtube');
	const apple = show.url ? String(show.url).replace(/\?uo=\d+$/, '') : '';
	const spotify = show.spotify_id ? `https://open.spotify.com/show/${show.spotify_id}` : '';
	const youtube = show.youtube_channel_url || (yt?.social_id ? `https://www.youtube.com/@${yt.social_id}` : '');
	const listeners = show.est_weekly_downloads != null ? fmt(show.est_weekly_downloads * 4) : null;
	const parts = [];
	if (listeners) parts.push(`~${listeners} monthly listeners (est.)`);
	if (show.spotify_followers != null) parts.push(`Spotify ${fmt(show.spotify_followers)} followers`);
	if (yt?.followers != null) parts.push(`YouTube ${fmt(yt.followers)} subs`);
	if (show.total_social_followers != null) parts.push(`${fmt(show.total_social_followers)} social followers`);
	if (show.average_itunes_rating_us)
		parts.push(`Apple ${Number(show.average_itunes_rating_us).toFixed(1)}★ (${fmt(show.itunes_review_count_us) || 0} reviews)`);
	if (show.ep_count)
		parts.push(`${fmt(show.ep_count)} episodes${show.eps_last_month != null ? `, ${show.eps_last_month} last month` : ''}`);
	const short = [
		listeners && `~${listeners} listeners/mo`,
		yt?.followers != null && `YouTube ${fmt(yt.followers)}`,
		show.spotify_followers != null && `Spotify ${fmt(show.spotify_followers)}`,
	]
		.filter(Boolean)
		.join(' · ');
	return { line: parts.join(' · '), short, apple, spotify, youtube, host: show.host || '' };
}

function statusLabel(t, hasBooking) {
	const base =
		t.ai_label_name ||
		{ positive_reply: 'Positive reply', meeting_requested: 'Meeting requested', negative_reply: 'Negative reply' }[t.category] ||
		(t.category ? t.category.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'New reply');
	return hasBooking ? `${base} · booking link received` : base;
}

/* =========================================================================
 * Text helpers
 * ========================================================================= */

function htmlToText(html) {
	const links = [];
	const s = String(html || '')
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
			links.push(href);
			return `${label.replace(/<[^>]+>/g, '')} `;
		})
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
		.replace(/<blockquote[\s\S]*$/i, '') // quoted history usually starts with a blockquote
		.replace(/<div class=["']gmail_quote[\s\S]*$/i, '')
		.replace(/<[^>]+>/g, ' ');
	return decode(s)
		.replace(/[ \t ]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

// Cuts the quoted history: Gmail ("On ... wrote:"), Outlook ("From: ... Sent:/Date: ... To: ... Subject:"),
// "-----Original Message-----", "________________" separators and ">" quoted lines.
function latestOnly(text) {
	let t = String(text);
	const patterns = [
		/\n?\s*On\s[^\n]{0,60}\d[^\n]{0,200}?wrote:/i,
		/\n\s*-{2,}\s*Original Message/i,
		/\n\s*_{8,}/,
		/\n\s*From:\s[^\n]+\n\s*(Sent|Date):\s/i,
		/\n\s*From:\s[^\n]*<[^>\n]+@[^>\n]+>[^\n]*\n[\s\S]{0,200}?\n\s*Subject:\s/i,
	];
	let cut = -1;
	for (const re of patterns) {
		const i = t.search(re);
		if (i > 0 && (cut === -1 || i < cut)) cut = i;
	}
	if (cut > 0) t = t.slice(0, cut);
	return t
		.split('\n')
		.filter((l) => !/^\s*>/.test(l))
		.join('\n')
		.trim();
}

// Keeps the card readable: at most 14 lines / 900 characters, signature marketing cut.
function trimMessage(text) {
	let lines = String(text)
		.split('\n')
		.map((l) => l.trim());
	const sigStart = lines.findIndex((l, i) => i > 1 && /^(--\s*$|sent from my (iphone|android|phone)|get outlook for)/i.test(l.trim()));
	if (sigStart > 0) lines = lines.slice(0, sigStart);
	let out = lines.slice(0, 14).join('\n');
	if (lines.length > 14) out += '\n…';
	return out.length > 900 ? out.slice(0, 900) + '…' : out;
}

function findBookingLinks(html) {
	const urls = new Set();
	for (const m of decode(String(html || '')).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
		const u = m[0].replace(/[.,;]+$/, '');
		if (BOOKING_HOSTS.test(u)) urls.add(u);
	}
	return [...urls].slice(0, 3);
}

const decode = (s) =>
	String(s)
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#39;|&rsquo;|&apos;/g, "'")
		.replace(/&quot;|&ldquo;|&rdquo;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const esc = (s) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
const quote = (s) =>
	esc(s)
		.split('\n')
		.map((l) => `>${l}`)
		.join('\n');
const fromEmail = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '')).trim().toLowerCase();
const shortUrl = (u) => {
	try {
		const x = new URL(u);
		return (x.hostname + x.pathname).replace(/\/$/, '');
	} catch {
		return u;
	}
};
const button = (label, url) => ({
	type: 'button',
	text: { type: 'plain_text', text: label },
	url: String(url).slice(0, 3000),
	action_id: `pp_link_${label.toLowerCase().replace(/\W+/g, '_')}`,
});
const ourDomains = (env) =>
	String(env.PODPITCH_OUR_DOMAINS || 'trustpointxposure.com')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

/* =========================================================================
 * PodPitch connection (OAuth refresh + MCP over HTTP)
 * ========================================================================= */

async function connect(env) {
	const token = await accessToken(env);
	let sessionId = null;
	let id = 100;
	// One retry for slow or temporarily failing requests (timeouts, 5xx, 429).
	const post = async (body) => {
		try {
			return await postOnce(body);
		} catch (err) {
			if (!/timed out|HTTP 5\d\d|HTTP 429|fetch failed|network/i.test(err.message)) throw err;
			await new Promise((r) => setTimeout(r, 1500));
			return postOnce(body);
		}
	};
	const postOnce = async (body) => {
		const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
		if (sessionId) headers['Mcp-Session-Id'] = sessionId;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
			sessionId = res.headers.get('mcp-session-id') || sessionId;
			const text = await res.text();
			if (res.status === 401) {
				if (env.PP_AUTH)
					await env.PP_AUTH.get(env.PP_AUTH.idFromName('podpitch'))
						.fetch('https://podpitch-auth/token?invalidate=1')
						.catch(() => {});
				else await env.HANDOFF_KV.delete('pp:access');
				throw new Error('PodPitch login rejected (401)');
			}
			if (!res.ok) throw new Error(`PodPitch HTTP ${res.status}: ${text.slice(0, 200)}`);
			if (body.id === undefined) return null;
			const j = text.trim().startsWith('{')
				? text
				: text
						.split('\n')
						.filter((l) => l.startsWith('data:'))
						.map((l) => l.slice(5).trim())
						.filter(Boolean)
						.pop() || '{}';
			return JSON.parse(j);
		} catch (err) {
			throw new Error(err.name === 'AbortError' ? 'PodPitch timed out' : err.message);
		} finally {
			clearTimeout(timer);
		}
	};
	await post({
		jsonrpc: '2.0',
		id: id++,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tpx-podpitch-updates', version: '1.0' } },
	});
	await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
	return {
		async call(name, args) {
			if (!READ_TOOLS.has(name)) throw new Error(`Blocked PodPitch tool: ${name}`);
			const r = await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
			if (r?.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 200)}`);
			if (r?.result?.isError)
				throw new Error(
					`${name}: ${(r.result.content || [])
						.map((c) => c.text)
						.join(' ')
						.slice(0, 200)}`,
				);
			if (r?.result?.structuredContent) return r.result.structuredContent;
			const t = (r?.result?.content || [])
				.filter((c) => c.type === 'text')
				.map((c) => c.text)
				.join('\n');
			try {
				return JSON.parse(t);
			} catch {
				return { text: t };
			}
		},
	};
}

// Refresh tokens may be replaced on every refresh, so the newest one is kept in KV.
// If the KV one stops working (for example after a new login), the PODPITCH_OAUTH secret is tried.
async function accessToken(env) {
	// Preferred: the PodpitchAuth Durable Object (one refresh at a time, always the newest token).
	if (env.PP_AUTH) {
		const stub = env.PP_AUTH.get(env.PP_AUTH.idFromName('podpitch'));
		const r = await stub.fetch('https://podpitch-auth/token');
		const d = await r.json().catch(() => ({}));
		if (!d.token) throw new Error(d.error || `PodPitch login holder ${r.status}`);
		return d.token;
	}
	const cached = JSON.parse((await env.HANDOFF_KV.get('pp:access')) || 'null');
	if (cached?.token && cached.exp - Date.now() > 60e3) return cached.token;
	if (!env.PODPITCH_OAUTH) throw new Error('PODPITCH_OAUTH secret is not set (run podpitch-login.mjs)');
	const o = JSON.parse(env.PODPITCH_OAUTH);
	const candidates = [...new Set([await env.HANDOFF_KV.get('pp:refresh'), o.refresh_token].filter(Boolean))];
	let lastErr = '';
	for (const refresh of candidates) {
		const form = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refresh,
			client_id: o.client_id,
			resource: o.resource || MCP_URL,
		});
		if (o.client_secret) form.set('client_secret', o.client_secret);
		const res = await fetch(o.token_endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: form,
		});
		const t = await res.json().catch(() => ({}));
		if (res.ok && t.access_token) {
			await env.HANDOFF_KV.put('pp:refresh', t.refresh_token || refresh);
			await env.HANDOFF_KV.put(
				'pp:access',
				JSON.stringify({ token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 }),
				{ expirationTtl: Math.max(60, (Number(t.expires_in) || 3600) - 30) },
			);
			return t.access_token;
		}
		lastErr = `${res.status} ${JSON.stringify(t).slice(0, 150)}`;
	}
	throw new Error(`PodPitch login expired (${lastErr}). Run podpitch-login.mjs again and update the PODPITCH_OAUTH secret.`);
}
