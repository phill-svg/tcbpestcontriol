// GA4 used to be loaded straight from every page's <head> via a hardcoded
// gtag.js block plus a GTM-KHML52L9 container -- both properties (G-P3FB9505V3,
// G-00992RETSJ) are now configured as Zaraz tools instead, and Zaraz injects
// its own loader at the edge, so there is nothing analytics-related left for
// the static HTML to carry.
//
// This file is guarding a footgun that already went off once (2026-08-28: an
// edit stripped the eager gtag.js block and left GA4 collecting nothing for
// twelve days before anyone noticed -- GA4 does not backfill). The specific
// risk now is different: someone re-adding a hardcoded gtag.js/GTM snippet by
// hand would double-report every hit against the Zaraz-managed properties, so
// the checks below assert the *opposite* of what they used to -- that no page
// or template carries that snippet again -- plus that the three lead-reporting
// call sites still fire through zaraz.track rather than a dead window.gtag.
//
// If analytics loading ever moves again, this test should be changed to
// assert *that*, not deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", ".claude", "test", "assets"]);

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

test("no public page carries a hardcoded gtag.js or GTM snippet", () => {
	// Both properties are configured as Zaraz tools now, and Zaraz injects its
	// own loader at the edge. A hand-added gtag.js/GTM block back in the HTML
	// would double-report every hit against the same Zaraz-managed properties.
	const found = [];
	for (const page of pages) {
		const html = readFileSync(path.join(repoRoot, page), "utf8");
		if (html.includes("googletagmanager.com")) found.push(page);
	}
	assert.deepEqual(found, [], `pages with a leftover googletagmanager.com reference:\n${found.join("\n")}`);
});

test("the page templates don't carry a hardcoded gtag.js or GTM snippet either", () => {
	// _service-template.html and _blog-template.html are filled at request time
	// by src/service-pages.js and src/blog-posts.js. A stray gtag.js/GTM block
	// reintroduced here would propagate into every page generated from it.
	for (const template of ["_service-template.html", "_blog-template.html"]) {
		const html = readFileSync(path.join(repoRoot, template), "utf8");
		assert.ok(!html.includes("googletagmanager.com"), `${template} has a leftover googletagmanager.com reference`);
	}
});

// --- what actually counts as a lead ------------------------------------------
//
// A tag that fires and reports nothing worth counting is the state this site
// was in: GA4 collected page views but its conversion count sat at zero,
// because the only lead signals came from the two forms and the site's ~800
// tel: links said nothing at all. These pin the three reporting paths so a
// refactor can't quietly drop one and leave the number at zero again.

const scriptJs = readFileSync(path.join(repoRoot, "assets", "js", "script.js"), "utf8");
const bookingJs = readFileSync(path.join(repoRoot, "assets", "js", "booking.js"), "utf8");

test("every lead path reports the same event through zaraz.track", () => {
	// One event name means one key event to mark in GA4 Admin (via the Zaraz
	// GA4 tools' Actions mapping). Three names would mean three, and whichever
	// was forgotten would silently not count.
	assert.match(scriptJs, /zaraz\.track\("generate_lead"/, "click-to-call should report a lead");
	assert.match(bookingJs, /zaraz\.track\("generate_lead"/, "the booking form should report a lead");

	const thankYou = readFileSync(path.join(repoRoot, "thank-you", "index.html"), "utf8");
	assert.match(thankYou, /zaraz\.track\("generate_lead"/, "/thank-you is where a contact enquiry is confirmed");
});

test("each lead path says which kind it is", () => {
	// A phone click is intent; a booking is confirmed work. Counting them under
	// one event is only honest while lead_type can still tell them apart.
	assert.match(scriptJs, /lead_type: "phone_call"/);
	assert.match(bookingJs, /lead_type: isQuoteMode\(\) \? "quote_request" : "booking"/);
});

test("reporting can never break the thing it is reporting on", () => {
	// zaraz is simply absent whenever an ad blocker eats the tag. A visitor
	// tapping the phone number must not care.
	const handler = scriptJs.slice(scriptJs.indexOf('a[href^="tel:"]'));
	assert.match(handler, /window\.zaraz && typeof window\.zaraz\.track === "function"/, "the call must be guarded");
	assert.match(handler, /catch \(analyticsError\)/, "and wrapped, in case zaraz itself throws");
});

test("script.js is requested with a version past the one frozen in browsers", () => {
	// /assets/js/* is immutable for a year, so a visitor who has already loaded
	// the site keeps the old script until the URL changes. Without a bump the
	// tel: reporting above would never reach a single returning visitor.
	const versions = new Set();
	for (const page of pages) {
		const html = readFileSync(path.join(repoRoot, page), "utf8");
		for (const match of html.matchAll(/assets\/js\/script\.js\?v=(\d+)/g)) versions.add(Number(match[1]));
	}
	assert.ok(versions.size === 1, `every page should ask for the same script.js version, found ${[...versions].join(", ")}`);
	assert.ok([...versions][0] >= 2, "v=1 is the version that was already frozen in browsers");
});

test("every phone number on the site is a link the reporting can see", () => {
	// A stray space after "tel:" is a link some dialers refuse and the
	// delegated handler above never matches. One page had one.
	const malformed = pages.filter((page) => /href="tel:\s/.test(readFileSync(path.join(repoRoot, page), "utf8")));
	assert.deepEqual(malformed, [], `tel: links with a space after the scheme:\n${malformed.join("\n")}`);
});
