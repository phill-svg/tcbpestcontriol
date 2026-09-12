// The assumption the entire editor rests on: the browser, the Worker and the
// sync script must all give the same piece of text the same address.
//
// If they ever disagree, edits silently stop applying (best case) or land on
// the wrong sentence (worst case). None of that shows up in a unit test of
// any one of them, because each is perfectly self-consistent. So this test
// runs all three against the *real* pages in this repo and compares them
// address for address:
//
//   browser  -- indexDocument() from assets/js/editor.js, in real Chromium
//   Worker   -- applyContentEdits() from src/content-edits.js, in real workerd
//   Node     -- bakeEdits() from src/bake-edits.js
//
// The same pages carry a second numbering that has to agree the same way.
// Layout mode numbers the blocks in the browser and the server resolves those
// numbers against the raw file with findBlocks(). Nothing about that fails
// loudly when the two disagree: both sides stay perfectly self-consistent, and
// every number past the first difference simply points at a different element
// on each side, so a removal lands on the wrong paragraph and gets committed.
// The block tests at the bottom compare the two lists element for element on
// the same real pages.
//
// It boots a real Worker and a real browser, which takes tens of seconds and
// is far too heavy to sit in the middle of `npm test`. So it is opt-in:
//
//   npm install --no-save wrangler playwright
//   npm run test:parity
//
// Without TCB_PARITY=1 (or without those two dev-only packages installed) it
// skips itself rather than failing the suite.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bakeEdits } from "../src/bake-edits.js";
import { findBlocks, BLOCK_TAGS } from "../src/page-structure.js";
import { decodeEntities } from "../src/html-entities.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Worker probe and the static file server are separate on purpose. Giving
// wrangler an `assets` directory of "./" makes it watch all 200-odd page
// folders plus node_modules, and it then reload-loops instead of answering
// anything -- so the browser is served by a plain Node server instead.
// Ports are allocated at run time rather than hard-coded. A previous run that
// died badly, or any other dev server on the machine, would otherwise make
// this fail with EADDRINUSE and look like a parity problem.
let WORKER_ORIGIN = "";
let STATIC_ORIGIN = "";

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

// A representative spread: the homepage is the largest and most complex file
// on the site, a location page is the template that 100+ pages share, and a
// blog article is the longest prose.
const PAGES = [
	{ url: "/", file: "index.html" },
	{ url: "/locations-pest-control-kambah", file: "locations-pest-control-kambah/index.html" },
	{ url: "/spider-control", file: "spider-control/index.html" },
	{ url: "/blog-termite-prevention-tips-for-canberra-homeowners", file: "blog-termite-prevention-tips-for-canberra-homeowners/index.html" },
];

const haveTools =
	process.env.TCB_PARITY === "1" &&
	existsSync(path.join(repoRoot, "node_modules", "wrangler")) &&
	existsSync(path.join(repoRoot, "node_modules", "playwright"));

let workerProcess = null;
let staticServer = null;
let browser = null;

// bakeEdits() only ever *applies* addresses, so the list it would recognise is
// collected by handing it a Map-alike that records every lookup and always
// answers "no edit here". That way the enumeration is done by the exact code
// path that does the real rewriting, rather than by a copy of it.
function collectAddresses(html) {
	const seen = [];
	bakeEdits(html, {
		get(address) {
			seen.push(address);
			return undefined;
		},
		keys: () => [],
	});
	return seen;
}

before(async () => {
	if (!haveTools) return;

	staticServer = createServer((request, response) => {
		const requested = decodeURIComponent(new URL(request.url, STATIC_ORIGIN).pathname);
		const file = path.join(repoRoot, requested);
		// Refuse anything that climbs out of the repo -- this is a test server,
		// but it is still a server.
		if (!file.startsWith(repoRoot) || !existsSync(file)) {
			response.writeHead(404).end("not found");
			return;
		}
		response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream" });
		response.end(readFileSync(file));
	});
	await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
	STATIC_ORIGIN = `http://127.0.0.1:${staticServer.address().port}`;

	const workerPort = await freePort();
	WORKER_ORIGIN = `http://127.0.0.1:${workerPort}`;
	workerProcess = spawn(
		path.join(repoRoot, "node_modules", ".bin", "wrangler"),
		["dev", "--local", "--config", "test/probe/wrangler.jsonc", "--port", String(workerPort), "--ip", "127.0.0.1"],
		// Its own process group: `wrangler dev` spawns a workerd child that
		// survives a SIGTERM aimed at the wrapper, and a surviving workerd keeps
		// the test runner's event loop alive forever.
		{ cwd: repoRoot, stdio: "ignore", detached: true }
	);

	for (let attempt = 0; attempt < 90; attempt++) {
		try {
			const response = await fetch(WORKER_ORIGIN, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ html: "<p>ready</p>", edits: {} }),
			});
			if (response.ok) break;
		} catch {
			/* still starting */
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	const { chromium } = await import("playwright");
	// Use whatever Chromium the machine already has rather than downloading
	// one: CI images commonly ship a build that doesn't match the revision
	// this Playwright version would fetch, and the parity being tested here
	// doesn't depend on the exact browser build.
	const installed = findInstalledChromium();
	browser = await chromium.launch(installed ? { executablePath: installed } : {});
});

function findInstalledChromium() {
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
	if (!existsSync(base)) return null;
	for (const entry of readdirSync(base)) {
		for (const candidate of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
			const file = path.join(base, entry, candidate);
			if (existsSync(file)) return file;
		}
	}
	return null;
}

after(async () => {
	if (browser) await browser.close();
	if (workerProcess) {
		// Negative pid kills the whole group, taking workerd with it.
		try {
			process.kill(-workerProcess.pid, "SIGTERM");
		} catch {
			workerProcess.kill("SIGTERM");
		}
	}
	if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
});

for (const page of PAGES) {
	test(`browser, Worker and sync script agree on every address in ${page.url}`, async (t) => {
		if (!haveTools) return t.skip("wrangler and playwright are not installed");

		const html = readFileSync(path.join(repoRoot, page.file), "utf8");

		// --- Node -------------------------------------------------------------
		const nodeAddresses = collectAddresses(html);
		assert.ok(nodeAddresses.length > 40, `expected a real page, found ${nodeAddresses.length} addresses`);

		// --- browser ----------------------------------------------------------
		const tab = await browser.newPage();
		await tab.goto(`${STATIC_ORIGIN}/${page.file}`, { waitUntil: "domcontentloaded" });
		const browserAddresses = await tab.evaluate(async () => {
			const { indexDocument } = await import("/assets/js/editor.js");
			const { texts, attrs } = indexDocument();
			return { texts: texts.map((e) => e.address), attrs: attrs.map((e) => e.address) };
		});
		await tab.close();

		// --- Worker -----------------------------------------------------------
		// Every address the Node walk found is handed to the real rewriter with
		// a unique marker. An address the Worker computes differently simply
		// won't match, and its marker won't appear in the output.
		const markers = Object.fromEntries(nodeAddresses.map((address, index) => [address, `TCBMARKER${index}ENDMARKER`]));
		const response = await fetch(WORKER_ORIGIN, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ html, edits: markers }),
		});
		const rewritten = await response.text();

		const workerMissed = nodeAddresses.filter((address) => !rewritten.includes(markers[address]));
		assert.deepEqual(workerMissed, [], "every address the sync script finds must also be found by the Worker");

		// --- the browser sees the same set ------------------------------------
		const browserAll = new Set(browserAddresses.texts.concat(browserAddresses.attrs));
		const nodeAll = new Set(nodeAddresses);

		// The browser walks <body>; the sync script walks the whole file, so it
		// additionally sees <head> metadata. Compare on the common ground.
		const missingInBrowser = [...nodeAll].filter((address) => !browserAll.has(address) && !address.startsWith("m:"));
		const missingInNode = [...browserAll].filter((address) => !nodeAll.has(address));

		assert.deepEqual(missingInBrowser, [], "every address in the file must be reachable from the browser");
		assert.deepEqual(missingInNode, [], "the browser must not invent addresses the file does not contain");
	});
}

// ---------------------------------------------------------------------------
// Block numbering: the browser's list of blocks against the file scanner's
// ---------------------------------------------------------------------------

// Breadcrumbs and site navigation are links to other pages rather than words
// on this one, and every page opens with a breadcrumb <ol> sitting inside
// <main> -- so without this its <li>s would be blocks 0 to 4 of every page.
// Must stay the same as BLOCK_SKIP_TAGS in src/page-structure.js.
const BLOCK_SKIP_SELECTOR = "nav";

// Whatever letters a block contains, with every space thrown away.
//
// The two sides reach the text by different routes and cannot be compared
// character for character: findBlocks() works on bytes and turns each inner
// tag into a space, so `<strong>ants</strong>.` reads as "ants ." there and as
// "ants." in the DOM. Spacing is not what this is about -- which element a
// number points at is -- so the spaces go and the letters are compared.
const letters = (value) => String(value || "").replace(/\s+/g, "");

// A block as seen from either side: its tag, and enough of its words to tell
// it apart from its neighbours. Comparing counts alone would pass happily
// while every number pointed one element out of step, which is exactly the
// failure this whole file exists to catch. An <img> has no words and so
// compares on its tag and its position only.
const blockSignature = (tag, text) => `${tag}|${letters(text).slice(0, 40)}`;

for (const page of PAGES) {
	test(`the browser and the file scanner number the blocks in ${page.url} identically`, async (t) => {
		// Only the browser half needs a real runtime -- findBlocks() is pure and
		// runs here in Node. It still hangs off the same guard as the address
		// tests: a second set of skip conditions and a second before() hook to
		// start a browser without a Worker would buy nothing.
		if (!haveTools) return t.skip("wrangler and playwright are not installed");

		const html = readFileSync(path.join(repoRoot, page.file), "utf8");

		// --- the file ---------------------------------------------------------
		const { blocks, error } = findBlocks(html, { root: "main" });
		assert.equal(error, undefined, `findBlocks() could not read ${page.file}: ${error}`);
		assert.ok(blocks.length > 5, `expected a real page, found ${blocks.length} blocks`);

		const fileBlocks = blocks.map((block) =>
			// The same way checkExpect() reads a block back out of the file: strip
			// the markup, decode the entities, and what is left is the words.
			blockSignature(block.tag, decodeEntities(html.slice(block.start, block.end).replace(/<[^>]*>/g, " ")))
		);

		// --- the browser ------------------------------------------------------
		// What follows is a restatement of indexBlocks(), not a call to it:
		// BLOCK_SELECTOR and BLOCK_SKIP_SELECTOR are private to editor.js and the
		// Editor class is not exported. A restatement is only worth something
		// while it still says the same thing as the original. The tag list is
		// covered already -- "the editor and the scanner agree on what a block
		// is", in test/page-structure.test.mjs, reads BLOCK_SELECTOR out of
		// editor.js and compares it to BLOCK_TAGS, which is what is used below --
		// but nothing else checks the exclusion, so that one is checked here.
		// Blunt on purpose: a rename fails by name rather than passing quietly
		// while the numbering the business actually uses drifts apart.
		const editorSource = readFileSync(path.join(repoRoot, "assets", "js", "editor.js"), "utf8");
		assert.ok(
			editorSource.includes(`const BLOCK_SKIP_SELECTOR = "${BLOCK_SKIP_SELECTOR}"`),
			`editor.js BLOCK_SKIP_SELECTOR no longer excludes <${BLOCK_SKIP_SELECTOR}>`
		);

		const blockSelector = [...BLOCK_TAGS].join(",");
		const tab = await browser.newPage();
		await tab.goto(`${STATIC_ORIGIN}/${page.file}`, { waitUntil: "domcontentloaded" });
		const browserBlocks = await tab.evaluate(async ([selector, skipBlocks]) => {
			// Built here the way editor.js builds it, from the shared module,
			// rather than written out again.
			const { SKIPPED_ELEMENTS, IGNORED_SUBTREE_ATTR } = await import("/assets/js/content-address.js");
			const skipSelector = [...SKIPPED_ELEMENTS].concat(`[${IGNORED_SUBTREE_ATTR}]`).join(",");
			const main = document.querySelector("main");
			if (!main) return [];
			return [...main.querySelectorAll(selector)]
				.filter((node) => !node.closest(skipSelector) && !node.closest(skipBlocks))
				.map((node) => [node.tagName.toLowerCase(), node.textContent || ""]);
		}, [blockSelector, BLOCK_SKIP_SELECTOR]);
		await tab.close();

		// The static server hands the browser the file as it is written, so this
		// compares the two readings of the same bytes. What it cannot see is the
		// Worker injecting markup into <main> at request time -- it does not, it
		// only sets an id there, and everything else it adds goes on <body>.
		assert.deepEqual(
			browserBlocks.map(([tag, text]) => blockSignature(tag, text)),
			fileBlocks,
			"the browser and the file scanner must find the same blocks, in the same order"
		);
	});
}
