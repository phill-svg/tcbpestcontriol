// The SEO checks. Pure functions over a summary object, so the thresholds
// and the wording can be tested without a browser.
//
// The bar these have to clear: the site currently has five issues across 134
// pages, so a check that cries wolf would be worse than no check at all --
// people stop reading a panel that is always orange. Several of these tests
// exist to pin that a healthy page reports nothing to fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	checkSeo,
	googlePreview,
	analyseSchema,
	titleWidth,
	TITLE_MIN,
	TITLE_MAX,
	TITLE_MAX_PX,
	DESCRIPTION_MIN,
	DESCRIPTION_MAX,
	BODY_WORDS_MIN,
} from "../assets/js/seo-check.js";

const HEALTHY = {
	title: "Spider Control Canberra | TCB Pest Control Canberra",
	description:
		"Spider treatment across Canberra for funnel-webs, redbacks, white-tails and huntsmen. Same-week availability, family-safe products, written report.",
	h1Count: 1,
	images: [{ src: "/assets/images/a.webp", hasAlt: true, altText: "A huntsman spider on a wall" }],
	links: [{ href: "/book", text: "Book a treatment" }],
	hasCanonical: true,
};

// The same page as collected by a newer collector: every optional field
// present and healthy. The checks gated on these fields must stay quiet here,
// exactly as the older shape stays quiet above.
const HEALTHY_FULL = {
	...HEALTHY,
	path: "/spider-control",
	origin: "https://www.tcbpestcontrolcanberra.com.au",
	canonicalHref: "https://www.tcbpestcontrolcanberra.com.au/spider-control",
	robots: null,
	ogTitle: "Spider Control Canberra | TCB Pest Control Canberra",
	ogDescription:
		"Spider treatment across Canberra for funnel-webs, redbacks, white-tails and huntsmen. Same-week availability, family-safe products, written report.",
	hasOgImage: true,
	wordCount: 800,
	schemaBlocks: 3,
	schemaBroken: 0,
};

const problems = (page) => checkSeo(page).filter((finding) => finding.level === "problem");
const looks = (page) => checkSeo(page).filter((finding) => finding.level === "worth a look");

test("a healthy page reports nothing to fix", () => {
	assert.deepEqual(problems(HEALTHY), []);
	assert.deepEqual(looks(HEALTHY), [], "and nothing to fret about either");
	assert.ok(checkSeo(HEALTHY).every((finding) => finding.level === "good"));
});

test("the real thresholds match what the site already does", () => {
	// The live pages sit inside these bounds, so the numbers are not arbitrary.
	assert.ok(HEALTHY.title.length <= TITLE_MAX && HEALTHY.title.length >= TITLE_MIN);
	assert.ok(HEALTHY.description.length <= DESCRIPTION_MAX && HEALTHY.description.length >= DESCRIPTION_MIN);
});

test("a missing title or description is a problem, not a suggestion", () => {
	assert.equal(problems({ ...HEALTHY, title: "" }).length, 1);
	assert.match(problems({ ...HEALTHY, title: "" })[0].message, /no title/i);
	assert.equal(problems({ ...HEALTHY, description: "" }).length, 1);
	assert.match(problems({ ...HEALTHY, description: "" })[0].message, /no description/i);
});

test("over-long titles and descriptions are flagged with their length", () => {
	const long = checkSeo({ ...HEALTHY, title: "x".repeat(80) });
	assert.equal(long[0].level, "worth a look");
	assert.match(long[0].message, /80 characters/);

	const longDescription = looks({ ...HEALTHY, description: "y".repeat(200) });
	assert.match(longDescription[0].message, /200 characters/);
});

test("a thin title or description is mentioned but not called a problem", () => {
	// These are opportunities, not faults, and saying so keeps the panel
	// credible on a page that is merely terse.
	assert.deepEqual(problems({ ...HEALTHY, title: "Spiders" }), []);
	assert.equal(looks({ ...HEALTHY, title: "Spiders" }).length, 1);
	assert.deepEqual(problems({ ...HEALTHY, description: "Short description here." }), []);
});

test("headings are checked for exactly one", () => {
	assert.match(problems({ ...HEALTHY, h1Count: 0 })[0].message, /no main heading/i);
	assert.match(looks({ ...HEALTHY, h1Count: 3 })[0].message, /3 main headings/);
	assert.deepEqual(checkSeo({ ...HEALTHY, h1Count: 1 }).filter((f) => /heading/.test(f.message)), []);
});

test("images with no alt are reported, and decorative ones are not", () => {
	const missing = problems({
		...HEALTHY,
		images: [
			{ src: "/assets/images/a.webp", hasAlt: false },
			{ src: "/assets/images/b.webp", hasAlt: true, altText: "" },
		],
	});
	assert.equal(missing.length, 1);
	assert.match(missing[0].message, /1 image has no description/);
	assert.match(missing[0].detail, /a\.webp/);
	assert.doesNotMatch(missing[0].detail, /b\.webp/, "an empty alt is a deliberate 'decorative' marker");
});

test("a filename used as alt text is caught", () => {
	// Common when an image is swapped in a hurry, and useless to anyone.
	const finding = looks({
		...HEALTHY,
		images: [{ src: "/assets/images/a.webp", hasAlt: true, altText: "pest-ant-macro.webp" }],
	});
	assert.equal(finding.length, 1);
	assert.match(finding[0].message, /just a filename/);
});

test("vague link text is caught", () => {
	const finding = looks({
		...HEALTHY,
		links: [
			{ href: "/termite-treatment", text: "click here" },
			{ href: "/book", text: "Read more" },
			{ href: "/contact", text: "Get a termite quote" },
		],
	});
	assert.equal(finding.length, 1);
	assert.match(finding[0].message, /2 links say/);
	assert.doesNotMatch(finding[0].detail, /contact/, "descriptive link text is left alone");
});

test("findings are ordered worst first", () => {
	const findings = checkSeo({ ...HEALTHY, title: "", h1Count: 3 });
	const levels = findings.map((finding) => finding.level);
	assert.equal(levels[0], "problem");
	assert.deepEqual([...levels].sort((a, b) => ({ problem: 0, "worth a look": 1, good: 2 })[a] - ({ problem: 0, "worth a look": 1, good: 2 })[b]), levels);
});

test("a fully-collected healthy page still reports nothing", () => {
	// The new fields are gated on presence; present-and-healthy has to be as
	// quiet as absent, or every scan of the real site turns orange at once.
	assert.deepEqual(problems(HEALTHY_FULL), []);
	assert.deepEqual(looks(HEALTHY_FULL), []);
});

test("a noindex is reported before any opinion about wording", () => {
	const findings = problems({ ...HEALTHY_FULL, robots: "noindex, nofollow" });
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /not to index/i);
	// And a robots tag that merely tunes snippets is not a noindex.
	assert.deepEqual(problems({ ...HEALTHY_FULL, robots: "max-image-preview:large" }), []);
});

test("a canonical pointing at another page is a problem", () => {
	const findings = problems({
		...HEALTHY_FULL,
		canonicalHref: "https://www.tcbpestcontrolcanberra.com.au/ant-control",
	});
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /points at \/ant-control/);
});

test("a canonical is fine with or without a trailing slash, and on a preview origin", () => {
	assert.deepEqual(
		problems({ ...HEALTHY_FULL, canonicalHref: "https://www.tcbpestcontrolcanberra.com.au/spider-control/" }),
		[]
	);
	// Previews serve from another origin, but pages canonicalise to the
	// production domain on purpose -- that is correct, not a finding.
	assert.deepEqual(problems({ ...HEALTHY_FULL, origin: "http://127.0.0.1:8787" }), []);
});

test("a canonical on http or another site hands the page away", () => {
	assert.match(
		problems({ ...HEALTHY_FULL, canonicalHref: "http://www.tcbpestcontrolcanberra.com.au/spider-control" })[0].message,
		/insecure/
	);
	assert.match(
		problems({ ...HEALTHY_FULL, canonicalHref: "https://someone-else.example/spider-control" })[0].message,
		/different site/
	);
});

test("social tags out of step with the page are caught", () => {
	// The real first run of this found eight pages sharing a stale og:title.
	const drifted = looks({ ...HEALTHY_FULL, ogTitle: "Office Pest Control in Queanbeyan | TCB Pest Control" });
	assert.equal(drifted.length, 1);
	assert.match(drifted[0].message, /shared is out of step/);

	// Whitespace and case are not drift.
	assert.deepEqual(looks({ ...HEALTHY_FULL, ogTitle: `  ${HEALTHY_FULL.title.toUpperCase()}  ` }), []);

	const noImage = looks({ ...HEALTHY_FULL, hasOgImage: false });
	assert.equal(noImage.length, 1);
	assert.match(noImage[0].message, /No picture/);
});

test("drift findings carry the action the Fix button is built from", () => {
	const title = looks({ ...HEALTHY_FULL, ogTitle: "Stale old title from last year" });
	assert.deepEqual(title[0].action, { kind: "social", field: "title" });
	const description = looks({ ...HEALTHY_FULL, ogDescription: "A stale description" });
	assert.deepEqual(description[0].action, { kind: "social", field: "description" });
});

test("structured data that does not parse is a problem; none at all is worth a look", () => {
	assert.match(problems({ ...HEALTHY_FULL, schemaBroken: 1 })[0].message, /does not parse/);
	assert.match(looks({ ...HEALTHY_FULL, schemaBlocks: 0 })[0].message, /no structured data/);
});

test("analyseSchema reads real-shaped blocks", () => {
	const good = analyseSchema([
		JSON.stringify({ "@context": "https://schema.org", "@type": "ProfessionalService", name: "TCB", telephone: "+61", address: { "@type": "PostalAddress" } }),
		JSON.stringify({ "@type": "BreadcrumbList" }),
	]);
	assert.deepEqual(good, { schemaBlocks: 2, schemaBroken: 0, orgMissing: [] });

	// The real site's block today: an org with no address.
	const missing = analyseSchema([JSON.stringify({ "@type": "ProfessionalService", name: "TCB", telephone: "+61" })]);
	assert.deepEqual(missing.orgMissing, ["address"]);

	const broken = analyseSchema(['{"@type": "ProfessionalService", trailing']);
	assert.equal(broken.schemaBroken, 1);
	assert.equal(broken.orgMissing, null, "a broken block is not an incomplete org");
});

test("thin body text is mentioned, and only when it was measured", () => {
	const finding = looks({ ...HEALTHY_FULL, wordCount: 40 });
	assert.equal(finding.length, 1);
	assert.match(finding[0].message, /only 40 words/);
	assert.ok(HEALTHY.wordCount === undefined, "the older summary shape has no word count");
	assert.deepEqual(looks(HEALTHY), [], "and stays quiet rather than reading absent as zero");
	assert.ok(BODY_WORDS_MIN <= 165, "the thinnest real page, /thank-you at 165 words, must pass");
});

test("a title inside the character count but outside the pixels is caught", () => {
	// Forty W's fit the count easily and the width not at all.
	const wide = "W".repeat(40);
	assert.ok(wide.length <= TITLE_MAX && titleWidth(wide) > TITLE_MAX_PX);
	const findings = looks({ ...HEALTHY, title: wide });
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /measures wide/);
	// The real titles on this site all fit; the healthy one must not trip it.
	assert.ok(titleWidth(HEALTHY.title) <= TITLE_MAX_PX);
});

test("a link with no text at all is a problem, not a style point", () => {
	const findings = problems({
		...HEALTHY,
		links: [
			{ href: "/book", text: "" },
			{ href: "/contact", text: "   " },
			{ href: "/faq", text: "Read the FAQ" },
		],
	});
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /2 links have no text/);
	assert.doesNotMatch(findings[0].detail, /faq/);
});

test("the vague-link list covers the common evasions", () => {
	const findings = looks({
		...HEALTHY,
		links: [
			{ href: "/a", text: "Learn more" },
			{ href: "/b", text: "Find out more" },
			{ href: "/c", text: "Get started" },
			{ href: "/d", text: "View" },
			{ href: "/e", text: "Learn more about termite barriers" },
		],
	});
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /4 links say/);
	assert.doesNotMatch(findings[0].detail, /\/e/, "a sentence that happens to start vaguely is fine");
});

test("a category word as alt text is as useless as a filename", () => {
	const findings = looks({
		...HEALTHY,
		images: [
			{ src: "/a.webp", hasAlt: true, altText: "photo" },
			{ src: "/b.webp", hasAlt: true, altText: "A technician dusting a roof void" },
		],
	});
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /just a filename or a word/);
});

test("the result preview truncates the way a search result does", () => {
	const preview = googlePreview(
		{ title: "x".repeat(90), description: "y".repeat(200) },
		"https://www.tcbpestcontrolcanberra.com.au",
		"/spider-control"
	);
	assert.ok(preview.title.length <= TITLE_MAX);
	assert.ok(preview.title.endsWith("…"));
	assert.equal(preview.titleTruncated, true);
	assert.ok(preview.description.endsWith("…"));
	assert.equal(preview.descriptionTruncated, true);
	assert.equal(preview.url, "www.tcbpestcontrolcanberra.com.au/spider-control");
});

test("a short enough result is shown whole, with no ellipsis", () => {
	const preview = googlePreview(HEALTHY, "https://www.tcbpestcontrolcanberra.com.au", "/");
	assert.equal(preview.title, HEALTHY.title);
	assert.equal(preview.titleTruncated, false);
	assert.equal(preview.url, "www.tcbpestcontrolcanberra.com.au", "the homepage shows no trailing slash");
});
