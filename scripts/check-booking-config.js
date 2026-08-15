// Verifies the three copies of the booking widget's service/price data agree.
//
// src/booking-config.js is the source of truth, but two copies have to exist
// for the page to work at all:
//   1. assets/js/booking.js -- a plain <script> served to the browser, so it
//      cannot import the Worker's ES module; it carries a display-only copy.
//   2. book/index.html      -- the <select> of services, which is plain HTML.
// Nothing at runtime cross-checks them: a price edited in one place and not
// the others shows the customer one number and charges another. This script
// is that cross-check.
//
// Run it with:  npm run check:booking
// Exits 0 when everything matches, 1 (with a list of what differs) when it
// doesn't. Read-only -- it never edits a file.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The Worker's own module -- imported rather than parsed, so this is literally
// the same data the server uses to price a booking.
const truth = await import(join(ROOT, "src/booking-config.js"));

// The browser copy is a plain script (no exports), so pull out the leading
// data block and evaluate just that. Anchored on the first function that
// follows it, which is what separates data from behaviour in that file.
async function readBrowserCopy() {
	const src = await readFile(join(ROOT, "assets/js/booking.js"), "utf8");
	const start = src.indexOf("var PRICING");
	const end = src.indexOf("function getModifierType");
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			"Couldn't find the PRICING block in assets/js/booking.js -- if that file was restructured, update scripts/check-booking-config.js to match."
		);
	}
	const block = src.slice(start, end);
	return new Function(`${block}\nreturn { PRICING, MODIFIER_LABELS, MODIFIER_OPTIONS };`)();
}

// The service <select> on /book. Values are service keys, text is the label.
async function readServiceOptions() {
	const html = await readFile(join(ROOT, "book/index.html"), "utf8");
	const select = /<select[^>]*id="bk-service"[\s\S]*?<\/select>/.exec(html);
	if (!select) {
		throw new Error('Couldn\'t find <select id="bk-service"> in book/index.html -- update scripts/check-booking-config.js if the form was restructured.');
	}
	const labels = {};
	for (const m of select[0].matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
		const value = m[1];
		if (!value) continue; // the disabled "Select a service…" placeholder
		labels[value] = m[2]
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.trim();
	}
	return labels;
}

const problems = [];
const note = (where, msg) => problems.push(`${where}: ${msg}`);

const browser = await readBrowserCopy();
const optionLabels = await readServiceOptions();

// 1. Every bookable service needs a label and a price, and nothing may be
//    priced that isn't bookable (that would 400 at the slot-maths stage).
for (const key of Object.keys(truth.SERVICE_DURATIONS)) {
	if (!truth.SERVICE_LABELS[key]) note("src/booking-config.js", `service "${key}" has a duration but no SERVICE_LABELS entry`);
	if (!truth.PRICING[key]) note("src/booking-config.js", `service "${key}" has a duration but no PRICING entry`);
}
for (const key of Object.keys(truth.PRICING)) {
	if (!truth.SERVICE_DURATIONS[key]) note("src/booking-config.js", `service "${key}" is priced but has no SERVICE_DURATIONS entry, so it can't be booked`);
}

// 2. Every priced service must resolve to a real amount for every option a
//    customer can pick -- a missing amount is a hard "choose an option" error
//    on submit, after they've already filled the form in.
for (const [key, entry] of Object.entries(truth.PRICING)) {
	if (entry.modifier === "none") {
		if (typeof entry.price !== "number") note("src/booking-config.js", `"${key}" has modifier "none" but no flat \`price\` number`);
		continue;
	}
	const options = truth.MODIFIER_OPTIONS[entry.modifier];
	if (!options) {
		note("src/booking-config.js", `"${key}" uses modifier "${entry.modifier}", which has no MODIFIER_OPTIONS entry`);
		continue;
	}
	if (!truth.MODIFIER_LABELS[entry.modifier]) note("src/booking-config.js", `modifier "${entry.modifier}" has no MODIFIER_LABELS question text`);
	for (const opt of options) {
		if (typeof (entry.prices || {})[opt.value] !== "number") {
			note("src/booking-config.js", `"${key}" has no price for the "${opt.value}" option (${opt.label})`);
		}
	}
}

// 3. The browser's display copy must be value-for-value identical, or the
//    price shown before submit isn't the price charged after it.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const name of ["PRICING", "MODIFIER_LABELS", "MODIFIER_OPTIONS"]) {
	if (!same(truth[name], browser[name])) {
		note("assets/js/booking.js", `${name} does not match src/booking-config.js`);
		const keys = new Set([...Object.keys(truth[name]), ...Object.keys(browser[name])]);
		for (const k of keys) {
			if (same(truth[name][k], browser[name][k])) continue;
			note("  ", `${name}["${k}"]  server: ${JSON.stringify(truth[name][k])}  browser: ${JSON.stringify(browser[name][k])}`);
		}
	}
}

// 4. The <select> on /book must offer exactly the bookable services, with the
//    same labels -- a stale option posts a key the server rejects.
for (const [key, label] of Object.entries(truth.SERVICE_LABELS)) {
	if (!(key in optionLabels)) note("book/index.html", `service "${key}" (${label}) is missing from the Service dropdown`);
	else if (optionLabels[key] !== label) note("book/index.html", `"${key}" reads "${optionLabels[key]}" but SERVICE_LABELS says "${label}"`);
}
for (const key of Object.keys(optionLabels)) {
	if (!truth.SERVICE_LABELS[key]) note("book/index.html", `the Service dropdown offers "${key}", which isn't a bookable service -- picking it fails on submit`);
}

if (problems.length) {
	console.error(`✗ Booking config is out of sync (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`);
	for (const p of problems) console.error(`  ${p}`);
	console.error("\nsrc/booking-config.js is the source of truth -- bring the others into line with it.");
	process.exit(1);
}

console.log(`✓ Booking config is in sync across src/booking-config.js, assets/js/booking.js and book/index.html (${Object.keys(truth.SERVICE_DURATIONS).length} services).`);
