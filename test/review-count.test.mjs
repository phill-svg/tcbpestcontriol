// One Google rating, said the same way everywhere.
//
// The rating and review count ("4.8 from 61 reviews") are written straight
// into the pages: suburb meta descriptions, the homepage, /reviews, and the
// AggregateRating schema Google reads for star snippets. There is no shared
// source for them -- every page is finished HTML, and the head tags and
// JSON-LD have to be there when Google fetches the page. So when the count
// changes it is a site-wide find-and-replace, and a half-finished one (the
// descriptions updated, the schema not) looks completely normal page by page.
// This fails if any page disagrees with the rest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "test"]);

function sitePages(dir = repoRoot, found = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) sitePages(full, found);
		else if (entry.endsWith(".html")) found.push(path.relative(repoRoot, full).split(path.sep).join("/"));
	}
	return found;
}

// Every rating and review count a file states, in whichever form it uses.
// Individual reviews carry their own "ratingValue": "5", so schema ratings
// are only read from inside an AggregateRating block.
export function reviewFigures(text) {
	const counts = [];
	const ratings = [];
	for (const m of text.matchAll(/(\d[\d,]*) (?:Google )?reviews\b/gi)) counts.push(m[1].replace(/,/g, ""));
	for (const m of text.matchAll(/(\d\.\d)\s*(?:★|stars?\b|from \d)/g)) ratings.push(m[1]);
	for (const [block] of text.matchAll(/\{[^{}]*"AggregateRating"[^{}]*\}/g)) {
		const count = block.match(/"(?:reviewCount|ratingCount)":\s*"?(\d+)/);
		const rating = block.match(/"ratingValue":\s*"?([\d.]+)/);
		if (count) counts.push(count[1]);
		if (rating) ratings.push(rating[1]);
	}
	return { counts, ratings };
}

// Group files by the value they state, so a failure names the odd ones out.
function disagreements(files, pick) {
	const byValue = new Map();
	for (const [file, text] of files) {
		for (const value of pick(reviewFigures(text))) {
			if (!byValue.has(value)) byValue.set(value, new Set());
			byValue.get(value).add(file);
		}
	}
	return byValue;
}

function describe(byValue) {
	return [...byValue].map(([value, files]) => `  ${value}: ${[...files].join(", ")}`).join("\n");
}

const files = [...sitePages(), "llms.txt", "assets/search-index.json"].map((file) => [
	file,
	readFileSync(path.join(repoRoot, file), "utf8"),
]);

test("the check reads every form the site uses, and notices a mismatch", () => {
	const figures = reviewFigures(
		'4.8 from 61 reviews. 4.8★ on Google. 61 Google reviews. ' +
			'{"@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "62", "bestRating": "5"} ' +
			'{"@type": "Review", "reviewRating": {"@type": "Rating", "ratingValue": "5"}}',
	);
	assert.deepEqual(figures.counts, ["61", "61", "62"]);
	assert.deepEqual(figures.ratings, ["4.8", "4.8", "4.9"]);
});

test("the site states a rating and a review count somewhere", () => {
	const all = files.map(([, text]) => reviewFigures(text));
	assert.ok(all.some((f) => f.counts.length), "no review count found -- has the wording changed?");
	assert.ok(all.some((f) => f.ratings.length), "no rating found -- has the wording changed?");
});

test("every page states the same review count", () => {
	const byValue = disagreements(files, (f) => f.counts);
	assert.equal(byValue.size, 1, `review counts disagree:\n${describe(byValue)}`);
});

test("every page states the same rating", () => {
	const byValue = disagreements(files, (f) => f.ratings);
	assert.equal(byValue.size, 1, `ratings disagree:\n${describe(byValue)}`);
});
