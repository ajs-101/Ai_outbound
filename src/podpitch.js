// PodPitch MCP client: finds podcast candidates for a lead.
// SAFETY: only these read-only tools can ever be called. PodPitch's server also has tools that
// send emails or change campaigns (send_pitch, reply_to_inbox_thread, ...); they are blocked here.
const ALLOWED_TOOLS = new Set(['search_podcasts', 'get_podcast_details']);

// Per PodPitch request. 8s fits the old ~30s inline limit; with the reply queue set
// PODPITCH_TIMEOUT_MS (e.g. 15000) in wrangler.jsonc for more patience.
const DEFAULT_TIMEOUT_MS = 8000;
const RESULTS_PER_QUERY = 8; // search_podcasts allows 1-10
const MAX_QUERIES = 3;
const MAX_CANDIDATES = 18; // shows handed to Claude to choose 3 from
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Only podcast-pitch threads get show suggestions.
export function isPodcastThread(event) {
	const text = `${event.reply_subject || ''}\n${event.reply_text || ''}`;
	return /podcast/i.test(text);
}

/* ---------- search terms ---------- */

// Fallback search terms from the lead fields Instantly already has.
export function buildQueries(event) {
	const clean = (s) =>
		String(s || '')
			.replace(/[^\p{L}\p{N}&'\- ]+/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	const firstWords = (s, n) => clean(s).split(' ').slice(0, n).join(' ');
	const raw = [
		event.subIndustry,
		event.industry || event['Company industry'],
		firstWords(event.headline, 6),
		firstWords(event.companyDescription || event.summary, 6),
		[event.jobTitle, event.industry].filter(Boolean).join(' '),
	];
	const seen = new Set();
	const out = [];
	for (const q of raw.map(clean)) {
		const key = q.toLowerCase();
		if (q.length >= 3 && !seen.has(key)) {
			seen.add(key);
			out.push(q.slice(0, 120));
		}
		if (out.length >= MAX_QUERIES) break;
	}
	return out;
}

// Better search terms: a small, fast Claude call reads the lead's profile and email signature
// and returns topic searches ("dementia care", "senior living") instead of job titles.
async function buildQueriesAI(env, event, latest) {
	if (!env.ANTHROPIC_API_KEY) return [];
	const profile = [
		`Name: ${[event.firstName, event.lastName].filter(Boolean).join(' ')}`,
		`Title: ${event.jobTitle || ''}`,
		`Headline: ${String(event.headline || '').slice(0, 300)}`,
		`Industry: ${[event.industry, event.subIndustry].filter(Boolean).join(' / ')}`,
		`Company: ${event.companyName || ''}`,
		`Company website: ${event.companyWebsite || event.website || ''}`,
		`Company description: ${String(event.companyDescription || event.summary || '').slice(0, 500)}`,
		`Their latest email (with signature): ${String(latest || '').slice(0, 800)}`,
	].join('\n');
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), Number(env.PODPITCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetch(ANTHROPIC_URL, {
			method: 'POST',
			signal: ctrl.signal,
			headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
			body: JSON.stringify({
				model: env.QUERY_MODEL || 'claude-haiku-4-5',
				max_tokens: 150,
				system:
					"You pick podcast search terms. Given a professional's profile, return 3 short podcast search queries (2 to 4 words each) about the topics, industry and audience their ideal podcast would cover. Use topics, never job titles or company names. Return ONLY a JSON array of strings.",
				messages: [{ role: 'user', content: profile }],
			}),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const text = (data.content || [])
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('');
		const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
		return (Array.isArray(arr) ? arr : [])
			.map((q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 80))
			.filter((q) => q.length >= 3)
			.slice(0, MAX_QUERIES);
	} catch (err) {
		console.warn(`PodPitch query builder fell back to lead fields: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/* ---------- main entry points ---------- */

export async function findPodcastCandidates(env, event, latest = '') {
	// search_podcasts and get_podcast_details are public PodPitch tools (no account needed),
	// so PODPITCH_API_KEY is optional: sent if set, otherwise the request goes without it.
	if (!env.PODPITCH_MCP_URL) return { candidates: [], queries: [], error: 'PodPitch not configured' };

	let queries = await buildQueriesAI(env, event, latest);
	if (!queries.length) queries = buildQueries(event);
	if (!queries.length) return { candidates: [], queries, error: 'No industry or headline data for this lead' };

	try {
		// One retry: PodPitch is sometimes slow to open a session.
		const session = await openSession(env).catch(() => openSession(env));
		const results = await Promise.all(
			queries.map((q) =>
				callTool(env, session, 'search_podcasts', { query: q, limit: RESULTS_PER_QUERY })
					.catch(() => callTool(env, session, 'search_podcasts', { query: q, limit: RESULTS_PER_QUERY }))
					.catch((e) => ({ error: e.message })),
			),
		);
		logSample(results);
		const byId = new Map();
		for (const r of results) {
			for (const show of extractShows(r)) {
				const key = show.id || show.name.toLowerCase();
				if (!byId.has(key)) byId.set(key, show);
			}
		}
		const candidates = [...byId.values()].slice(0, MAX_CANDIDATES);
		const errors = results.filter((r) => r?.error).map((r) => r.error);
		return { candidates, queries, session, error: candidates.length ? null : errors[0] || 'No shows found' };
	} catch (err) {
		return { candidates: [], queries, error: err.message };
	}
}

// For the shows Claude picked that came back without an Apple / Spotify link, ask PodPitch for details.
export async function addListenLinks(env, shows, sessionId) {
	const need = shows.filter((s) => !s.url && s.id);
	if (!need.length || !env.PODPITCH_MCP_URL) return shows;
	try {
		const session = sessionId || (await openSession(env));
		const details = await Promise.all(
			need.map((s) => callTool(env, session, 'get_podcast_details', { podcast_id: s.id }).catch((e) => ({ error: e.message }))),
		);
		need.forEach((s, i) => {
			const d = details[i];
			if (d?.error) {
				console.warn(`PodPitch details for ${s.name}: ${d.error}`);
				return;
			}
			const links = pickLinks(resultData(d));
			if (links.best) {
				s.url = links.best;
				s.apple = links.apple;
				s.spotify = links.spotify;
			}
		});
	} catch (err) {
		console.warn(`PodPitch details failed: ${err.message}`);
	}
	return shows;
}

/* ---------- MCP over streamable HTTP ---------- */

async function openSession(env) {
	const init = await post(env, null, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tpx-handoff', version: '1.1' } },
	});
	if (init.json?.error) throw new Error(`initialize: ${JSON.stringify(init.json.error).slice(0, 200)}`);
	await post(env, init.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
	return init.sessionId;
}

let rpcId = 10;
async function callTool(env, sessionId, name, args) {
	if (!ALLOWED_TOOLS.has(name)) throw new Error(`Blocked PodPitch tool: ${name}`);
	const r = await post(env, sessionId, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
	if (r.json?.error) throw new Error(`${name}: ${JSON.stringify(r.json.error).slice(0, 200)}`);
	if (r.json?.result?.isError) throw new Error(`${name}: ${toolText(r.json.result).slice(0, 200)}`);
	return r.json?.result || {};
}

async function post(env, sessionId, body) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		...(env.PODPITCH_API_KEY ? { Authorization: `Bearer ${env.PODPITCH_API_KEY}` } : {}),
	};
	if (sessionId) headers['Mcp-Session-Id'] = sessionId;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), Number(env.PODPITCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetch(env.PODPITCH_MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
		const sid = res.headers.get('mcp-session-id') || sessionId;
		if (body.id === undefined) return { sessionId: sid };
		const jsonText = text.trim().startsWith('{')
			? text
			: text
					.split('\n')
					.filter((l) => l.startsWith('data:'))
					.map((l) => l.slice(5).trim())
					.filter(Boolean)
					.pop() || '{}';
		return { sessionId: sid, json: JSON.parse(jsonText) };
	} catch (err) {
		throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
	} finally {
		clearTimeout(timer);
	}
}

/* ---------- reading PodPitch results ---------- */

function toolText(result) {
	return (result?.content || [])
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

function resultData(result) {
	if (!result || result.error) return null;
	if (result.structuredContent) return result.structuredContent;
	const t = toolText(result);
	try {
		return JSON.parse(t);
	} catch {
		return t ? { text: t } : null;
	}
}

// One sample per run in `wrangler tail`, so the real PodPitch field names are visible.
function logSample(results) {
	const first = results.find((r) => r && !r.error);
	if (!first) return;
	const data = resultData(first);
	const list = listOf(data);
	console.log(`PodPitch sample result: ${JSON.stringify(list[0] ?? data).slice(0, 1500)}`);
}

function listOf(data) {
	if (Array.isArray(data)) return data;
	const l = data?.podcasts || data?.results || data?.items || data?.data || data?.hits || data?.shows || [];
	return Array.isArray(l) ? l : [];
}

// Walks every field of a show and collects its URLs, then picks Apple > Spotify > YouTube > website.
function pickLinks(obj) {
	const urls = [];
	const walk = (v, depth) => {
		if (depth > 5 || v == null) return;
		if (typeof v === 'string') {
			for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) urls.push(m[0].replace(/[.,;]+$/, ''));
		} else if (Array.isArray(v)) {
			v.forEach((x) => walk(x, depth + 1));
		} else if (typeof v === 'object') {
			Object.values(v).forEach((x) => walk(x, depth + 1));
		}
	};
	walk(obj, 0);
	const usable = urls.filter(
		(u) =>
			!/\.(jpe?g|png|gif|webp|svg|mp3|m4a)(\?|$)/i.test(u) &&
			!/\/(feed|rss)(\/|\?|$)|\.xml(\?|$)|feeds\.|anchor\.fm\/s\/.+\/podcast\/rss/i.test(u),
	);
	const apple = usable.find((u) => /podcasts\.apple\.com|itunes\.apple\.com/i.test(u)) || '';
	const spotify = usable.find((u) => /open\.spotify\.com/i.test(u)) || '';
	const youtube = usable.find((u) => /youtube\.com|youtu\.be/i.test(u)) || '';
	const other = usable.find((u) => !/podpitch\.com/i.test(u)) || '';
	return { apple, spotify, best: apple || spotify || youtube || other };
}

function extractShows(result) {
	return listOf(resultData(result))
		.map((p) => {
			const d = p?.document || p; // some search engines wrap hits as {document: {...}}
			const name = d.title || d.name || d.podcast_name || d.show_name || '';
			const links = pickLinks(d);
			return {
				id: String(d.id || d.podcast_id || d.uuid || ''),
				name: String(name).slice(0, 150),
				description: String(d.description || d.summary || '')
					.replace(/<[^>]+>/g, ' ')
					.replace(/\s+/g, ' ')
					.slice(0, 300),
				genre: String(d.primary_genre || d.genre || (Array.isArray(d.genres) ? d.genres.slice(0, 3).join(', ') : '') || ''),
				url: links.best,
				apple: links.apple,
				spotify: links.spotify,
			};
		})
		.filter((s) => s.name);
}
