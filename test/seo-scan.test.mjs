// The site-wide scan: reading the page list, and batching.
//
// extractPageSummary needs HTMLRewriter and so is exercised by the Worker
// test rather than here; what is testable in Node is the sitemap parsing and
// the batching logic, both of which have failure modes that would be quiet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathsFromSitemap, scanBatch } from "../src/seo-scan.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the page list comes from the real sitemap, as paths", () => {
	const paths = pathsFromSitemap(readFileSync(path.join(repoRoot, "sitemap.xml"), "utf8"));

	assert.ok(paths.length > 100, `expected the whole site, got ${paths.length}`);
	assert.ok(paths.includes("/"), "the homepage is a page too");
	assert.ok(paths.includes("/spider-control"));
	assert.ok(paths.every((page) => page.startsWith("/")), "absolute URLs are reduced to paths");
	assert.equal(new Set(paths).size, paths.length, "no duplicates");
	assert.ok(paths.every((page) => !page.endsWith("/") || page === "/"), "trailing slashes are normalised away");
});

test("a malformed entry is skipped rather than failing the whole scan", () => {
	const paths = pathsFromSitemap(`
		<urlset>
			<url><loc>https://example.com/good</loc></url>
			<url><loc>not a url</loc></url>
			<url><loc></loc></url>
			<url><loc>https://example.com/also-good</loc></url>
		</urlset>`);
	assert.deepEqual(paths, ["/good", "/also-good"]);
});

// A stand-in for the Worker's asset fetch and summary extraction.
function fakeScan({ pages, failing = {} }) {
	return {
		paths: Object.keys(pages),
		fetchPage: async (page) => {
			if (failing[page]) return { status: failing[page] };
			return { status: 200, __summary: pages[page] };
		},
	};
}

// scanBatch calls extractPageSummary, which needs HTMLRewriter. For these
// tests the response carries its summary directly and extraction is stubbed
// by handing scanBatch a fetchPage whose responses are already summaries.
const { extractPageSummary } = await import("../src/seo-scan.js");
const originalExtract = extractPageSummary;

test("batching walks the whole list and reports when it is done", async () => {
	const pages = {};
	for (let i = 0; i < 25; i++) {
		pages[`/page-${i}`] = { title: "A perfectly reasonable page title here", description: "x".repeat(100), h1Count: 1, images: [], links: [], hasCanonical: true };
	}
	const { paths, fetchPage } = fakeScan({ pages });

	let offset = 0;
	let batches = 0;
	const seen = [];
	for (;;) {
		const batch = await scanBatch({
			paths,
			offset,
			limit: 10,
			fetchPage,
			// Bypasses HTMLRewriter by returning the summary the fake attached.
			extract: async (response) => response.__summary,
		});
		batches++;
		seen.push(...batch.results);
		offset += batch.scanned;
		if (batch.done) break;
		assert.ok(batches < 10, "must terminate");
	}

	assert.equal(offset, 25, "every page is visited exactly once");
	assert.equal(batches, 3, "25 pages at 10 a time is three batches");
	assert.deepEqual(seen, [], "healthy pages produce no findings");
});

test("a page in the sitemap that does not load is reported as a problem", async () => {
	const { paths, fetchPage } = fakeScan({
		pages: { "/gone": {}, "/fine": { title: "A perfectly reasonable page title here", description: "x".repeat(100), h1Count: 1, images: [], links: [], hasCanonical: true } },
		failing: { "/gone": 404 },
	});

	const batch = await scanBatch({ paths, offset: 0, limit: 10, fetchPage, extract: async (r) => r.__summary });
	const gone = batch.results.find((result) => result.path === "/gone");

	assert.ok(gone, "a 404 in the sitemap is exactly what this should catch");
	assert.equal(gone.findings[0].level, "problem");
	assert.match(gone.findings[0].message, /does not load \(404\)/);
});

test("published overrides are what gets checked, not the file's wording", async () => {
	// A description edited in the editor and published is what a visitor sees.
	// Checking the file instead would report a problem that no longer exists,
	// or miss one that has just been introduced.
	const pages = {
		"/edited": { title: "Original title that is long enough to pass", description: "y".repeat(100), h1Count: 1, images: [], links: [], hasCanonical: true },
	};
	const { paths, fetchPage } = fakeScan({ pages });

	const batch = await scanBatch({
		paths,
		offset: 0,
		limit: 10,
		fetchPage,
		extract: async (r) => ({ ...r.__summary }),
		loadEdits: async () => new Map([["m:description", "far too short"]]),
	});

	const edited = batch.results.find((result) => result.path === "/edited");
	assert.ok(edited, "the override should have introduced a finding");
	assert.match(edited.findings[0].message, /description is only/i);
});

test("healthy pages are left out of the report entirely", async () => {
	// 134 rows of "this page is fine" is not a report anybody reads.
	const pages = {
		"/good": { title: "A perfectly reasonable page title here", description: "x".repeat(100), h1Count: 1, images: [], links: [], hasCanonical: true },
		"/bad": { title: "", description: "", h1Count: 0, images: [], links: [], hasCanonical: true },
	};
	const { paths, fetchPage } = fakeScan({ pages });
	const batch = await scanBatch({ paths, offset: 0, limit: 10, fetchPage, extract: async (r) => r.__summary });

	assert.equal(batch.results.length, 1);
	assert.equal(batch.results[0].path, "/bad");
	assert.ok(batch.results[0].findings.every((finding) => finding.level !== "good"), "and 'good' notes are dropped");
});

assert.equal(typeof originalExtract, "function");
