// Lead research: reads the lead's website, looks up the lead's PUBLIC LinkedIn profile through web
// search (linkedin.com itself is never fetched or scraped), finds 1-2 pain points, and runs an
// approximate AI visibility check. Read-only: it only reads public pages and search results.
//
// What goes where:
//   firm_summary + personal_hook + pain_points -> given to the drafting model (it may use ONE pain point)
//   pain point sources / evidence              -> shown on the Slack card so the team can check them
//   ai_visibility                              -> shown to the team on the Slack card ONLY, never in the email

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PAGE_TIMEOUT_MS = 8000;
const PAGE_MAX_CHARS = 3500;
const RESEARCH_TIMEOUT_MS = 60000;
const CACHE_TTL_SECONDS = 30 * 24 * 3600;   // one research per person per 30 days
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };   // 2 profile + 3 AI visibility

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|zoho|mail|yandex|comcast|att|verizon|sbcglobal|bellsouth|cox|charter)\./i;

// Skip research when there is nothing to sell: stop requests, out of office, hard no.
export function shouldResearch(latest) {
  const t = String(latest || "").toLowerCase();
  if (!t.trim()) return false;
  // "Not interested" / "no thanks" ARE researched: the reply to a soft no uses one specific gap from the research.
  // Hard stops (unsubscribe, remove me, do not contact) and auto-replies are not.
  return !/(unsubscribe|remove me|take me off|stop emailing|stop contacting|do not contact|don't contact|do not email|don't email|out of (the )?office|on vacation|on leave|auto-?reply|automatic reply)/i.test(t);
}

export function websiteFor(event) {
  const raw = event.companyWebsite || event.website || event.companyDomain || "";
  if (raw) {
    const u = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try { return new URL(u).origin; } catch { /* fall through */ }
  }
  const email = String(event.lead_email || "");
  if (email.includes("@") && !FREE_MAIL.test(email)) return `https://${email.split("@")[1].toLowerCase()}`;
  return "";
}

export async function researchLead(env, event, latest) {
  const site = websiteFor(event);
  // Per person: pain points come partly from the person's own profile, so colleagues get their own.
  const cacheKey = `research2:${String(event.lead_email || linkedinFor(event) || site || "unknown").toLowerCase()}`;
  const cached = await env.HANDOFF_KV.get(cacheKey);
  if (cached) return { ...JSON.parse(cached), cached: true };

  const pages = site ? await readSite(site) : { text: "", pages: [], error: "No website for this lead" };
  const out = { website: site, pages_read: pages.pages, site_error: pages.error || "" };

  try {
    Object.assign(out, await analyse(env, event, latest, site, pages.text, true));
  } catch (err) {
    // Web search switched off or failing: still give the website summary, flag the missing check.
    if (pages.text) {
      try {
        Object.assign(out, await analyse(env, event, latest, site, pages.text, false));
        out.search_error = err.message;
      } catch (err2) {
        out.error = err2.message;
      }
    } else {
      out.error = err.message;
    }
  }

  // Cache only useful results, so a temporary failure is retried next time.
  if (!out.error && (out.firm_summary || out.pain_points?.length || out.ai_visibility)) {
    await env.HANDOFF_KV.put(cacheKey, JSON.stringify({ ...out, researched_at: Date.now() }), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return out;
}

/* ---------- website ---------- */

async function readSite(origin) {
  const pages = [];
  let text = "";
  let error = "";
  const home = await fetchPage(origin);
  if (home.error) return { text: "", pages, error: home.error };
  pages.push(origin);
  text += `HOMEPAGE (${origin})\n${home.text}\n`;

  // One more page that usually says what the firm does and who they serve.
  const next = pickInnerLink(home.html, origin);
  if (next) {
    const inner = await fetchPage(next);
    if (!inner.error) { pages.push(next); text += `\nPAGE (${next})\n${inner.text}\n`; }
    else error = `${next}: ${inner.error}`;
  }
  return { text: text.slice(0, PAGE_MAX_CHARS * 2), pages, error };
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TPX-research/1.0)", Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (!/html/i.test(res.headers.get("content-type") || "html")) return { error: "not an HTML page" };
    const html = (await res.text()).slice(0, 400000);
    return { html, text: htmlToText(html).slice(0, PAGE_MAX_CHARS) };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || "";
  const body = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|article|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return `Title: ${decode(title)}\nDescription: ${decode(desc)}\n${body}`;
}

const decode = (s) => String(s).replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

function pickInnerLink(html, origin) {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const links = [...String(html).matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const wanted = /(about|practice|services|what-we-do|our-firm|attorneys|team|areas|specialt|treatments|who-we-are)/i;
  for (const href of links) {
    let u;
    try { u = new URL(href, origin); } catch { continue; }
    if (u.hostname.replace(/^www\./, "") !== host) continue;
    if (u.pathname === "/" || !wanted.test(u.pathname)) continue;
    if (/\.(pdf|jpe?g|png|zip)$/i.test(u.pathname)) continue;
    return u.origin + u.pathname;
  }
  return "";
}

export function linkedinFor(event) {
  const raw = event.linkedIn || event.linkedin || event.LinkedIn || event.linkedin_url || event.linkedinUrl || event.personLinkedin || "";
  const m = String(raw).match(/linkedin\.com\/in\/[^/?#\s]+/i);
  return m ? `https://www.${m[0].toLowerCase()}` : "";
}

/* ---------- Claude: summary, profile, pain points, AI visibility (web search) ---------- */

async function analyse(env, event, latest, site, siteText, useSearch) {
  const lead = [
    `Name: ${[event.firstName, event.lastName].filter(Boolean).join(" ")}`,
    `Title: ${event.jobTitle || ""}`,
    `Headline: ${String(event.headline || "").slice(0, 300)}`,
    `Company: ${event.companyName || ""}`,
    `Industry: ${[event.industry, event.subIndustry].filter(Boolean).join(" / ")}`,
    `Location: ${event.location || event.City || ""}`,
    `Website: ${site || "unknown"}`,
    `LinkedIn profile URL: ${linkedinFor(event) || "unknown"}`,
    `Profile summary from our lead data: ${String(event.summary || event.personSummary || event.about || "").slice(0, 500)}`,
    `Their latest email (signature often says what they do): ${String(latest || "").slice(0, 600)}`,
  ].join("\n");

  const system = `You research a prospect for a PR and AI visibility agency. Be factual and brief.
Tasks:
1. From the WEBSITE TEXT and lead info, write firm_summary: one line on what the firm does, for whom, and where.
2. personal_hook: one specific, true detail from the website a salesperson could mention naturally (a practice area, a city, a specialty, a program). Never personal or sensitive details. Empty string if nothing clear.
${useSearch
  ? `3. LinkedIn profile: search for the person's PUBLIC LinkedIn profile and posts (for example: "<full name>" "<company>" LinkedIn), at most 2 searches. Use only what the search results show (headline, role, about text, recent post topics). Never guess. If you cannot find the right person for sure, set profile_note to "".
4. AI visibility check: think of the search a potential client would type into an AI assistant to find a firm like this, for example "best personal injury lawyer in Houston". Run that search with web_search (at most 3 searches). Report whether this firm shows up in the top results, and which competing firms show up instead.`
  : `3. No search is available this time: use only the website text and the lead info for the profile (profile_note from the headline / profile summary if given, else "").
4. Set ai_visibility.query to the search a client would use, found to "unclear", and competitors to [].`}
5. pain_points: up to 2 business problems this person or firm likely has that our service helps with (getting known, trust and credibility, being found on Google and AI assistants, standing out from competitors, getting featured on podcasts and in the press). Every pain point MUST rest on something concrete you actually saw:
   - source "website": e.g. no press or media page, no client reviews or case results shown, a thin or outdated site, a new firm or new office, a launch or expansion
   - source "linkedin": e.g. they post about growth or hiring, they are a new founder or in a new role, they want to be known as an expert, they speak at events
   - source "lead data": from the title / headline / company info we gave you
   - source "ai search": they do not show up in step 4 while competitors do
   "evidence" quotes or describes exactly what you saw. "angle" is one soft, natural line a salesperson could say, without saying where it came from (good: "a lot of newer firms find it hard to get in front of the right clients early on"; bad: "I saw your website has no reviews").
   "observation" is the same gap said DIRECTLY and specifically, as one factual sentence a salesperson could say to them when they push back (good: "your site doesn't mention a single podcast or press feature"; "when I asked ChatGPT for the top wealth managers in Houston, it named X and Y, not you"). Only what you actually saw, no exaggeration, no insult.
   Prefer gaps that are concrete and checkable over generic ones.
   No evidence = no pain point. Never use personal, health, financial or sensitive details. Fewer is better than weak.
Never invent facts. If the website text is empty, rely only on the lead info and the searches, and say so in confidence.
Return ONLY this JSON, no prose:
{"firm_summary":"","specialty":"","city":"","personal_hook":"","profile_note":"one line on the person from LinkedIn, or empty","pain_points":[{"pain":"","source":"website | linkedin | lead data | ai search","evidence":"","angle":"","observation":""}],"ai_visibility":{"query":"","found":"yes | no | unclear","position_note":"","competitors":["max 3 firm names"]},"confidence":"high | medium | low"}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.RESEARCH_MODEL || env.CLAUDE_MODEL,
        max_tokens: 1800,
        system,
        ...(useSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
        messages: [{ role: "user", content: `LEAD\n${lead}\n\nWEBSITE TEXT\n${siteText || "(none)"}` }],
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      // Most common: web search not switched on for the organisation in the Anthropic Console.
      throw new Error(`Claude research ${res.status}: ${raw.slice(0, 200)}`);
    }
    const data = JSON.parse(raw);
    const searches = (data.content || []).filter((c) => c.type === "server_tool_use").length;
    const textBlocks = (data.content || []).filter((c) => c.type === "text").map((c) => c.text);
    const last = textBlocks.join("\n");
    const start = last.lastIndexOf("{\"firm_summary\"") !== -1 ? last.lastIndexOf("{\"firm_summary\"") : last.indexOf("{");
    const obj = JSON.parse(last.slice(start, last.lastIndexOf("}") + 1));
    const vis = obj.ai_visibility || {};
    return {
      firm_summary: String(obj.firm_summary || "").slice(0, 300),
      specialty: String(obj.specialty || "").slice(0, 120),
      city: String(obj.city || "").slice(0, 80),
      personal_hook: String(obj.personal_hook || "").slice(0, 250),
      profile_note: String(obj.profile_note || "").slice(0, 250),
      pain_points: (Array.isArray(obj.pain_points) ? obj.pain_points : [])
        .map((p) => ({
          pain: String(p?.pain || "").slice(0, 160),
          source: ["website", "linkedin", "lead data", "ai search"].includes(String(p?.source || "").toLowerCase()) ? String(p.source).toLowerCase() : "",
          evidence: String(p?.evidence || "").slice(0, 220),
          angle: String(p?.angle || "").slice(0, 220),
          observation: String(p?.observation || "").slice(0, 240),
        }))
        .filter((p) => p.pain && p.source && p.evidence)   // no source or evidence = dropped
        .slice(0, 2),
      linkedin_url: linkedinFor(event),
      ai_visibility: {
        query: String(vis.query || "").slice(0, 150),
        found: ["yes", "no", "unclear"].includes(vis.found) ? vis.found : "unclear",
        position_note: String(vis.position_note || "").slice(0, 200),
        competitors: (Array.isArray(vis.competitors) ? vis.competitors : []).map((c) => String(c).slice(0, 80)).slice(0, 3),
      },
      confidence: ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "low",
      searches,
      search_used: useSearch,
    };
  } catch (err) {
    throw new Error(err.name === "AbortError" ? "research timed out" : err.message);
  } finally {
    clearTimeout(timer);
  }
}