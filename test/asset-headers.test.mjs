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
import { readFileSync } from "node:fs";
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
