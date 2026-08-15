// Bakes published visual-editor changes back into the HTML files.
//
// Copy edited through the editor goes live immediately as an overlay applied
// at the edge (see src/content-edits.js). This is the step that folds those
// changes into the repository, so the files and the website say the same
// thing and nobody later "fixes" a page back to wording that was deliberately
// changed months ago.
//
// Typical use, from the repo root:
//
//   # 1. Grab what's live. In the editor: Changes -> the same data is at
//   #    /api/content/export while signed in as an admin.
//   node scripts/sync-content-edits.js --input edits.json          # preview
//   node scripts/sync-content-edits.js --input edits.json --write  # apply
//
//   # or straight from the site, using the session cookie from your browser:
//   node scripts/sync-content-edits.js --url https://www.tcbpestcontrolcanberra.com.au \
//       --cookie "tcb_staff_session=..." --write --clear
//
// Nothing is written without --write. Anything that can't be matched is
// listed rather than guessed at -- that means the file was hand-edited after
// the change was published, and it needs a person to look at it.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bakeEdits, pathToFile } from "../src/bake-edits.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const args = { write: false, clear: false, input: null, url: null, cookie: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--write") args.write = true;
		else if (arg === "--clear") args.clear = true;
		else if (arg === "--input") args.input = argv[++i];
		else if (arg === "--url") args.url = argv[++i];
		else if (arg === "--cookie") args.cookie = argv[++i];
		else if (arg === "--help" || arg === "-h") args.help = true;
		else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}
	return args;
}

async function loadExport(args) {
	if (args.input) {
		return JSON.parse(readFileSync(args.input, "utf8"));
	}
	if (!args.url) {
		console.error("Give me either --input <file.json> or --url <site> --cookie <staff session cookie>.");
		process.exit(1);
	}
	const response = await fetch(new URL("/api/content/export", args.url), {
		headers: args.cookie ? { Cookie: args.cookie } : {},
	});
	if (!response.ok) {
		console.error(`Could not read /api/content/export (${response.status}).`);
		if (response.status === 401 || response.status === 403) {
			console.error("That endpoint needs an admin staff session -- copy the tcb_staff_session cookie from your browser.");
		}
		process.exit(1);
	}
	return response.json();
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 22).join("\n"));
	process.exit(0);
}

const data = await loadExport(args);
const edits = Array.isArray(data.edits) ? data.edits : [];
if (!edits.length) {
	console.log("No published edits to sync. Nothing to do.");
	process.exit(0);
}

// Group by page, because each file is rewritten in a single pass -- the
// ordinals only make sense when every edit for a page is applied together.
const byPath = new Map();
for (const edit of edits) {
	if (!byPath.has(edit.path)) byPath.set(edit.path, []);
	byPath.get(edit.path).push(edit);
}

const synced = [];
const problems = [];
let filesChanged = 0;

for (const [pagePath, pageEdits] of [...byPath].sort()) {
	const relative = pathToFile(pagePath);
	const file = path.join(repoRoot, relative);
	if (!existsSync(file)) {
		problems.push(`${pagePath}: no such file (${relative})`);
		continue;
	}

	const before = readFileSync(file, "utf8");
	const map = new Map(pageEdits.map((edit) => [edit.address, edit.published]));
	const { html, applied, missing } = bakeEdits(before, map);

	for (const address of missing) {
		const edit = pageEdits.find((candidate) => candidate.address === address);
		problems.push(`${pagePath}: could not find ${JSON.stringify(edit ? edit.original : address)} in ${relative}`);
	}
	for (const address of applied) synced.push({ path: pagePath, address });

	if (html === before) {
		console.log(`  ${relative}: no change`);
		continue;
	}

	filesChanged++;
	console.log(`  ${relative}: ${applied.length} ${applied.length === 1 ? "edit" : "edits"} applied`);
	if (args.write) writeFileSync(file, html);
}

console.log("");
console.log(
	args.write
		? `Updated ${filesChanged} ${filesChanged === 1 ? "file" : "files"} with ${synced.length} ${synced.length === 1 ? "edit" : "edits"}.`
		: `Would update ${filesChanged} ${filesChanged === 1 ? "file" : "files"} with ${synced.length} ${synced.length === 1 ? "edit" : "edits"}. Re-run with --write to apply.`
);

if (problems.length) {
	console.log("");
	console.log(`${problems.length} could not be matched -- these pages were probably hand-edited after publishing:`);
	for (const problem of problems) console.log(`  - ${problem}`);
	console.log("Their overrides are left in place, so the live site still shows them.");
}

// Clearing is only offered once the edits are genuinely in the files. Until
// then the overlay is the only copy of the change, and dropping it would lose
// work.
if (args.clear && args.write && synced.length) {
	if (!args.url) {
		console.log("");
		console.log("--clear needs --url (and --cookie) so it can tell the site which edits are now in the code.");
	} else {
		const response = await fetch(new URL("/api/content/mark-synced", args.url), {
			method: "POST",
			headers: { "content-type": "application/json", ...(args.cookie ? { Cookie: args.cookie } : {}) },
			body: JSON.stringify({ entries: synced }),
		});
		const result = await response.json().catch(() => ({}));
		console.log("");
		console.log(
			response.ok ? `Cleared ${result.cleared} synced overrides from the site.` : `Could not clear overrides (${response.status}).`
		);
	}
}

if (args.write && filesChanged) {
	console.log("");
	console.log("Now commit the changes:  git add -A && git commit -m \"Sync published copy edits\"");
}
