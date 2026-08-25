// The minified files have to match the sources they were built from.
//
// This exists because of a bug that reached the live site. The Worker serves
// assets/css/style.min.css in preference to style.css whenever the minified
// copy exists (fetchMinifiedAsset in src/assets.js), so the minified file is
// not a nice-to-have -- it is what visitors actually get. A rule was added to
// style.css and build:min was never re-run, so the site served a stylesheet
// missing that rule for hours. The rule was .icon-line, which is what gives
// every icon on the site `fill: none` and a stroke, so all of them rendered
// as solid black silhouettes.
//
// Nothing about that failure is visible in a diff: both files are committed,
// both look fine on their own, and the stale one is the one that ships. The
// only way to catch it is to rebuild and compare.
//
// Regenerate with `npm run build:min` whenever a source file changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import CleanCSS from "clean-css";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Kept in step with MINIFIABLE in src/assets.js -- if the Worker will serve a
// minified copy of a file, that copy has to be current.
const JS_FILES = ["assets/js/script.js", "assets/js/search.js", "assets/js/chat.js", "assets/js/booking.js"];
const CSS_FILES = ["assets/css/style.css"];

const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

test("every minified file the Worker serves is current with its source", async () => {
	const stale = [];

	for (const relative of JS_FILES) {
		const minPath = relative.replace(/\.js$/, ".min.js");
		assert.ok(existsSync(path.join(repoRoot, minPath)), `${minPath} is missing -- run npm run build:min`);
		const result = await minify(read(relative), { mangle: false, compress: true, format: { comments: false } });
		if (result.code !== read(minPath)) stale.push(minPath);
	}

	const cleanCss = new CleanCSS({ level: 2 });
	for (const relative of CSS_FILES) {
		const minPath = relative.replace(/\.css$/, ".min.css");
		assert.ok(existsSync(path.join(repoRoot, minPath)), `${minPath} is missing -- run npm run build:min`);
		if (cleanCss.minify(read(relative)).styles !== read(minPath)) stale.push(minPath);
	}

	assert.deepEqual(
		stale,
		[],
		`these are what visitors are served, and they no longer match their source. Run: npm run build:min`
	);
});

test("the minified stylesheet carries the icon rule the whole site depends on", () => {
	// The specific regression above, pinned by name. Without .icon-line every
	// icon falls back to SVG's default fill of black and no stroke, which is
	// not subtly wrong -- it is a page full of black blobs.
	const minified = read("assets/css/style.min.css");
	assert.match(minified, /\.icon-line\{[^}]*fill:none/, "no .icon-line rule in the file the site actually serves");
	assert.match(minified, /\.icon-line\{[^}]*stroke:currentColor/);
});
