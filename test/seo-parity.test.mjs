// Does the whole-site scan see the same pages a browser sees?
//
// This exists because of a bug that shipped. The editor's SEO panel said the
// termite page's title was 59 characters; the site scan said 63 and flagged
// it as too long. The scan was reading raw HTML, where "&" is written "&amp;",
// and measuring four characters that no reader ever sees.
//
// What made it worse is how it was checked. An offline survey was written to
// settle which panel was right -- and it read raw HTML too, so it agreed with
// the scan and made the wrong answer look confirmed. Two checks agreeing means
// nothing when they share an assumption.
//
// So this compares the two things that genuinely differ: a real browser's DOM
// (Chromium, which decodes entities, fixes up broken markup and is what a
// visitor actually gets) against real workerd's HTMLRewriter (which streams
// raw source and fixes up nothing). Every page in the sitemap, every field the
// checks read. Where those two agree, there is something to trust.
//
// Heavy -- it boots a browser and a Worker and reads 134 pages twice -- so it
// is opt-in, alongside the address parity test:
//
//   npm run test:seo-parity
//
// Without TCB_PARITY=1, or without wrangler and playwright installed, it skips
// itself rather than failing the suite.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathsFromSitemap } from "../src/seo-scan.js";
import { checkSite, linkTarget } from "../assets/js/seo-site.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const haveTools =
	process.env.TCB_PARITY === "1" &&
	existsSync(path.join(repoRoot, "node_modules", "wrangler")) &&
	existsSync(path.join(repoRoot, "node_modules", "playwright"));

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

let WORKER_ORIGIN = "";
let STATIC_ORIGIN = "";
let workerProcess = null;
let staticServer = null;
let browser = null;

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

// The same mapping the Worker's fetchAsset() does: a path with no extension is
// a directory holding an index.html.
function fileFor(pagePath) {
	const relative = pagePath.replace(/^\//, "");
	for (const candidate of [relative === "" ? "index.html" : `${relative}/index.html`, `${relative}.html`, relative]) {
		if (!candidate) continue;
		const full = path.join(repoRoot, candidate);
		if (existsSync(full) && statSync(full).isFile()) return full;
	}
	return null;
}

before(async () => {
	if (!haveTools) return;

	staticServer = createServer((request, response) => {
		const requested = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
		const file = path.join(repoRoot, requested);
		if (!file.startsWith(repoRoot) || !existsSync(file) || !statSync(file).isFile()) {
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
		// survives a SIGTERM aimed at the wrapper, and a surviving workerd
		// keeps the test runner's event loop alive forever.
		{ cwd: repoRoot, stdio: "ignore", detached: true }
	);

	for (let attempt = 0; attempt < 90; attempt++) {
		try {
			const response = await fetch(`${WORKER_ORIGIN}/seo`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ html: "<title>ready</title>" }),
			});
			if (response.ok) break;
		} catch {
			/* still starting */
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	const { chromium } = await import("playwright");
	const installed = findInstalledChromium();
	browser = await chromium.launch(installed ? { executablePath: installed } : {});
});

after(async () => {
	if (browser) await browser.close();
	if (workerProcess) {
		try {
			process.kill(-workerProcess.pid, "SIGTERM");
		} catch {
			workerProcess.kill("SIGTERM");
		}
	}
	if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
});

test("browser and Worker read every page in the sitemap the same way", async (t) => {
	if (!haveTools) return t.skip("wrangler and playwright are not installed");

	const paths = pathsFromSitemap(readFileSync(path.join(repoRoot, "sitemap.xml"), "utf8"));
	assert.ok(paths.length > 100, `expected the whole site, got ${paths.length}`);

	const tab = await browser.newPage();
	const disagreements = [];
	const fromBrowser = [];

	for (const pagePath of paths) {
		const file = fileFor(pagePath);
		assert.ok(file, `${pagePath} is in the sitemap but has no file`);
		const relative = path.relative(repoRoot, file);

		// --- browser: the DOM a visitor gets -------------------------------
		await tab.goto(`${STATIC_ORIGIN}/${relative}`, { waitUntil: "domcontentloaded" });
		const browserSummary = await tab.evaluate(async () => {
			const { summarisePage } = await import("/assets/js/seo-check.js");
			return summarisePage(document, null);
		});

		// --- Worker: HTMLRewriter over the raw bytes -----------------------
		const response = await fetch(`${WORKER_ORIGIN}/seo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ html: readFileSync(file, "utf8") }),
		});
		assert.ok(response.ok, `the probe failed on ${pagePath}`);
		const workerSummary = await response.json();

		// Only the fields the checks actually read, and compared the way the
		// checks read them -- checkSeo trims the title, so a stray newline
		// between <title> and its text is not a disagreement that matters.
		// wordCount and the body sketch are left out: HTMLRewriter and the DOM
		// chunk whitespace differently, and the checks that read those only
		// care about the order of magnitude, not the exact figure.
		const compare = (summary) => ({
			title: String(summary.title || "").trim(),
			description: String(summary.description || "").trim(),
			h1Count: summary.h1Count,
			h1: String(summary.h1 || "").replace(/\s+/g, " ").trim(),
			hasCanonical: summary.hasCanonical,
			canonicalHref: summary.canonicalHref ?? null,
			robots: summary.robots ?? null,
			ogTitle: summary.ogTitle ?? null,
			ogDescription: summary.ogDescription ?? null,
			hasOgImage: !!summary.hasOgImage,
			schemaBlocks: summary.schemaBlocks,
			schemaBroken: summary.schemaBroken,
			orgMissing: summary.orgMissing ?? null,
			altText: summary.images.map((image) => (image.hasAlt ? String(image.altText || "") : null)),
			targets: summary.links.map((link) => linkTarget(link.href, pagePath)).filter((target) => target !== null),
		});

		const mine = compare(browserSummary);
		const theirs = compare(workerSummary);
		for (const field of Object.keys(mine)) {
			if (JSON.stringify(mine[field]) !== JSON.stringify(theirs[field])) {
				disagreements.push({ page: pagePath, field, browser: mine[field], worker: theirs[field] });
			}
		}

		fromBrowser.push({ path: pagePath, title: mine.title, description: mine.description, targets: mine.targets });
	}
	await tab.close();

	assert.deepEqual(
		disagreements.slice(0, 5),
		[],
		`${disagreements.length} field(s) read differently by the browser and the Worker`
	);

	// And the conclusion drawn from them, not just the raw fields: a
	// disagreement that cancels out at the field level but changes the report
	// would be the worst kind to miss.
	const broken = [...new Set(fromBrowser.flatMap((page) => page.targets))]
		.filter((target) => !paths.includes(target))
		.filter((target) => !fileFor(target));
	const findings = checkSite({ pages: fromBrowser, broken });
	assert.ok(
		findings.every((finding) => finding.pages && finding.pages.length),
		"every whole-site finding names the pages it is about, or it cannot be acted on"
	);
});
