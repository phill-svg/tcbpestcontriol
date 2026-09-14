// Writes assets/menu.json into every page that carries the header menu.
//
// The editor's Menu panel does this through the Worker, reading from and
// committing to GitHub. This is the same rewrite from a checkout: for a
// hand-edit to menu.json, or to put the menu back in step if a page's copy was
// changed by hand. It uses the same renderer, so the two cannot disagree.
//
//   npm run build:menu
//
// Refuses to write anything if a single page cannot be read, and reports
// which -- a menu that reached 138 pages out of 139 is a menu that has drifted.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateMenu, replaceMenus } from "../src/site-menu.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", ".wrangler", ".claude", "test"]);

const { menu, error } = validateMenu(JSON.parse(readFileSync(path.join(repoRoot, "assets", "menu.json"), "utf8")));
if (error) {
	console.error(`assets/menu.json: ${error}`);
	process.exit(1);
}

const files = [];
(function walk(dir) {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walk(full);
		else if (entry.endsWith(".html")) files.push(full);
	}
})(repoRoot);

const writes = [];
const problems = [];
for (const file of files) {
	const html = readFileSync(file, "utf8");
	if (!html.includes('class="main-nav"')) continue;
	const result = replaceMenus(html, menu);
	if (result.error) problems.push(`${path.relative(repoRoot, file)}: ${result.error}`);
	else if (result.html !== html) writes.push({ file, html: result.html });
}

if (problems.length) {
	console.error(`Nothing written. ${problems.length} page(s) could not be read:`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}

for (const { file, html } of writes) writeFileSync(file, html);
console.log(`Menu written into ${writes.length} file(s); the rest already matched.`);
