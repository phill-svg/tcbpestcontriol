// The SEO checks. Pure functions over a summary object, so the thresholds
// and the wording can be tested without a browser.
//
// The bar these have to clear: the site currently has five issues across 134
// pages, so a check that cries wolf would be worse than no check at all --
// people stop reading a panel that is always orange. Several of these tests
// exist to pin that a healthy page reports nothing to fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSeo, googlePreview, TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX } from "../assets/js/seo-check.js";

const HEALTHY = {
	title: "Spider Control Canberra | TCB Pest Control Canberra",
	description:
		"Spider treatment across Canberra for funnel-webs, redbacks, white-tails and huntsmen. Same-week availability, family-safe products, written report.",
	h1Count: 1,
	images: [{ src: "/assets/images/a.webp", hasAlt: true, altText: "A huntsman spider on a wall" }],
	links: [{ href: "/book", text: "Book a treatment" }],
	hasCanonical: true,
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
