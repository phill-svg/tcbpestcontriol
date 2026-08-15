import { test } from "node:test";
import assert from "node:assert/strict";

import {
	normaliseText,
	normalisePath,
	hashValue,
	textAddress,
	attrAddress,
	isSafeHref,
	isSafeImageSrc,
} from "../assets/js/content-address.js";
import { decodeEntities, escapeHtmlText } from "../src/html-entities.js";
import { bakeEdits, pathToFile } from "../src/bake-edits.js";
import { parseAddress, validateValue } from "../src/content-edits.js";

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

test("normaliseText collapses the whitespace HTML authors indent with", () => {
	assert.equal(normaliseText("\n\t  Fast pest control  \n"), "Fast pest control");
	assert.equal(normaliseText("Fast   pest\n control"), "Fast pest control");
	assert.equal(normaliseText("   "), "");
});

test("a non-breaking space normalises like a space, so both sides agree", () => {
	// The browser reads `&nbsp;` from the DOM as U+00A0; the Worker decodes the
	// entity to the same character. Both then have to collapse it identically
	// or an edit to any sentence containing one would never match.
	assert.equal(normaliseText(decodeEntities("Call&nbsp;us today")), "Call us today");
	assert.equal(normaliseText("Call us today"), "Call us today");
});

test("the address is stable for the same text and differs for different text", () => {
	assert.equal(textAddress("Fast pest control", 0), textAddress("Fast   pest control", 0));
	assert.notEqual(textAddress("Fast pest control", 0), textAddress("Fast pest control", 1));
	assert.notEqual(textAddress("Fast pest control", 0), textAddress("Fast pest controls", 0));
});

test("attribute addresses keep href and src in separate namespaces", () => {
	assert.notEqual(attrAddress("a", "href", "/contact", 0), attrAddress("img", "src", "/contact", 0));
	assert.notEqual(attrAddress("img", "src", "/a.webp", 0), attrAddress("img", "alt", "/a.webp", 0));
});

test("hashValue is stable across runs and reasonably spread", () => {
	assert.equal(hashValue("Termite treatment"), hashValue("Termite treatment"));
	const seen = new Set();
	for (let i = 0; i < 2000; i++) seen.add(hashValue(`Pest control in suburb ${i}`));
	assert.equal(seen.size, 2000, "no collisions across 2000 realistic strings");
});

test("normalisePath matches the site's no-trailing-slash convention", () => {
	assert.equal(normalisePath("/about/"), "/about");
	assert.equal(normalisePath("/about?edit=1"), "/about");
	assert.equal(normalisePath("/about#top"), "/about");
	assert.equal(normalisePath("/"), "/");
	assert.equal(normalisePath(""), "/");
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

test("decodeEntities handles the references that actually appear in copy", () => {
	assert.equal(decodeEntities("Tom &amp; Jerry&#39;s"), "Tom & Jerry's");
	assert.equal(decodeEntities("&lt;tag&gt;"), "<tag>");
	assert.equal(decodeEntities("&#x2014; dash"), "— dash");
	assert.equal(decodeEntities("caf&eacute;"), "café");
});

test("decodeEntities leaves anything it doesn't know alone", () => {
	// The safe failure: an unknown entity makes the hash differ from the
	// browser's, so the edit simply doesn't match and the page is untouched.
	assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
	assert.equal(decodeEntities("100% & rising"), "100% & rising");
	assert.equal(decodeEntities("&#xD800;"), "&#xD800;", "lone surrogates are not valid characters");
});

test("escapeHtmlText closes the markup-injection route", () => {
	assert.equal(escapeHtmlText(`<script>alert(1)</script>`), "&lt;script&gt;alert(1)&lt;/script&gt;");
	assert.equal(escapeHtmlText("Tom & Jerry"), "Tom &amp; Jerry");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("parseAddress accepts what we issue and rejects everything else", () => {
	assert.deepEqual(parseAddress("t:abc123:0"), { kind: "text" });
	assert.deepEqual(parseAddress("m:title"), { kind: "meta", field: "title" });
	assert.deepEqual(parseAddress("a:a:href:abc:2"), { kind: "attr", tag: "a", attr: "href" });

	assert.equal(parseAddress("t:abc:x"), null, "ordinal must be numeric");
	assert.equal(parseAddress("a:script:src:abc:0"), null, "only whitelisted tags");
	assert.equal(parseAddress("a:a:onclick:abc:0"), null, "event handlers are not editable attributes");
	assert.equal(parseAddress("a:img:srcset:abc:0"), null);
	assert.equal(parseAddress(""), null);
	assert.equal(parseAddress(null), null);
});

test("link values reject javascript: and data: URLs", () => {
	const parsed = parseAddress("a:a:href:abc:0");
	assert.equal(validateValue(parsed, "javascript:alert(1)").error !== undefined, true);
	assert.equal(validateValue(parsed, "data:text/html,<script>").error !== undefined, true);
	assert.equal(validateValue(parsed, "  JaVaScRiPt:alert(1)").error !== undefined, true);
	assert.equal(validateValue(parsed, "//evil.example.com").error !== undefined, true);

	assert.equal(validateValue(parsed, "/termite-treatment").value, "/termite-treatment");
	assert.equal(validateValue(parsed, "https://example.com/x").value, "https://example.com/x");
	assert.equal(validateValue(parsed, "tel:+61262551234").value, "tel:+61262551234");
});

test("image sources must already live on this site", () => {
	const parsed = parseAddress("a:img:src:abc:0");
	assert.equal(validateValue(parsed, "https://evil.example.com/x.png").error !== undefined, true);
	assert.equal(validateValue(parsed, "//evil.example.com/x.png").error !== undefined, true);
	assert.equal(validateValue(parsed, "/assets/images/pest-ant-macro.webp").value, "/assets/images/pest-ant-macro.webp");
});

test("isSafeHref / isSafeImageSrc agree with the API's answers", () => {
	assert.equal(isSafeHref("javascript:alert(1)"), false);
	assert.equal(isSafeHref("/contact"), true);
	assert.equal(isSafeHref("#main"), true);
	assert.equal(isSafeImageSrc("/assets/images/a.webp"), true);
	assert.equal(isSafeImageSrc("assets/images/a.webp"), false);
});

test("text edits reject control characters and empty values", () => {
	const parsed = parseAddress("t:abc:0");
	assert.equal(validateValue(parsed, "   ").error !== undefined, true);
	assert.equal(validateValue(parsed, "x".repeat(9000)).error !== undefined, true);
	// A stray control character pasted in from Word is invisible in the editor
	// but corrupts the page text, so it is stripped rather than stored.
	assert.equal(validateValue(parsed, "Clean\u0000text").value, "Cleantext");
	assert.equal(validateValue(parsed, "Keeps\ttabs").value, "Keeps\ttabs");
});

// ---------------------------------------------------------------------------
// Baking edits back into the HTML files
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en-AU">
<head>
<title>Spider Control Canberra</title>
<meta name="description" content="Old description">
<style>.a::before { content: "Call us"; }</style>
</head>
<body>
<h1>Fast spider control</h1>
<p>
	Call us today for Tom &amp; Jerry&#39;s place.
</p>
<a href="/contact">Call us</a>
<a href="/book">Call us</a>
<img src="/assets/images/pest-spider-macro.webp" alt="A spider">
<script>var x = "Call us"; if (a < b) {}</script>
</body>
</html>`;

test("bakeEdits replaces the right text and leaves the rest byte-identical", () => {
	const address = textAddress("Fast spider control", 0);
	const { html, applied, missing } = bakeEdits(PAGE, new Map([[address, "Rapid spider control"]]));

	assert.deepEqual(applied, [address]);
	assert.deepEqual(missing, []);
	assert.match(html, /<h1>Rapid spider control<\/h1>/);
	// Everything else survives untouched, including the indentation.
	assert.equal(html.replace("Rapid spider control", "Fast spider control"), PAGE);
});

test("bakeEdits matches text written with entities, and re-escapes what it writes", () => {
	const address = textAddress("Call us today for Tom & Jerry's place.", 0);
	const { html, applied } = bakeEdits(PAGE, new Map([[address, "Ring us for Tom & Jerry's place."]]));

	assert.deepEqual(applied, [address]);
	assert.match(html, /Ring us for Tom &amp; Jerry&#39;s place\./);
	// The surrounding indentation of the multi-line <p> is preserved.
	assert.match(html, /<p>\n\tRing us/);
});

test("script and style contents never take an ordinal", () => {
	// "Call us" appears inside a <style>, inside a <script>, and twice as real
	// link text. If the skipped elements were counted, ordinal 0 would land on
	// the CSS and the first real link would be unreachable.
	const first = textAddress("Call us", 0);
	const second = textAddress("Call us", 1);
	const { html, missing } = bakeEdits(PAGE, new Map([[first, "Phone us"], [second, "Book now"]]));

	assert.deepEqual(missing, []);
	assert.match(html, /<a href="\/contact">Phone us<\/a>/);
	assert.match(html, /<a href="\/book">Book now<\/a>/);
	assert.match(html, /content: "Call us";/, "the stylesheet is untouched");
	assert.match(html, /var x = "Call us";/, "the script is untouched");
});

test("a script containing < is not mistaken for markup", () => {
	const { html } = bakeEdits(PAGE, new Map());
	assert.equal(html, PAGE, "a no-op bake returns the file exactly as it was");
});

test("bakeEdits updates link and image attributes", () => {
	const href = attrAddress("a", "href", "/book", 0);
	const src = attrAddress("img", "src", "/assets/images/pest-spider-macro.webp", 0);
	const alt = attrAddress("img", "alt", "A spider", 0);
	const { html, missing } = bakeEdits(
		PAGE,
		new Map([
			[href, "/book?source=spider"],
			[src, "/assets/images/pest-spider-macro-sm.webp"],
			[alt, "A huntsman spider on a wall"],
		])
	);

	assert.deepEqual(missing, []);
	assert.match(html, /<a href="\/book\?source=spider">Call us<\/a>/);
	assert.match(html, /src="\/assets\/images\/pest-spider-macro-sm\.webp"/);
	assert.match(html, /alt="A huntsman spider on a wall"/);
	assert.match(html, /<a href="\/contact">/, "the other link is untouched");
});

test("bakeEdits updates the page title and description", () => {
	const { html, missing } = bakeEdits(
		PAGE,
		new Map([
			["m:title", "Spider Control Canberra | TCB"],
			["m:description", "New description"],
		])
	);

	assert.deepEqual(missing, []);
	assert.match(html, /<title>Spider Control Canberra \| TCB<\/title>/);
	assert.match(html, /<meta name="description" content="New description">/);
});

test("an edit that no longer matches is reported, not applied somewhere else", () => {
	// This is the case where someone hand-edited the file after publishing.
	const stale = textAddress("Wording that is no longer on the page", 0);
	const { html, applied, missing } = bakeEdits(PAGE, new Map([[stale, "Anything"]]));

	assert.deepEqual(applied, []);
	assert.deepEqual(missing, [stale]);
	assert.equal(html, PAGE, "the file is left exactly as it was");
});

test("a stored edit cannot inject markup into the page", () => {
	const address = textAddress("Fast spider control", 0);
	const { html } = bakeEdits(PAGE, new Map([[address, `<img src=x onerror=alert(1)>`]]));
	assert.match(html, /<h1>&lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
	assert.doesNotMatch(html, /<img src=x/);
});

test("commented-out markup does not steal an ordinal", () => {
	const page = `<body><!-- <h1>Fast spider control</h1> --><h1>Fast spider control</h1></body>`;
	const address = textAddress("Fast spider control", 0);
	const { html, missing } = bakeEdits(page, new Map([[address, "Rapid spider control"]]));

	assert.deepEqual(missing, []);
	assert.match(html, /<!-- <h1>Fast spider control<\/h1> -->/, "the comment is left alone");
	assert.match(html, /<h1>Rapid spider control<\/h1>/, "the live heading is the one that changed");
});

test("a malformed tag cannot make the scanner backtrack exponentially", () => {
	// CodeQL caught this: the attribute-text alternation used to accept a `"`
	// via two different branches, so a run of quotes could be split between
	// them in exponentially many ways. `<A` plus 40 quotes took 3.6 seconds to
	// reject, and every extra quote doubled it. 2000 quotes is far past the
	// point where the old pattern would have run for longer than the universe.
	const pathological = `<A${'"'.repeat(2000)}`;
	const started = Date.now();
	bakeEdits(pathological, new Map());
	assert.ok(Date.now() - started < 1000, "scanning a pathological tag must stay fast");
});

test("an unmatched quote in a tag is left alone rather than mis-parsed", () => {
	// The cost of making the pattern unambiguous: a tag with an odd number of
	// quotes no longer matches. The scanner must treat it as text and change
	// nothing, which is the safe failure.
	const page = `<body><p title="unclosed>Fast spider control</p></body>`;
	const { html, missing } = bakeEdits(page, new Map([[textAddress("Fast spider control", 0), "Rapid"]]));
	assert.equal(html, page, "nothing is rewritten");
	assert.equal(missing.length, 1, "and the edit is reported as unmatched");
});

test("pathToFile mirrors how the Worker serves a directory path", () => {
	assert.equal(pathToFile("/"), "index.html");
	assert.equal(pathToFile("/spider-control"), "spider-control/index.html");
	assert.equal(pathToFile("/locations-pest-control-acton"), "locations-pest-control-acton/index.html");
});
