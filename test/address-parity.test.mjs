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
