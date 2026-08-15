// The checks that only make sense across the whole site.
//
// checkSeo() in assets/js/seo-check.js looks at one page at a time, which is
// the right shape for the panel in the editor but blind to a whole class of
// problem. Nothing about /rodent-control on its own tells you that
// /rodent-control and /mosquito-control now carry the same title; nothing
// about /preparation tells you that the page it links to was renamed. Those
// only appear once you have read every page and can compare them.
//
// So these take the whole set. Measured against the site as it stands today:
// no duplicate titles, no duplicate descriptions, no orphans, and one broken
// internal link -- ../orb-weaver-spider on the garden orb weaver page, which
// resolves one directory too high because the page is served without a
// trailing slash. One real finding and three that currently say nothing is
// the intended balance: the duplicate checks exist because the editor can now
// rewrite titles, and copying one across two pages is the easiest mistake in
// the whole tool to make by accident.

// Links to other sites are not this tool's business, and neither are mailto:
// or tel:. Absolute links back to the site's own domain are, though -- pages
// here mix relative paths with fully-qualified ones.
const SITE_HOST = /(^|\.)tcbpestcontrolcanberra\.com\.au$/i;
const FALLBACK_ORIGIN = "https://www.tcbpestcontrolcanberra.com.au";

// Where a link actually goes, as a path, or null if it leaves the site.
//
// Resolution is against the page's own URL, which is the part worth being
// careful about: `../orb-weaver-spider` means different things depending on
// whether the page is served as /spider-control/garden-orb-weaver-spider or
// /spider-control/garden-orb-weaver-spider/. This site serves the first form
// (html_handling is "none", so there is no trailing-slash redirect), and the
// browser resolves against that -- so this has to as well, or it would clear
// a link that is broken for every visitor.
export function linkTarget(href, pagePath, origin = FALLBACK_ORIGIN) {
	const raw = String(href || "").trim();
	if (!raw || raw.startsWith("#")) return null;
	// mailto:, tel:, sms:, javascript: -- anything with a scheme that is not http(s).
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return null;

	let base;
	let url;
	try {
		base = new URL(pagePath, origin);
		url = new URL(raw, base);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// The request origin covers previews and staging; the canonical domain
	// covers the fully-qualified links written into the pages themselves.
	if (url.host !== base.host && !SITE_HOST.test(url.hostname)) return null;

	// The query and fragment do not change which page is being asked for.
	const path = url.pathname.replace(/\/+$/, "");
	return path === "" ? "/" : path;
}

// Two pages carrying the same title are competing for the same search result,
// and Google picks one -- so this is a problem rather than a suggestion.
// Descriptions are softer: Google rewrites them often enough that a repeated
// one costs an opportunity rather than a place, so it is worth a look.
function duplicates(pages, field) {
	const groups = new Map();
	for (const page of pages) {
		const value = String(page[field] || "").trim().toLowerCase();
		if (!value) continue; // A missing one is already reported per-page.
		if (!groups.has(value)) groups.set(value, []);
		groups.get(value).push(page.path);
	}
	return [...groups.entries()]
		.filter(([, paths]) => paths.length > 1)
		.map(([value, paths]) => ({ value, paths }));
}

// `pages` is [{ path, title, description, targets }] gathered by the scan,
// where `targets` are internal link destinations as paths. `broken` is the
// subset of those destinations that were checked and did not load.
//
// `complete` matters for orphans and only for orphans: a page looks unlinked
// until the page that links to it has been read, so a half-finished scan
// would invent orphans that do not exist. Duplicates have no such problem --
// two pages sharing a title share it whether or not the rest were read.
export function checkSite({ pages = [], broken = [], complete = true } = {}) {
	const findings = [];

	for (const group of duplicates(pages, "title")) {
		findings.push({
			level: "problem",
			message: `${group.paths.length} pages share the same title, so they compete with each other in Google.`,
			detail: group.value,
			fix: "Give each one a title naming what makes it different — usually the suburb or the pest. Two pages called the same thing are asking Google to choose between them, and it will pick one and drop the rest.",
			pages: group.paths,
		});
	}

	for (const group of duplicates(pages, "description")) {
		findings.push({
			level: "worth a look",
			message: `${group.paths.length} pages share the same description.`,
			detail: group.value,
			fix: "Worth a sentence each that is actually about that page. Not urgent — Google often writes its own description anyway — but a repeated one wastes the chance to say something specific.",
			pages: group.paths,
		});
	}

	// Reported per destination rather than per link: one renamed page linked
	// from nine others is one thing to fix, not nine.
	const linkedFrom = new Map();
	for (const page of pages) {
		for (const target of page.targets || []) {
			if (!linkedFrom.has(target)) linkedFrom.set(target, []);
			linkedFrom.get(target).push(page.path);
		}
	}
	for (const target of broken) {
		const sources = linkedFrom.get(target) || [];
		findings.push({
			level: "problem",
			message: `${target} is linked to but does not exist, so anyone clicking it lands on the 404 page.`,
			fix: "Either point the link at the page that replaced it, or take the link out. A dead link on a service page costs an enquiry, not just a ranking.",
			detail: sources.length ? `Linked from ${sources.slice(0, 5).join(", ")}` : undefined,
			pages: sources,
		});
	}

	if (complete) {
		// A link from a page to itself does not rescue it, or every page would
		// look reachable through its own canonical link.
		const orphans = pages
			.map((page) => page.path)
			.filter((path) => path !== "/")
			.filter((path) => !(linkedFrom.get(path) || []).some((from) => from !== path));
		if (orphans.length) {
			findings.push({
				level: "worth a look",
				message: `${orphans.length} ${orphans.length === 1 ? "page has" : "pages have"} nothing linking to them, so the only way in is a search result.`,
				detail: orphans.slice(0, 5).join(", "),
				fix: "Add a link to it from a page people do reach — the relevant service page, or the list it belongs on. Google treats a page nothing links to as one the site does not think much of.",
				pages: orphans,
			});
		}
	}

	const order = { problem: 0, "worth a look": 1, good: 2 };
	return findings.sort((a, b) => order[a.level] - order[b.level]);
}

// Which link destinations still need checking. Anything that was scanned and
// answered is known to exist already, so the only fetches worth spending are
// the ones nothing has confirmed -- on this site that is eight destinations
// out of a hundred and forty-two, nearly all of them PDFs.
export function unverifiedTargets(pages, known) {
	const seen = new Set(known);
	const targets = new Set();
	for (const page of pages) {
		for (const target of page.targets || []) {
			if (!seen.has(target)) targets.add(target);
		}
	}
	return [...targets];
}
