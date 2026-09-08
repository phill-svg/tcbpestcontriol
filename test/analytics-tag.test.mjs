// Every public page must carry the GA4 tag in the served HTML.
//
// This is guarding a footgun that already went off once. On 2026-08-28 the
// eager gtag.js block was stripped from every page, leaving only the Tag
// Manager container -- which reads like the tag is still there, because GTM is
// how most sites load GA4. It is not: the published GTM-KHML52L9 container
// carries no GA4 configuration tag, so removing the hardcoded gtag("config")
// calls left nothing sending hits at all. Collection stopped dead that day and
// nobody noticed for twelve days.
//
// Nothing about that failure is visible from the page: it renders fine, GTM
// still loads, and the only symptom is a number going to zero in a dashboard
// nobody opens daily. GA4 does not backfill, so every day of silence is data
// that cannot be recovered. Hence a test rather than a note.
//
// If GA4 is ever moved into the GTM container properly, this test should be
// changed to assert *that*, not deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The web stream feeding GA4 property 495764012 ("TCB Pest"), plus the second
// property the site has always reported into alongside it.
const MEASUREMENT_IDS = ["G-P3FB9505V3", "G-00992RETSJ"];

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "test", "assets"]);

// Staff-only pages that are deliberately untagged -- they are internal tools,
// not part of the public site, and their traffic would skew the numbers.
const UNTAGGED = new Set(["servicem8-setup-training/index.html", "staff-chat/index.html"]);

function publicPages(dir = repoRoot, found = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			publicPages(full, found);
		} else if (entry.endsWith(".html")) {
			const relative = path.relative(repoRoot, full).split(path.sep).join("/");
			if (!UNTAGGED.has(relative)) found.push(relative);
		}
	}
	return found;
}

const pages = publicPages();

test("there are public pages to check", () => {
	// A walker that silently finds nothing would make every assertion below pass.
	assert.ok(pages.length > 100, `expected the full site, found ${pages.length} pages`);
});

test("every public page loads gtag.js and configures both GA4 properties", () => {
	const missing = [];
	for (const page of pages) {
		const html = readFileSync(path.join(repoRoot, page), "utf8");
		const gaps = [];
		if (!html.includes(`googletagmanager.com/gtag/js?id=${MEASUREMENT_IDS[0]}`)) gaps.push("gtag.js loader");
		for (const id of MEASUREMENT_IDS) {
			if (!html.includes(`gtag("config", "${id}")`)) gaps.push(`config ${id}`);
		}
		if (gaps.length) missing.push(`${page}: ${gaps.join(", ")}`);
	}
	assert.deepEqual(missing, [], `pages missing GA4 tagging:\n${missing.join("\n")}`);
});

test("the gtag block is served eagerly, ahead of the deferred third-party scripts", () => {
	// Tag Assistant and Google's own detection scan the served HTML, so a tag
	// injected later from JS reads as an untagged page. The block also has to
	// sit above the interaction-gated loader below it, or visitors who bounce
	// before touching the page are never counted.
	const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
	const gtag = html.indexOf("gtag/js?id=");
	const deferred = html.indexOf("loadPixel");

	assert.ok(gtag !== -1, "the gtag.js loader should be in the served HTML");
	assert.ok(deferred !== -1, "the deferred loader should still exist");
	assert.ok(gtag < deferred, "gtag.js must load ahead of the interaction-gated scripts");
	assert.doesNotMatch(html.slice(gtag - 200, gtag), /createElement\("script"\)/, "gtag must not be injected from JS");
});

test("the page templates carry the tag, so generated pages inherit it", () => {
	// _service-template.html and _blog-template.html are filled at request time
	// by src/service-pages.js and src/blog-posts.js. A page generated from an
	// untagged template is invisible to analytics no matter what the static
	// pages say.
	for (const template of ["_service-template.html", "_blog-template.html"]) {
		const html = readFileSync(path.join(repoRoot, template), "utf8");
		for (const id of MEASUREMENT_IDS) {
			assert.ok(html.includes(`gtag("config", "${id}")`), `${template} is missing config for ${id}`);
		}
	}
});
