// One site, one hostname.
//
// The same pages answer on more than one address: the bare apex and www are
// both bound as Worker Custom Domains, the Worker also answers on its
// workers.dev subdomain, and every build gets a preview URL. To a search
// engine each of those is a separate, complete copy of the site, and it picks
// a winner itself -- splitting links and impressions between the two it
// decided were different sites.
//
// Four things have to agree for that not to happen, and they live in four
// different files: the redirect (src/index.js), the canonical tag on every
// page, the sitemap, and the Sitemap line in robots.txt. Nothing at runtime
// cross-checks them -- a page added with a non-www canonical looks completely
// normal and simply votes for the other site. Hence this.
//
// Confirmed working live on 2026-09-11: Search Console reports the apex as
// "Page with redirect" with google_canonical = the www URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_HOST = "www.tcbpestcontrolcanberra.com.au";
const CANONICAL = `https://${CANONICAL_HOST}`;

// Compare the parsed hostname, never a string prefix. "https://www.tcbpest...
// .com.au" is also the start of "https://www.tcbpest....com.au.example.com",
// so a startsWith() check here would wave through a canonical tag pointing at
// somebody else's domain -- which is the one thing this file exists to catch.
// (CodeQL flags the prefix form as incomplete URL substring sanitization.)
function isCanonicalUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === "https:" && url.hostname === CANONICAL_HOST;
}
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "test"]);

function htmlPages(dir = repoRoot, found = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) htmlPages(full, found);
		else if (entry.endsWith(".html")) found.push(path.relative(repoRoot, full).split(path.sep).join("/"));
	}
	return found;
}

const pages = htmlPages();
const worker = readFileSync(path.join(repoRoot, "src", "index.js"), "utf8");

test("there are pages to check", () => {
	assert.ok(pages.length > 100, `expected the full site, found ${pages.length} pages`);
});

test("the Worker redirects the bare apex to www", () => {
	// Both hostnames are Custom Domains, so Cloudflare Page Rules never get a
	// chance to run for them -- this has to be in the Worker, and it has to be
	// above anything that serves a body.
	const redirect = worker.indexOf('url.hostname === "tcbpestcontrolcanberra.com.au"');
	assert.ok(redirect !== -1, "the apex redirect should still exist");

	const block = worker.slice(redirect, redirect + 200);
	assert.match(block, /url\.hostname = CANONICAL_HOST/);
	assert.match(block, /Response\.redirect\(url\.toString\(\), 301\)/, "301, not 302 -- this is permanent");

	const servesAssets = worker.indexOf("fetchAsset(");
	assert.ok(redirect < servesAssets, "the redirect must come before anything that serves a page");
});

test("every other hostname is told not to index what it serves", () => {
	// A preview URL can't be redirected -- opening the build being previewed is
	// the whole point of it -- so the guard is a header, not a redirect.
	assert.match(worker, /X-Robots-Tag/, "non-canonical hosts need a noindex header");
	const guard = worker.slice(worker.indexOf("function guardNonCanonicalHost"));
	assert.match(guard, /host === CANONICAL_HOST\) return response/, "the canonical host must be left alone");
	assert.match(guard, /status === 101 \|\| response\.webSocket/, "a WebSocket upgrade must pass through untouched");
});

test("every page's canonical URL points at the www host", () => {
	const wrong = [];
	for (const page of pages) {
		const html = readFileSync(path.join(repoRoot, page), "utf8");
		for (const match of html.matchAll(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/g)) {
			if (!isCanonicalUrl(match[1])) wrong.push(`${page}: ${match[1]}`);
		}
	}
	assert.deepEqual(wrong, [], `canonical tags pointing somewhere other than ${CANONICAL}:\n${wrong.join("\n")}`);
});

test("og:url agrees with the canonical tag", () => {
	// Shares and scrapers read this one, and a non-www value here hands out the
	// other address every time somebody posts a link.
	const wrong = [];
	for (const page of pages) {
		const html = readFileSync(path.join(repoRoot, page), "utf8");
		for (const match of html.matchAll(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/g)) {
			if (!isCanonicalUrl(match[1])) wrong.push(`${page}: ${match[1]}`);
		}
	}
	assert.deepEqual(wrong, [], `og:url values pointing somewhere other than ${CANONICAL}:\n${wrong.join("\n")}`);
});

test("the sitemap lists www URLs and nothing else", () => {
	const sitemap = readFileSync(path.join(repoRoot, "sitemap.xml"), "utf8");
	const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

	assert.ok(locs.length > 100, `expected the full sitemap, found ${locs.length} URLs`);
	assert.deepEqual(
		locs.filter((loc) => !isCanonicalUrl(loc)),
		[],
		"a sitemap that lists the other hostname asks Google to index the copy"
	);
});

test("robots.txt points at the one sitemap, on the canonical host", () => {
	const robots = readFileSync(path.join(repoRoot, "robots.txt"), "utf8");
	const lines = robots.split("\n").filter((line) => /^\s*Sitemap:/i.test(line));

	assert.equal(lines.length, 1, `robots.txt should name exactly one sitemap, found ${lines.length}`);
	assert.equal(lines[0].trim(), `Sitemap: ${CANONICAL}/sitemap.xml`);
});

test("the RSS feed uses the canonical host too", () => {
	// Feed readers and aggregators republish these links verbatim.
	const feed = readFileSync(path.join(repoRoot, "feed.xml"), "utf8");
	const links = [...feed.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1].trim());

	assert.ok(links.length > 0, "the feed should have links");
	assert.deepEqual(
		links.filter((link) => !isCanonicalUrl(link)),
		[],
		"feed links must use the canonical host"
	);
});
