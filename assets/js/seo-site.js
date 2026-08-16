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
		const example = waste.changes[0];
		findings.push({
			level: "worth a look",
			message: `${waste.changes.length} titles end with “| ${waste.ending}” and already say the last word earlier in the title.`,
			detail: `Changing the ending to “| ${waste.replacement}” on those frees ${waste.freed} characters each — for example “${example.from}” becomes “${example.to}”.`,
			fix: `Those ${waste.freed} characters are room for the suburb, the pest or the species. Only the repeated word comes off: the business name stays, and every other page keeps the ending it has. Fix applies it to all ${waste.changes.length} at once and leaves any page you have already edited alone.`,
			pages: waste.redundant,
			action: { kind: "titles", ending: waste.ending, replacement: waste.replacement, count: waste.changes.length },
		});
	}

	// Titles that do not follow the shape the rest of the site uses.
	const outliers = conventionOutliers(pages);
	if (outliers) {
		findings.push({
			level: "worth a look",
			message: `${outliers.odd.length} ${outliers.odd.length === 1 ? "title does" : "titles do"} not follow the shape the other ${outliers.following} use.`,
			detail: `Every other title on the site ends with “| ” and the business name. These do not, so they read as a different site in the search results.`,
			fix: "Nothing here is wrong on its own — the lengths are fine — which is why the page-by-page checks pass them. It only shows up against the other titles. Worth rewriting rather than just bolting the usual ending on: “About TCB Pest Control Canberra” with the ending appended says the business name twice and is worse than what it replaced.",
			pages: outliers.odd,
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
// The first version of this got the arithmetic badly wrong, and the mistake is
// worth recording because it was invisible from the diagnosis alone.
//
// It counted every ending word the front half repeated -- pest, control and
// canberra -- concluded 103 titles were wasting 22 characters each, and
// recommended shortening the ending to "| TCB". Two things were wrong with
// that. "Pest Control" is the business's actual name, so repeating it is the
// unavoidable cost of being called TCB Pest Control rather than a fault to
// fix. And shortening every ending to "| TCB" would have dropped 61 of the
// 110 titles below the 30-character minimum -- trading one finding for
// sixty-one, in a panel whose entire job is to reduce that number.
//
// Neither error shows up while you are only describing a problem. Both were
// obvious the moment the repair was written out and measured. So this now
// proposes a specific replacement, applies it, and checks the result against
// the same length rules every other title is held to -- and only reports what
// survives that.
// The shortest sign-off the business will answer to.
//
// Nothing in the algorithm can work this out. It sees "TCB Pest Control
// Canberra", notices the front half of most titles says "control", and
// removing it looks like exactly the same kind of win as removing "Canberra"
// -- it frees more characters and passes every length rule. What it cannot
// see is that "TCB Pest" is not the name of anything.
//
// Left without a floor the fix ratchets. Pressing it once settles the site on
// "| TCB Pest Control", which is right; the next scan then finds "control"
// repeated across 86 titles and proposes "| TCB Pest", and the one after that
// would keep going until the length rules stopped it. Each step is locally
// reasonable and the destination is nonsense.
export const MINIMUM_ENDING = "TCB Pest Control";

export function suffixWaste(pages, { minPages = 10, minTitle = 30, maxTitle = 62, minimumEnding = MINIMUM_ENDING } = {}) {
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

	const words = commonest.ending.split(/\s+/);
	if (words.length < 2) return null;

	// Candidate replacements, most aggressive last: drop one trailing word,
	// then two, and so on. The first word is the business's name and never
	// goes -- an ending that does not identify the business is not an ending.
	// The floor only means anything when the ending in use is a longer form of
	// it. A site that signs off with something else entirely is not covered by
	// a rule about this business's name, and should not be held to it.
	const floor = String(minimumEnding || "");
	const floored = floor && commonest.ending.toLowerCase().startsWith(floor.toLowerCase()) ? floor.length : 0;

	let best = null;
	for (let drop = 1; drop < words.length; drop++) {
		const replacement = words.slice(0, words.length - drop).join(" ");
		// Candidates only get shorter from here, so this is the end of the
		// search rather than one to skip past.
		if (floored && replacement.length < floored) break;
		const removed = words
			.slice(words.length - drop)
			.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ""))
			.filter(Boolean);
		if (!removed.length) continue;

		// Only the pages whose front half already says one of the words being
		// removed. "About Us | TCB Pest Control Canberra" repeats nothing and
		// has no business being counted, or edited.
		const affected = [];
		let unsafe = false;
		for (const page of commonest.using) {
			const title = String(page.title);
			const head = title.slice(0, title.lastIndexOf("|")).trim();
			if (!removed.some((word) => head.toLowerCase().includes(word))) continue;
			const after = `${head} | ${replacement}`;
			// The repair has to pass the same length rules as everything else.
			// Shortening a title into a fresh "too short" finding is not a fix.
			if (after.length < minTitle || after.length > maxTitle) {
				unsafe = true;
				break;
			}
			affected.push({ path: page.path, from: title, to: after });
		}
		if (unsafe || affected.length < minPages) continue;
		// The first safe candidate wins, not the most aggressive one. Left to
		// maximise characters this picks "| TCB Pest" -- which frees 17 rather
		// than 9 and is safely inside the length rules, and is also not the
		// name of the business. The smallest edit that clears the bar keeps
		// the ending a real reading of the name, and the extra characters are
		// not worth a sign-off that reads like a truncation.
		best = { replacement, affected, freed: commonest.ending.length - replacement.length };
		break;
	}
	if (!best) return null;

	return {
		ending: commonest.ending,
		replacement: best.replacement,
		used: commonest.using.length,
		changes: best.affected,
		redundant: best.affected.map((change) => change.path),
		freed: best.freed,
	};
}

// The pages that do not follow the shape every other title on the site uses.
//
// A convention is only visible from above. Nothing about "About TCB Pest
// Control Canberra" is wrong on its own -- it is 31 characters, inside every
// length rule, and reads fine. What is wrong is that the other 132 titles end
// with "| something" and this one does not, which is a fact no per-page check
// can hold because no page can see the other 133.
//
// Reported rather than fixed. Appending the usual ending to "About TCB Pest
// Control Canberra" produces "About TCB Pest Control Canberra | TCB Pest
// Control", which is worse than what it replaced -- these need a rewrite, and
// a rewrite is a judgement rather than a rule.
// There is deliberately only one proportion here. The first version also
// required that 80% of titles follow the shape, which reads like a second
// safeguard and is arithmetically unreachable: every title either contains a
// separator or does not, so following = total - odd, and a site with under
// 10% outliers necessarily has over 90% followers. Both of the tests written
// for it passed with it deleted. An unreachable guard is worse than no guard,
// because it looks like protection while providing none.
export function conventionOutliers(pages, { maxOddShare = 0.1 } = {}) {
	const titled = pages.filter((page) => String(page.title || "").trim());
	// Too few pages and there is no convention to be outside of -- a shape is
	// only a convention once enough pages have kept to it.
	if (titled.length < 20) return null;

	const following = titled.filter((page) => page.title.includes("|"));
	const odd = titled.filter((page) => !page.title.includes("|"));
	if (!odd.length) return null;
	// A handful against a rule is worth saying. A third of the site against it
	// is not an outlier, it is a disagreement about the rule.
	if (odd.length / titled.length > maxOddShare) return null;

	return { following: following.length, total: titled.length, odd: odd.map((page) => page.path) };
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
