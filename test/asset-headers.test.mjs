// The editor's stylesheet must not be frozen in browsers for a year.
//
// This is guarding a footgun that already went off once. `/assets/css/*` is
// marked immutable, which is right for style.css (every page links it with a
// ?v= that gets bumped on release) and wrong for editor.css (injected by the
// Worker, with a ?v= that is easy to forget). Every rule added to editor.css
// after its first deploy was invisible to anyone who had already loaded it --
// their browser had been told to keep the old copy for a year and never ask.
//
// The fix depends on rule *order*: `_headers` applies matching rules in file
// order and later ones win, so the specific rule has to come after the glob.
// That is subtle enough to be worth pinning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const headers = readFileSync(path.join(repoRoot, "_headers"), "utf8");

test("editor.css is exempt from the immutable rule, and the exemption comes last", () => {
	const glob = headers.indexOf("/assets/css/*");
	const specific = headers.indexOf("/assets/css/editor.css");

	assert.ok(glob !== -1, "the immutable rule for stylesheets should still exist");
	assert.ok(specific !== -1, "editor.css needs its own rule");
	assert.ok(specific > glob, "_headers applies rules in order, so the exemption must come after the glob to win");

	const rule = headers.slice(specific, headers.indexOf("\n\n", specific));
	assert.match(rule, /Cache-Control:\s*no-cache/, "editor.css must revalidate");
	assert.doesNotMatch(rule, /immutable/);
});

test("the injected stylesheet carries a version that has moved past the frozen one", () => {
	// Copies cached under the old immutable rule cannot be revalidated away --
	// a different URL is the only way past them.
	const worker = readFileSync(path.join(repoRoot, "src", "index.js"), "utf8");
	const match = worker.match(/editor\.css\?v=(\d+)/);
	assert.ok(match, "the editor stylesheet should be requested with a version");
	assert.ok(Number(match[1]) >= 2, "v=1 is the version that got frozen in browsers");
});

test("editor.js is exempt from the immutable rule for scripts, and comes last", () => {
	// Same shape as the editor.css exemption above, for the same reason: it is
	// injected by the Worker, so nothing on the page forces its ?v= to be bumped.
	const glob = headers.indexOf("/assets/js/*");
	const specific = headers.indexOf("/assets/js/editor.js");

	assert.ok(glob !== -1, "scripts need a cache lifetime -- without one they refetch every page view");
	assert.ok(specific !== -1, "editor.js needs its own rule");
	assert.ok(specific > glob, "_headers applies rules in order, so the exemption must come after the glob to win");

	const rule = headers.slice(specific, headers.indexOf("\n\n", specific));
	assert.match(rule, /Cache-Control:\s*no-cache/);
	assert.doesNotMatch(rule, /immutable/);
});

test("every script a page links carries a version, since /assets/js/* is frozen for a year", () => {
	// A script frozen at a URL with no ?v= can never be updated for anyone who
	// has already loaded it. Whenever one of these files changes, bump its ?v=.
	const pages = readdirSync(repoRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
		.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

	const unversioned = new Set();
	for (const page of pages) {
		for (const [, src] of readFileSync(page, "utf8").matchAll(/<script[^>]*\ssrc="([^"]*assets\/js\/[^"]+)"/g)) {
			if (!/\?v=\d+$/.test(src)) unversioned.add(`${path.relative(repoRoot, page)}: ${src}`);
		}
	}

	assert.deepEqual([...unversioned], [], "these script tags would be frozen at a URL that can never be refreshed");
});

test("the scripts the Worker injects carry a version too", () => {
	// These never appear in the HTML files, so the check above cannot see them.
	const worker = readFileSync(path.join(repoRoot, "src", "index.js"), "utf8");
	for (const [, src] of worker.matchAll(/<script src="(\/assets\/js\/[^"]+)"/g)) {
		const isExempt = src.startsWith("/assets/js/editor.js");
		assert.ok(isExempt || /\?v=\d+$/.test(src), `${src} is served immutable and needs a ?v=`);
	}
});

test("every module the editor imports is exempt from the year-long freeze", () => {
	// The same footgun as editor.css and editor.js, one level further in, and
	// this one has no escape hatch at all: an ES module import specifier
	// cannot carry a ?v=. `import "./seo-check.js"` is fetched at a bare URL,
	// matches /assets/js/*, and is frozen for a year.
	//
	// It went off. editor.js was being served fresh while seo-check.js and
	// seo-site.js -- which hold the checks themselves -- came from a year-old
	// cache, so every change to them appeared to do nothing at all.
	//
	// Derived from the imports rather than a hand-written list, so a module
	// added later is covered without anybody remembering this file exists.
	const editor = readFileSync(path.join(repoRoot, "assets", "js", "editor.js"), "utf8");
	const imported = [...editor.matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)].map(([, name]) => name);
	assert.ok(imported.length >= 3, `expected the editor's imports, found ${imported.length}`);

	const headers = readFileSync(path.join(repoRoot, "_headers"), "utf8");
	const glob = headers.indexOf("/assets/js/*");
	assert.ok(glob !== -1);

	for (const name of imported) {
		const at = headers.indexOf(`/assets/js/${name}\n`);
		assert.ok(at !== -1, `/assets/js/${name} has no rule, so it is frozen for a year and can never be updated`);
		assert.ok(at > glob, `/assets/js/${name} must come after the glob to win`);
		const rule = headers.slice(at, headers.indexOf("\n\n", at));
		assert.match(rule, /Cache-Control:\s*no-cache/, `/assets/js/${name} is not exempt from the freeze`);
	}
});

test("page templates are not served to the public", () => {
	// The templates sit at the repository root, and assets.directory is the
	// whole repository -- so anything not listed in .assetsignore is fetchable
	// by URL. A template is a page full of {{PLACEHOLDER}} with no content,
	// and Google will index it given the chance.
	//
	// Derived from the directory rather than listed here, so a template added
	// later is covered without anybody remembering to come back.
	const ignored = readFileSync(new URL("../.assetsignore", import.meta.url), "utf8")
		.split("\n")
		.map((line) => line.trim());
	const templates = readdirSync(new URL("..", import.meta.url)).filter((name) => /-template\.html$/.test(name));
	assert.ok(templates.length, "expected at least one template at the repository root");
	for (const template of templates) {
		assert.ok(ignored.includes(template), `${template} would be served to the public`);
	}
});
