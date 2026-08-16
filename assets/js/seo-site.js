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
// where `targets` are internal link destinations as paths. Newer scans add
// `h1`, `orgMissing`, `wordCount` and `sketch` to each record; the checks
// that read those skip pages that do not carry them, so older callers and
// the tests keep working unchanged. `broken` is the subset of destinations
// that were checked and did not load; `redirected` the ones that answered
// with a redirect, as { target, location }; `extraPages` the ones that
// loaded as real pages despite not being in the sitemap.
//
// `complete` matters for orphans and only for orphans: a page looks unlinked
// until the page that links to it has been read, so a half-finished scan
// would invent orphans that do not exist. Duplicates have no such problem --
// two pages sharing a title share it whether or not the rest were read.
export function checkSite({ pages = [], broken = [], redirected = [], extraPages = [], complete = true } = {}) {
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

	// Main headings, same logic as titles but softer: a heading is not
	// competing in a search result, it is just a sign two pages were copied
	// and one never got its own words.
	for (const group of duplicates(pages, "h1")) {
		findings.push({
			level: "worth a look",
			message: `${group.paths.length} pages share the same main heading.`,
			detail: group.value,
			fix: "Usually one page copied from another and never reworded. Give each a heading naming what makes it different — the suburb or the pest.",
			pages: group.paths,
		});
	}

	// The shared title ending. One finding, because it is one edit.
	const waste = suffixWaste(pages);
	if (waste) {
		findings.push({
			level: "worth a look",
			message: `${waste.redundant.length} titles end with “| ${waste.ending}” and already say those words earlier in the title.`,
			detail: `Shortening the ending to “| ${waste.brand}” frees ${waste.freed} characters on each of them.`,
			fix: `Google cuts titles off around ${62} characters, so those ${waste.freed} characters are the difference between naming the suburb, the pest or the species and running out of room. “Ant Control Canberra | ${waste.ending}” says control and Canberra twice; “Ant Control Canberra — Black, Coastal Brown, Argentine | ${waste.brand}” fits in the same space and answers three more searches. Worth doing as one pass rather than a page at a time.`,
			pages: waste.redundant,
		});
	}

	// The business block in the structured data is one shared template, so a
	// field missing from it is missing everywhere at once -- one fact, one
	// finding, however many pages carry the block.
	const orgGroups = new Map();
	for (const page of pages) {
		if (!Array.isArray(page.orgMissing) || !page.orgMissing.length) continue;
		const key = [...page.orgMissing].sort().join(", ");
		if (!orgGroups.has(key)) orgGroups.set(key, []);
		orgGroups.get(key).push(page.path);
	}
	for (const [missing, paths] of orgGroups) {
		findings.push({
			level: "worth a look",
			message: `The business details block (structured data) is missing ${missing} — on ${paths.length === pages.length ? "every page" : `${paths.length} pages`}.`,
			fix: "It is one shared block in the page code, so this is one fix, not one per page. Google's local results lean on the business schema, and an address is the field that anchors it to Canberra. Worth passing to whoever maintains the site.",
			pages: paths.slice(0, 6),
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

	// A link that lands after a redirect is not broken -- _redirects keeps old
	// addresses alive on purpose -- but it is a link written to the old name.
	// Visitors survive the hop; internal links should still say where things
	// actually are.
	for (const hop of redirected) {
		const sources = linkedFrom.get(hop.target) || [];
		findings.push({
			level: "worth a look",
			message: `${hop.target} is linked to but redirects${hop.location ? ` to ${hop.location}` : ""}.`,
			fix: `The redirect keeps the old address working, so nothing is broken — but the links are written to a name the page no longer lives at. Point them at ${hop.location || "the final address"} directly.`,
			detail: sources.length ? `Linked from ${sources.slice(0, 5).join(", ")}` : undefined,
			pages: sources,
		});
	}

	// Pages that load fine but are not in the sitemap. The scan's universe is
	// the sitemap, so these are pages the whole tool -- and Google's crawl
	// list -- cannot see past a link. Deliberate for a private page; for
	// anything else it is a page competing with one hand tied.
	if (extraPages.length) {
		findings.push({
			level: "worth a look",
			message: `${extraPages.length} linked ${extraPages.length === 1 ? "page is" : "pages are"} not in the sitemap, so Google is not being told ${extraPages.length === 1 ? "it exists" : "they exist"}.`,
			detail: extraPages.slice(0, 5).join(", "),
			fix: "If a page is meant to be found, it belongs in sitemap.xml — that is the list Google works from, and the list this scan checks. If it is meant to be private, this is fine as it is.",
			pages: extraPages,
		});
	}

	// Two pages saying the same thing in the same words. Titles compete in a
	// search result; whole bodies compete for being worth indexing at all --
	// Google folds near-identical pages together and picks one. Measured on
	// sketches rather than full text so 134 pages can be compared in the
	// browser without shipping every body across the wire.
	for (const group of nearDuplicateBodies(pages)) {
		findings.push({
			level: "worth a look",
			message: `${group.length} pages have nearly identical body text.`,
			detail: group.join(", "),
			fix: "Google folds near-copies together and shows only one. A few sentences that are true of one suburb and not the other — the street names, the pest pressure, the job that keeps coming up — is what keeps them distinct.",
			pages: group,
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

// -- near-duplicate bodies ---------------------------------------------------
//
// A page's body reduced to a small sketch that two pages can be compared on.
// The scan cannot ship 134 full bodies to the browser, and does not need to:
// eight-word shingles hashed, keeping the SKETCH_SIZE smallest hashes, is a
// standard minhash sketch -- the overlap of two sketches estimates the
// overlap of the texts. The location pages, which genuinely share a template
// voice, measure around 0.25 against each other; the threshold sits at 0.6 so
// only real copy-paste trips it.

const SKETCH_SIZE = 64;
const SHINGLE_WORDS = 8;
export const NEAR_DUPLICATE = 0.6;

function hashShingle(text) {
	// FNV-1a, 32-bit. Nothing about this needs to be cryptographic; it needs
	// to be the same in the Worker and the browser.
	let hash = 0x811c9dc5;
	for (let at = 0; at < text.length; at++) {
		hash ^= text.charCodeAt(at);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function bodySketch(text) {
	const words = (String(text || "").toLowerCase().match(/[a-z0-9']+/g) || []);
	if (words.length < SHINGLE_WORDS) return [];
	const hashes = new Set();
	for (let at = 0; at + SHINGLE_WORDS <= words.length; at++) {
		hashes.add(hashShingle(words.slice(at, at + SHINGLE_WORDS).join(" ")));
	}
	return [...hashes].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

// Estimated Jaccard similarity of the two original texts, from their
// sketches: of the smallest SKETCH_SIZE hashes across both, how many are in
// both. Standard bottom-k minhash.
export function sketchSimilarity(a, b) {
	if (!a || !b || !a.length || !b.length) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	const union = [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, SKETCH_SIZE);
	let shared = 0;
	for (const hash of union) if (setA.has(hash) && setB.has(hash)) shared++;
	return shared / union.length;
}

// Groups of pages whose bodies are nearly the same, transitively -- if A
// matches B and B matches C, the three are one group and one finding.
function nearDuplicateBodies(pages) {
	const sketched = pages.filter((page) => Array.isArray(page.sketch) && page.sketch.length);
	const groupOf = new Map();
	for (let a = 0; a < sketched.length; a++) {
		for (let b = a + 1; b < sketched.length; b++) {
			if (sketchSimilarity(sketched[a].sketch, sketched[b].sketch) < NEAR_DUPLICATE) continue;
			const pathA = sketched[a].path;
			const pathB = sketched[b].path;
			const group = groupOf.get(pathA) || groupOf.get(pathB) || [];
			// If both already sit in different groups, this pair joins them.
			const other = groupOf.get(pathA) && groupOf.get(pathB) && groupOf.get(pathA) !== groupOf.get(pathB) ? groupOf.get(pathB) : null;
			if (other) {
				for (const path of other) {
					group.push(path);
					groupOf.set(path, group);
				}
				other.length = 0;
			}
			for (const path of [pathA, pathB]) {
				if (!group.includes(path)) group.push(path);
				groupOf.set(path, group);
			}
		}
	}
	return [...new Set(groupOf.values())].filter((group) => group.length > 1);
}

// The ending most titles share, and what it is costing them.
//
// This exists because the per-page checks are a ruler. They measure whether a
// title is the right size and say nothing about what is in it, so
// "Pest Control Canberra | TCB Pest Control Canberra" passes as a perfectly
// good 49 characters while spending 22 of them saying the same three words
// twice.
//
// The obvious fix -- flag any title that repeats a word -- fires on 115 of
// this site's 134 pages, which is not a check, it is a wall. The repetition
// is not really a property of each page: it comes from one shared ending
// appended to every title, and it is one decision to change, not 115. So it
// is measured once, across the site, and reported once.
//
// Returns null when there is nothing worth saying, which is the usual case
// for a site whose ending is already short.
export function suffixWaste(pages, { minPages = 10 } = {}) {
	const endings = new Map();
	for (const page of pages) {
		const title = String(page.title || "").trim();
		const at = title.lastIndexOf("|");
		if (at < 0) continue;
		const ending = title.slice(at + 1).trim();
		if (!ending) continue;
		if (!endings.has(ending)) endings.set(ending, []);
		endings.get(ending).push(page);
	}

	let commonest = null;
	for (const [ending, using] of endings) {
		if (!commonest || using.length > commonest.using.length) commonest = { ending, using };
	}
	if (!commonest || commonest.using.length < minPages) return null;

	// The first word is the name of the business. Everything after it is a
	// description of the business, and a description is what the rest of the
	// title is already for.
	const words = commonest.ending.split(/\s+/);
	if (words.length < 2) return null;
	const brand = words[0];
	const trailing = words.slice(1).map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
	if (!trailing.length) return null;

	// Only the pages whose front half already says one of those words. A page
	// titled "About Us | TCB Pest Control Canberra" is not repeating anything
	// and has no reason to be counted.
	const redundant = commonest.using.filter((page) => {
		const head = String(page.title).slice(0, String(page.title).lastIndexOf("|")).toLowerCase();
		return trailing.some((word) => head.includes(word));
	});
	if (redundant.length < minPages) return null;

	return {
		ending: commonest.ending,
		brand,
		used: commonest.using.length,
		redundant: redundant.map((page) => page.path),
		// What shortening it to the business name alone gives back.
		freed: commonest.ending.length - brand.length,
	};
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
