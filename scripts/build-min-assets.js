// Writes a minified .min.js or .min.css copy of every public script and
// stylesheet the site actually serves to visitors.
//
// The pages only ever reference the plain file -- <script src="script.js">,
// <link href="style.css"> -- and never the minified one. The Worker (see
// fetchMinifiedAsset in src/assets.js) swaps in the .min copy at serve time
// whenever it exists, so these are picked up without touching a single one
// of the 130+ HTML files that reference them.
//
// Only the files a visitor's browser actually loads are listed here. The
// admin editor's own scripts (editor.js and what it imports) are deliberately
// left out: they load for one signed-in admin, are already marked
// Cache-Control: no-cache in _headers because their wording changes often,
// and every comment in them is there for whoever maintains this repo next --
// stripping those for an audience of one browser tab buys nothing.
//
// Same author-time generation step as scripts/build-css.js and
// scripts/build-avif.js: run it after changing one of the files below, then
// commit what it writes.
//
//   npm run build:min
//
// terser and clean-css are devDependencies, so this needs `npm install`
// first. Nothing at deploy time or runtime needs them -- the .min files are
// committed, and a source file with no .min copy alongside it is served as
// itself, unminified, until this is rerun. See fetchMinifiedAsset's fallback.

import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { minify } from "terser";
import CleanCSS from "clean-css";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const JS_FILES = [
	"assets/js/script.js",
	"assets/js/search.js",
	"assets/js/chat.js",
	"assets/js/booking.js",
];
const CSS_FILES = ["assets/css/style.css"];

// A source file older than its .min copy is already reflected in it. Pass
// --force to rebuild everything regardless, e.g. after upgrading terser or
// clean-css and wanting the new output.
const force = process.argv.includes("--force");

function isCurrent(sourcePath, minPath) {
	return !force && existsSync(minPath) && statSync(minPath).mtimeMs >= statSync(sourcePath).mtimeMs;
}

function report(name, before, after) {
	console.log(`${name} ${before} -> ${after} (${Math.round((1 - after / before) * 100)}% smaller)`);
}

let totalBefore = 0;
let totalAfter = 0;
let written = 0;
let skipped = 0;

for (const relative of JS_FILES) {
	const sourcePath = path.join(repoRoot, relative);
	const minPath = sourcePath.replace(/\.js$/, ".min.js");
	const source = readFileSync(sourcePath, "utf8");
	totalBefore += Buffer.byteLength(source);

	if (isCurrent(sourcePath, minPath)) {
		totalAfter += statSync(minPath).size;
		skipped += 1;
		continue;
	}

	// mangle: false. These are plain scripts with no bundler and no build-time
	// scope isolation -- top-level `const` and `function` names in script.js,
	// search.js and chat.js are only ever referenced within their own file, so
	// mangling is safe in principle, but keeping names readable is what makes
	// "view source" on the deployed site still make sense to whoever opens the
	// devtools panel, which happens more often for a marketing site than the
	// last few percent of byte savings is worth.
	const result = await minify(source, { mangle: false, compress: true, format: { comments: false } });
	if (result.error) throw result.error;
	writeFileSync(minPath, result.code);
	totalAfter += Buffer.byteLength(result.code);
	written += 1;
	report(relative, Buffer.byteLength(source), Buffer.byteLength(result.code));
}

const cleanCss = new CleanCSS({ level: 2 });
for (const relative of CSS_FILES) {
	const sourcePath = path.join(repoRoot, relative);
	const minPath = sourcePath.replace(/\.css$/, ".min.css");
	const source = readFileSync(sourcePath, "utf8");
	totalBefore += Buffer.byteLength(source);

	if (isCurrent(sourcePath, minPath)) {
		totalAfter += statSync(minPath).size;
		skipped += 1;
		continue;
	}

	const result = cleanCss.minify(source);
	if (result.errors.length) throw new Error(result.errors.join("\n"));
	writeFileSync(minPath, result.styles);
	totalAfter += Buffer.byteLength(result.styles);
	written += 1;
	report(relative, Buffer.byteLength(source), Buffer.byteLength(result.styles));
}

const saved = totalBefore - totalAfter;
console.log(
	`\n${written} written, ${skipped} already current. ` +
		`${Math.round(totalBefore / 1024)} KiB -> ${Math.round(totalAfter / 1024)} KiB served ` +
		`(${Math.round(saved / 1024)} KiB, ${Math.round((saved / totalBefore) * 100)}% smaller).`
);
