// The cross-page checks: duplicate titles and descriptions, broken internal
// links, and pages nothing links to.
//
// These are the checks that cannot be made a page at a time, and the ones
// most likely to be quietly wrong -- a link resolver that is a directory out
// reports the whole site as broken, and an orphan check run over a partial
// scan invents orphans that do not exist. Both are pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSite, linkTarget, unverifiedTargets, bodySketch, sketchSimilarity, NEAR_DUPLICATE } from "../assets/js/seo-site.js";

const page = (path, extra = {}) => ({
	path,
	title: `Something specific about ${path}`,
	description: `A description for ${path}`,
	targets: [],
	...extra,
});

const problems = (findings) => findings.filter((finding) => finding.level === "problem");

test("a relative link is resolved against the page's own URL", () => {
	// The site is served without trailing slashes (html_handling is "none"),
	// so on /spider-control/garden-orb-weaver-spider the browser treats
	// /spider-control/ as the directory. "../orb-weaver-spider" therefore
	// leaves the folder entirely -- which is a real broken link on this site
	// today, and the reason this function resolves rather than string-joins.
	assert.equal(linkTarget("../orb-weaver-spider", "/spider-control/garden-orb-weaver-spider"), "/orb-weaver-spider");
	assert.equal(linkTarget("orb-weaver-spider", "/spider-control/garden-orb-weaver-spider"), "/spider-control/orb-weaver-spider");
	assert.equal(linkTarget("../../residential", "/spider-control/garden-orb-weaver-spider"), "/residential");
	assert.equal(linkTarget("/contact", "/anything"), "/contact");
});

test("links off the site, and non-links, are ignored", () => {
	assert.equal(linkTarget("https://www.google.com/", "/"), null);
	assert.equal(linkTarget("mailto:phill@tcbpestcontrolcanberra.com.au", "/"), null);
	assert.equal(linkTarget("tel:+61262551234", "/"), null);
	assert.equal(linkTarget("#main", "/"), null);
	assert.equal(linkTarget("", "/"), null);
	assert.equal(linkTarget("javascript:void(0)", "/"), null);
});

test("the site's own absolute links are internal", () => {
	// Pages here mix relative paths with fully-qualified ones, and a check
	// that only understood the relative form would miss half the site.
	assert.equal(linkTarget("https://www.tcbpestcontrolcanberra.com.au/termite-treatment", "/"), "/termite-treatment");
	assert.equal(linkTarget("https://www.tcbpestcontrolcanberra.com.au/", "/"), "/");
});

test("the query and the fragment do not change which page is meant", () => {
	assert.equal(linkTarget("/book?service=termites#form", "/"), "/book");
	assert.equal(linkTarget("/contact/", "/"), "/contact");
});

test("a healthy site reports nothing", () => {
	// As things stand this is the real answer for all 134 pages, so it is the
	// case that has to stay quiet.
	const pages = [page("/"), page("/spider-control", { targets: ["/"] }), page("/contact", { targets: ["/"] })];
	pages[0].targets = ["/spider-control", "/contact"];
	assert.deepEqual(checkSite({ pages, broken: [] }), []);
});

test("two pages sharing a title is a problem, and both are named", () => {
	const findings = problems(
		checkSite({
			pages: [
				page("/rodent-control", { title: "Pest Control Canberra | TCB", targets: ["/mosquito-control"] }),
				page("/mosquito-control", { title: "Pest Control Canberra | TCB", targets: ["/rodent-control"] }),
			],
		})
	);
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /2 pages share the same title/);
	assert.deepEqual(findings[0].pages, ["/rodent-control", "/mosquito-control"]);
});

test("a shared description is mentioned but is not called a problem", () => {
	// Google rewrites descriptions often enough that a repeated one costs an
	// opportunity rather than a place in the results.
	const findings = checkSite({
		pages: [
			page("/a", { description: "The same words twice.", targets: ["/b"] }),
			page("/b", { description: "The same words twice.", targets: ["/a"] }),
		],
	});
	assert.deepEqual(problems(findings), []);
	assert.equal(findings.filter((finding) => finding.level === "worth a look").length, 1);
});

test("differences in case and spacing do not make two titles distinct", () => {
	const findings = problems(
		checkSite({
			pages: [
				page("/a", { title: "Termite Treatment", targets: ["/b"] }),
				page("/b", { title: "  termite treatment  ", targets: ["/a"] }),
			],
		})
	);
	assert.equal(findings.length, 1);
});

test("pages with no title at all are left to the per-page check", () => {
	// Otherwise a site with two untitled pages would report them as duplicates
	// of each other, which is true and useless -- "this page has no title" is
	// already reported against each of them.
	const findings = checkSite({
		pages: [page("/a", { title: "", targets: ["/b"] }), page("/b", { title: "", targets: ["/a"] })],
	});
	assert.deepEqual(findings.filter((finding) => /share the same title/.test(finding.message)), []);
});

test("a broken link is reported once, against the pages that point at it", () => {
	const findings = problems(
		checkSite({
			pages: [
				page("/preparation", { targets: ["/gone", "/resources"] }),
				page("/resources", { targets: ["/gone", "/preparation"] }),
			],
			broken: ["/gone"],
		})
	);
	assert.equal(findings.length, 1, "one dead destination is one thing to fix, not two");
	assert.match(findings[0].message, /\/gone is linked to but does not exist/);
	assert.match(findings[0].detail, /Linked from \/preparation, \/resources/);
});

test("a page nothing links to is flagged, and the homepage never is", () => {
	const findings = checkSite({
		pages: [page("/", { targets: ["/contact"] }), page("/contact", { targets: ["/"] }), page("/forgotten")],
	});
	const orphan = findings.find((finding) => /nothing linking to them/.test(finding.message));
	assert.ok(orphan);
	assert.deepEqual(orphan.pages, ["/forgotten"]);
});

test("a page linking only to itself is still an orphan", () => {
	// Every page here links to its own canonical URL, so counting self-links
	// would make the check permanently silent.
	const findings = checkSite({ pages: [page("/"), page("/lonely", { targets: ["/lonely"] })] });
	const orphan = findings.find((finding) => /nothing linking to them/.test(finding.message));
	assert.deepEqual(orphan.pages, ["/lonely"]);
});

test("a half-finished scan does not invent orphans", () => {
	// The page that links to /contact simply has not been read yet. Reporting
	// it as unreachable would be the check's worst failure mode: confident,
	// specific and wrong.
	const findings = checkSite({ pages: [page("/contact")], complete: false });
	assert.deepEqual(findings.filter((finding) => /nothing linking to them/.test(finding.message)), []);

	// Duplicates have no such problem -- two pages sharing a title share it
	// whether or not the rest of the site has been read.
	const partial = checkSite({
		pages: [page("/a", { title: "Same" }), page("/b", { title: "Same" })],
		complete: false,
	});
	assert.equal(problems(partial).length, 1);
});

test("only destinations nothing has confirmed are queued for a fetch", () => {
	// The scan reads every page in the sitemap, so those need no second look.
	// On the real site this reduces 142 destinations to eight.
	const pages = [
		{ path: "/", targets: ["/contact", "/assets/documents/guide.pdf"] },
		{ path: "/contact", targets: ["/", "/assets/documents/guide.pdf", "/gone"] },
	];
	assert.deepEqual(unverifiedTargets(pages, ["/", "/contact"]), ["/assets/documents/guide.pdf", "/gone"]);
});

test("two pages sharing a main heading are named together", () => {
	const findings = checkSite({
		pages: [
			page("/a", { h1: "Pest control in Kambah.", targets: ["/b"] }),
			page("/b", { h1: "Pest control in Kambah.", targets: ["/a"] }),
		],
	});
	const shared = findings.find((finding) => /share the same main heading/.test(finding.message));
	assert.ok(shared);
	assert.equal(shared.level, "worth a look");
	assert.deepEqual(shared.pages, ["/a", "/b"]);

	// Older scans carry no h1 field; that is not 134 pages sharing "".
	assert.deepEqual(
		checkSite({ pages: [page("/a", { targets: ["/b"] }), page("/b", { targets: ["/a"] })] }).filter((finding) =>
			/main heading/.test(finding.message)
		),
		[]
	);
});

test("a business block missing a field is one finding, not one per page", () => {
	// The block is a shared template: on the real site all 134 pages carry an
	// org with no address, and that is one fact.
	const findings = checkSite({
		pages: [
			page("/a", { orgMissing: ["address"], targets: ["/b"] }),
			page("/b", { orgMissing: ["address"], targets: ["/a"] }),
		],
	});
	const org = findings.filter((finding) => /business details block/.test(finding.message));
	assert.equal(org.length, 1);
	assert.match(org[0].message, /missing address — on every page/);
});

test("a redirected internal link is worth a look, with the destination named", () => {
	const findings = checkSite({
		pages: [page("/a", { targets: ["/old-name", "/b"] }), page("/b", { targets: ["/a"] })],
		redirected: [{ target: "/old-name", location: "/new-name" }],
	});
	const hop = findings.find((finding) => /redirects/.test(finding.message));
	assert.ok(hop);
	assert.equal(hop.level, "worth a look", "the redirect works; this is not a broken link");
	assert.match(hop.message, /\/old-name.*redirects to \/new-name/);
	assert.deepEqual(hop.pages, ["/a"]);
});

test("a linked page missing from the sitemap is surfaced", () => {
	const findings = checkSite({
		pages: [page("/", { targets: ["/hidden", "/contact"] }), page("/contact", { targets: ["/"] })],
		extraPages: ["/hidden"],
	});
	const hidden = findings.find((finding) => /not in the sitemap/.test(finding.message));
	assert.ok(hidden);
	assert.deepEqual(hidden.pages, ["/hidden"]);
});

test("body sketches: copies read as copies, and the location pages do not", () => {
	const words = (seed) =>
		Array.from({ length: 300 }, (unused, at) => `${seed}word${at % 90}`).join(" ");
	const same = sketchSimilarity(bodySketch(words("a")), bodySketch(words("a")));
	const different = sketchSimilarity(bodySketch(words("a")), bodySketch(words("b")));
	assert.equal(same, 1);
	assert.equal(different, 0);
	// The real location pages measure ~0.25 against each other; the threshold
	// has to sit far enough above that they never read as copies.
	assert.ok(NEAR_DUPLICATE >= 0.5);
});

test("near-identical bodies are grouped into one finding", () => {
	const text = Array.from({ length: 200 }, (unused, at) => `word${at}`).join(" ");
	const nearly = `${text} with a couple of extra words`;
	const other = Array.from({ length: 200 }, (unused, at) => `entirely${at} different${at}`).join(" ");
	const findings = checkSite({
		pages: [
			page("/a", { sketch: bodySketch(text), targets: ["/b", "/c"] }),
			page("/b", { sketch: bodySketch(nearly), targets: ["/a"] }),
			page("/c", { sketch: bodySketch(other), targets: ["/a"] }),
		],
	});
	const copies = findings.filter((finding) => /nearly identical body text/.test(finding.message));
	assert.equal(copies.length, 1);
	assert.deepEqual(copies[0].pages.sort(), ["/a", "/b"]);
});

test("findings are ordered worst first", () => {
	const findings = checkSite({
		pages: [
			page("/a", { title: "Same", description: "Same", targets: ["/b"] }),
			page("/b", { title: "Same", description: "Same", targets: ["/a"] }),
		],
	});
	assert.equal(findings[0].level, "problem");
	assert.equal(findings[findings.length - 1].level, "worth a look");
});
