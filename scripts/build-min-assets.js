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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

// --force is kept for the case where the output should be rewritten even
// though it already matches, but it no longer decides whether work happens:
// every file is minified on every run and written only if the result differs
// from what is on disk.
//
// It used to skip any file whose .min copy had a newer mtime, and that was
// wrong in a way that reached the live site. Timestamps say nothing after a
// git checkout -- every file is stamped when it was written to disk, in
// whatever order that happened -- so a rebase onto a branch with a newer
// source left the stale .min looking current, and it was skipped. The site
// served a booking.js missing a whole service's pricing entry, and the build
// reported "already current" every time it was run.
//
// Minifying five small files takes well under a second, so there is nothing
// to gain by trying to avoid it.
const force = process.argv.includes("--force");

function writeIfChanged(minPath, code) {
	if (!force && existsSync(minPath) && readFileSync(minPath, "utf8") === code) return false;
	writeFileSync(minPath, code);
	return true;
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

	// mangle: false. These are plain scripts with no bundler and no build-time
	// scope isolation -- top-level `const` and `function` names in script.js,
	// search.js and chat.js are only ever referenced within their own file, so
	// mangling is safe in principle, but keeping names readable is what makes
	// "view source" on the deployed site still make sense to whoever opens the
	// devtools panel, which happens more often for a marketing site than the
	// last few percent of byte savings is worth.
	const result = await minify(source, { mangle: false, compress: true, format: { comments: false } });
	if (result.error) throw result.error;
	totalAfter += Buffer.byteLength(result.code);
	if (writeIfChanged(minPath, result.code)) {
		written += 1;
		report(relative, Buffer.byteLength(source), Buffer.byteLength(result.code));
	} else {
		skipped += 1;
	}
}

const cleanCss = new CleanCSS({ level: 2 });
for (const relative of CSS_FILES) {
	const sourcePath = path.join(repoRoot, relative);
	const minPath = sourcePath.replace(/\.css$/, ".min.css");
	const source = readFileSync(sourcePath, "utf8");
	totalBefore += Buffer.byteLength(source);

	const result = cleanCss.minify(source);
	if (result.errors.length) throw new Error(result.errors.join("\n"));
	totalAfter += Buffer.byteLength(result.styles);
	if (writeIfChanged(minPath, result.styles)) {
		written += 1;
		report(relative, Buffer.byteLength(source), Buffer.byteLength(result.styles));
	} else {
		skipped += 1;
	}
}

const saved = totalBefore - totalAfter;
console.log(
	`\n${written} written, ${skipped} already current. ` +
		`${Math.round(totalBefore / 1024)} KiB -> ${Math.round(totalAfter / 1024)} KiB served ` +
		`(${Math.round(saved / 1024)} KiB, ${Math.round((saved / totalBefore) * 100)}% smaller).`
);
