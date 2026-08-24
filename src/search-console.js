// What people actually searched for before they landed on the site.
//
// Every other check in this editor is an opinion about the site: this title
// is long, that image has no description. They are worth having, but they are
// all guesses about what a search engine will do. Search Console is the only
// source here that reports what actually happened -- which phrases showed the
// site, how often anyone clicked, and where the site sat on the page.
//
// The point is not a dashboard. Google already has one, and it is better than
// anything that would fit in this panel. The point is that this editor can
// rewrite titles and descriptions, so the useful thing is the short list of
// pages where rewriting one would pay: shown often, clicked rarely. That
// question is answerable here and awkward to answer in Google's interface.
//
// Read-only, and scoped to one property that has to be shared with the
// service account by hand.

import { accessToken, readServiceAccount } from "./google-auth.js";
import { normalisePath } from "../assets/js/content-address.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

// Search Console data is two to three days behind. Asking for yesterday
// returns an empty row set, which reads exactly like "nobody found you".
const LAG_DAYS = 3;
const WINDOW_DAYS = 28;

export function missingConfig(env) {
	return env.GOOGLE_SERVICE_ACCOUNT ? [] : ["GOOGLE_SERVICE_ACCOUNT"];
}

export function isConfigured(env) {
	return missingConfig(env).length === 0;
}

// Instructions, not a bare "not configured". Whoever reads this has to go and
// do it, in two different Google products, and is not a developer. Returned
// as steps rather than a paragraph so the panel can lay them out as a list --
// six instructions run together is a wall nobody follows.
export function setupSteps() {
	return [
		"Go to console.cloud.google.com, create a project (any name), and under APIs & Services → Library enable the “Google Search Console API”.",
		"Under APIs & Services → Credentials, create a Service Account. Open it, then Keys → Add key → Create new key → JSON, and download the file.",
		"Open that file and copy everything in it, braces included.",
		"In the Cloudflare dashboard: Workers → tcbpestreal → Settings → Variables and Secrets. Add a Secret named exactly GOOGLE_SERVICE_ACCOUNT and paste the file in as the value.",
		"In Search Console: Settings → Users and permissions → Add user. Paste the service account's email address — it ends in .iam.gserviceaccount.com and is the client_email in that file — and give it Restricted access.",
	];
}

export function setupMessage() {
	return [
		"Search Console isn't connected yet. It takes about ten minutes, once.",
		...setupSteps().map((step, index) => `${index + 1}. ${step}`),
		"That last step is what actually grants access, and it is the one people miss.",
	].join(" ");
}

// The reporting window, as Search Console wants it. `today` is injectable so
// the arithmetic can be tested without waiting for tomorrow.
export function reportingWindow(today = new Date()) {
	const end = new Date(today.getTime());
	end.setUTCDate(end.getUTCDate() - LAG_DAYS);
	const start = new Date(end.getTime());
	start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
	const iso = (date) => date.toISOString().slice(0, 10);
	return { startDate: iso(start), endDate: iso(end), days: WINDOW_DAYS };
}

// Which of the properties the service account can see is this site.
//
// Search Console has two kinds of property and the difference is invisible
// from here: a domain property is "sc-domain:example.com" and covers every
// subdomain and both schemes, while a URL-prefix property is a full URL and
// covers only exactly that prefix. A site can have either, or both. Picking
// the domain property first means the answer covers www and bare alike.
export function pickSite(entries, hostname) {
	const sites = (entries || []).map((entry) => entry.siteUrl).filter(Boolean);
	const bare = String(hostname || "").replace(/^www\./i, "").toLowerCase();
	if (!bare) return null;

	const domainProperty = sites.find((site) => site.toLowerCase() === `sc-domain:${bare}`);
	if (domainProperty) return domainProperty;

	const exact = sites.find((site) => {
		try {
			return new URL(site).hostname.toLowerCase() === String(hostname).toLowerCase();
		} catch {
			return false;
		}
	});
	if (exact) return exact;

	// Anything else on the same domain -- an http:// property, or the bare
	// host when the site is served from www.
	return (
		sites.find((site) => {
			try {
				return new URL(site).hostname.toLowerCase().replace(/^www\./, "") === bare;
			} catch {
				return false;
			}
		}) || null
	);
}

async function call(token, path, options = {}) {
	const response = await fetch(`${API}${path}`, {
		...options,
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		if (response.status === 403) {
			throw new Error(
				"Google says this service account is not allowed to read the property. In Search Console, go to Settings → " +
					"Users and permissions and add the service account's email address as a user."
			);
		}
		if (response.status === 401) {
			throw new Error("Google rejected the sign-in. The service account key may have been deleted or disabled.");
		}
		throw new Error(`Search Console returned ${response.status}: ${detail.slice(0, 200)}`);
	}
	return response.json();
}

export function listSites(token) {
	return call(token, "/sites").then((body) => body.siteEntry || []);
}

export function queryAnalytics(token, site, body) {
	return call(token, `/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
		method: "POST",
		body: JSON.stringify(body),
	}).then((result) => result.rows || []);
}

// Rows come back as { keys: [...], clicks, impressions, ctr, position }.
const row = (entry) => ({
	key: (entry.keys || [])[0] || "",
	clicks: entry.clicks || 0,
	impressions: entry.impressions || 0,
	ctr: entry.ctr || 0,
	position: entry.position || 0,
});

export function totals(rows) {
	const clicks = rows.reduce((sum, entry) => sum + entry.clicks, 0);
	const impressions = rows.reduce((sum, entry) => sum + entry.impressions, 0);
	return { clicks, impressions, ctr: impressions ? clicks / impressions : 0 };
}

// The two questions worth asking of this data from inside a text editor.
//
// Deliberately ranked rather than flagged. Every other check here says
// "problem" or "worth a look", because those thresholds were calibrated
// against the real site. These cannot be -- the numbers depend on a Search
// Console account nobody has connected yet -- so inventing a line and
// declaring everything past it broken would be a guess wearing a verdict's
// clothes. A ranked shortlist with the real numbers next to it lets whoever
// reads it make the call.
export function opportunities({ pages = [], queries = [], siteCtr = 0 } = {}) {
	// Shown often, clicked rarely. The title and description are the entire
	// basis on which someone decides, and they are both editable here.
	const missed = pages
		.filter((page) => page.impressions >= 50 && page.ctr < siteCtr)
		.map((page) => ({ ...page, missedClicks: (siteCtr - page.ctr) * page.impressions }))
		.filter((page) => page.missedClicks >= 5)
		.sort((a, b) => b.missedClicks - a.missedClicks)
		.slice(0, 8);

	// Sitting at the top of page two. Position 8 to 20 is the band where the
	// site is already considered relevant and is not being seen.
	const nearlyThere = queries
		.filter((entry) => entry.position >= 8 && entry.position <= 20 && entry.impressions >= 10)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 8);

	return { missed, nearlyThere };
}

// Which pages of the site Google shows for which searches.
//
// Needed to tell three very different situations apart when a page is shown
// for a phrase it does not mention: another page already answers it better
// (leave well alone), another page should answer it and is behind (fix that
// page), or nothing answers it (this page, or a new one). Without this the
// only available advice is "put the words here", which on a site with a
// dedicated page per pest is frequently the wrong answer.
export async function rankings(token, site, window) {
	const rows = await queryAnalytics(token, site, {
		startDate: window.startDate,
		endDate: window.endDate,
		type: "web",
		dimensions: ["query", "page"],
		rowLimit: 1000,
	});

	const byQuery = {};
	for (const entry of rows) {
		const [query, pageUrl] = entry.keys || [];
		if (!query || !pageUrl) continue;
		let pagePath;
		try {
			pagePath = normalisePath(new URL(pageUrl).pathname);
		} catch {
			continue;
		}
		if (!byQuery[query]) byQuery[query] = [];
		byQuery[query].push({
			path: pagePath,
			position: entry.position || 0,
			impressions: entry.impressions || 0,
			clicks: entry.clicks || 0,
		});
	}
	return byQuery;
}

// Everything the panel needs, in one call. `path` narrows the query list to
// one page, for the SEO check on the page being edited. `withRankings` adds
// the site-wide query-to-page map, which is only worth the extra request when
// a single page is being looked at.
export async function insights(env, { hostname, path = null, today = new Date(), withRankings = false } = {}) {
	const account = readServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
	const token = await accessToken(account, SCOPE);

	const site = env.SEARCH_CONSOLE_SITE || pickSite(await listSites(token), hostname);
	if (!site) {
		throw new Error(
			`This service account cannot see a Search Console property for ${hostname}. In Search Console, go to Settings → ` +
				`Users and permissions and add ${account.client_email} as a user of the property.`
		);
	}

	const window = reportingWindow(today);
	const base = { startDate: window.startDate, endDate: window.endDate, type: "web" };
	const filters = path
		? [{ filters: [{ dimension: "page", operator: "includingRegex", expression: `${escapeRegex(path)}/?$` }] }]
		: undefined;

	const [queryRows, pageRows] = await Promise.all([
		queryAnalytics(token, site, {
			...base,
			dimensions: ["query"],
			rowLimit: 100,
			...(filters ? { dimensionFilterGroups: filters } : {}),
		}),
		// Page totals are only meaningful for the whole site; for one page the
		// query list above already is the page.
		path ? Promise.resolve([]) : queryAnalytics(token, site, { ...base, dimensions: ["page"], rowLimit: 200 }),
	]);

	const queries = queryRows.map(row);
	const pages = pageRows.map(row);
	const siteTotals = totals(pages.length ? pages : queries);

	return {
		site,
		window,
		totals: siteTotals,
		queries: queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 25),
		opportunities: opportunities({ pages, queries, siteCtr: siteTotals.ctr }),
		rankings: withRankings ? await rankings(token, site, window).catch(() => null) : null,
	};
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
