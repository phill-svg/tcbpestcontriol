// Moves the site's repeated inline icons into one cached sprite file, and
// strips the markup that was wrapped around them.
//
// The site is drawn with Lucide icons, inlined at every use. There are 6,359
// of them across 137 pages and only 58 distinct shapes, so the same handful of
// paths is written into the HTML over and over -- 2,244 KiB of it, which is a
// third of all the HTML the site serves. An audit flagged the symptom ("low
// text to HTML ratio" on 53 pages); this is the cause.
//
// Three things are done here, in order of how much they save:
//
// 1. The five presentation attributes every line icon carries --
//    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
//    stroke-linejoin="round" -- are 98 bytes repeated 5,676 times, 543 KiB in
//    total. They become one class, .icon-line, defined once in the CSS.
//
// 2. Dead class names are removed: 205 KiB of `lucide`, `lucide-arrow-right`,
//    `size-3`, `text-ink-faint`, `transition`, `group-hover:text-accent` and
//    friends. These are leftovers from a Tailwind build this site no longer
//    has -- none of them is defined in any stylesheet or read by any script,
//    so they style nothing and never have. Anything that IS defined in
//    style.css (.icon, .icon-accent, .icon-muted, .icon-arrow) is kept, and
//    the check is against the built stylesheet rather than a hand-written
//    list, so a class that gains a definition later stops being stripped.
//
// 3. What is left of each icon -- the actual <path> geometry -- moves into
//    assets/icons.svg as a <symbol>, and each use becomes a one-line <use>
//    reference.
//
// The outer <svg> keeps every attribute that decides how it looks: its
// classes, width, height, viewBox, and any presentation attribute that is not
// the standard set. That is deliberate. fill and stroke are inherited SVG
// properties, and they inherit across the <use> shadow boundary, so
// `.footer-rating svg { fill: var(--accent) }` still reaches the path inside
// the symbol. Moving those onto the symbol instead would break that rule and
// the stars would come out black.
//
// Not touched: the two icons that are not aria-hidden (in /book and
// /staff-chat), and the three that use stroke-width 1.5. Both are one-offs
// where the saving is nil and the risk is not.
//
// Idempotent, and safe to re-run after adding pages: an icon already pointing
// at the sprite is left alone, and a new inline one is folded in.
//
//   npm run build:icons
//
// Same author-time step as build-css.js and build-avif.js -- the sprite is
// committed, and nothing at deploy or request time depends on this script.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// The sprite is served with a one-year immutable Cache-Control (see _headers),
// which is the right lifetime for a file this static and this widely
// requested -- and a trap without the version below. A visitor who has the
// old copy would keep it for a year, so an icon added after they cached it
// would resolve to a symbol their sprite does not contain and simply not
// draw. Bump SPRITE_VERSION whenever the generated sprite changes, exactly as
// the ?v= on style.css and the scripts is bumped, then re-run this script so
// every page points at the new URL.
export const SPRITE_VERSION = 1;
export const SPRITE_PATH = `/assets/icons.svg?v=${SPRITE_VERSION}`;

// The presentation attributes .icon-line stands in for. An icon has to carry
// all five, with exactly these values, to be rewritten -- the three icons
// drawn at stroke-width 1.5 keep their own attributes and are left inline.
const LINE_ICON_ATTRS = {
	fill: "none",
	stroke: "currentColor",
	"stroke-width": "2",
	"stroke-linecap": "round",
	"stroke-linejoin": "round",
};

// Attributes kept on the outer <svg>, in the order the pages already write
// them, so the diff shows icons shrinking rather than every attribute moving.
const KEPT_ATTRS = ["height", "viewbox", "width"];

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === ".wrangler") continue;
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (name === "index.html" || name === "404.html" || name === "_blog-template.html") out.push(full);
	}
	return out;
}

// Every class name that appears in the built stylesheets. Read rather than
// hard-coded: the point is to strip what nothing defines, and a hand-written
// list would go stale the moment somebody adds a rule.
export function definedClasses(...cssSources) {
	const defined = new Set();
	for (const css of cssSources) {
		for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(match[1]);
	}
	return defined;
}

export function parseAttributes(raw) {
	const attributes = {};
	for (const match of String(raw || "").matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)) {
		attributes[match[1].toLowerCase()] = match[2];
	}
	return attributes;
}

export function geometryHash(viewBox, inner) {
	return crypto
		.createHash("sha1")
		.update(`${viewBox}|${inner.replace(/\s+/g, " ").trim()}`)
		.digest("hex")
		.slice(0, 6);
}

// One name per distinct shape, worked out across the whole site before
// anything is rewritten.
//
// Two passes rather than one because the name depends on pages this one has
// not read yet. The same arrow is written with a `lucide-arrow-up-right`
// class in some places and with a bare `class="icon"` in others; naming each
// occurrence as it is met produced `arrow-up-right` and `icon-ac5e7b` -- two
// symbols for one drawing, and the bare ones stuck with an unreadable name
// for no reason. Collecting first means the readable name wins wherever the
// shape appears.
export function planSymbols(pages) {
	const byGeometry = new Map();
	for (const html of pages) {
		for (const match of String(html).matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
			const attributes = parseAttributes(match[1]);
			if (!isConvertible(attributes, match[2])) continue;
			const viewBox = attributes.viewbox || "0 0 24 24";
			const inner = match[2].replace(/\s+/g, " ").trim();
			const hash = geometryHash(viewBox, inner);
			const lucide = (attributes.class || "").split(/\s+/).find((name) => /^lucide-.+/.test(name));
			const entry = byGeometry.get(hash) || { viewBox, inner, name: null };
			if (lucide && !entry.name) entry.name = lucide.replace(/^lucide-/, "");
			byGeometry.set(hash, entry);
		}
	}

	// Anything with no Lucide class anywhere on the site is named for its
	// geometry, and a name covering two different drawings keeps them apart.
	const used = new Set();
	for (const [hash, entry] of byGeometry) {
		let name = entry.name || `icon-${hash}`;
		if (used.has(name)) name = `${name}-${hash}`;
		used.add(name);
		entry.name = name;
	}
	return byGeometry;
}

// Whether this <svg> is one of the repeated decorative icons this script is
// for. Everything else -- the two that carry a label, the three drawn at
// stroke-width 1.5, anything already converted -- is left exactly as written.
export function isConvertible(attributes, inner) {
	if (/<use\b/.test(inner)) return false;
	if (attributes["aria-hidden"] !== "true") return false;
	const isLineIcon = Object.entries(LINE_ICON_ATTRS).every(([name, value]) => attributes[name] === value);
	const hasOtherPresentation = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"].some(
		(name) => attributes[name] !== undefined
	);
	return isLineIcon || !hasOtherPresentation;
}

// Rewrites one page against the names planSymbols worked out.
export function rewritePage(html, { defined, byGeometry }) {
	let rewritten = 0;
	const out = html.replace(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g, (whole, rawAttributes, inner) => {
		const attributes = parseAttributes(rawAttributes);
		if (!isConvertible(attributes, inner)) return whole;

		const viewBox = attributes.viewbox || "0 0 24 24";
		const entry = byGeometry.get(geometryHash(viewBox, inner.replace(/\s+/g, " ").trim()));
		if (!entry) return whole;

		const isLineIcon = Object.entries(LINE_ICON_ATTRS).every(([name, value]) => attributes[name] === value);
		const classes = (attributes.class || "")
			.split(/\s+/)
			.filter(Boolean)
			// The whole point: keep what a stylesheet defines, drop what none does.
			.filter((name) => defined.has(name));
		if (isLineIcon) classes.unshift("icon-line");

		const kept = KEPT_ATTRS.filter((attribute) => attributes[attribute] !== undefined)
			.map((attribute) => ` ${attribute}="${attributes[attribute]}"`)
			.join("");
		const classAttribute = classes.length ? ` class="${classes.join(" ")}"` : "";
		rewritten++;
		return `<svg aria-hidden="true"${classAttribute}${kept}><use href="${SPRITE_PATH}#${entry.name}"></use></svg>`;
	});
	return { html: out, rewritten };
}

// The sprite itself. A real SVG document, so attribute names are the
// case-sensitive XML spellings -- viewBox, not the viewbox an HTML parser
// hands back. The comment avoids a double hyphen, which XML does not allow
// inside one, and which quietly made the first version of this file
// unparseable as XML.
export function renderSprite(symbols) {
	const parts = [...symbols.byName.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, { viewBox, inner }]) => `<symbol id="${name}" viewBox="${viewBox}">${inner}</symbol>`);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg">` +
		`<!-- Generated by scripts/build-icon-sprite.js. Do not edit by hand. -->` +
		parts.join("") +
		`</svg>\n`
	);
}

// Symbols already in the committed sprite, so a re-run does not empty it.
//
// This is the trap in a script that both rewrites the pages and generates the
// file they point at: after the first run there are no inline icons left to
// read, so regenerating purely from the pages would write an empty sprite and
// break every icon on the site. The existing symbols are loaded first, the
// run adds any new ones, and only symbols nothing references are dropped.
export function parseSprite(svg) {
	const symbols = new Map();
	for (const match of String(svg || "").matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
		symbols.set(match[1], { viewBox: match[2], inner: match[3] });
	}
	return symbols;
}

export function referencedSymbols(html) {
	const names = new Set();
	for (const match of String(html || "").matchAll(/<use href="[^"#]*#([^"]+)"/g)) names.add(match[1]);
	return names;
}

// Only run the migration when invoked directly, so the tests can import the
// pure functions above without rewriting the site as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	const defined = definedClasses(
		readFileSync(path.join(repoRoot, "assets/css/style.css"), "utf8"),
		readFileSync(path.join(repoRoot, "assets/css/editor.css"), "utf8")
	);
	// .icon-line is being introduced by this change, so it is defined in the
	// stylesheet but may not be in the copy on disk when this first runs.
	defined.add("icon-line");

	const spriteFile = path.join(repoRoot, "assets/icons.svg");
	const pages = walk(repoRoot);

	// One name per shape, decided across every page before anything is
	// rewritten -- see planSymbols.
	const byGeometry = planSymbols(pages.map((file) => readFileSync(file, "utf8")));

	// Symbols already committed are kept as well, so a re-run over pages that
	// have nothing left to convert does not empty the sprite -- see parseSprite.
	const symbols = { byName: new Map() };
	try {
		for (const [name, entry] of parseSprite(readFileSync(spriteFile, "utf8"))) symbols.byName.set(name, entry);
	} catch {
		// First run: there is no sprite yet.
	}
	for (const { name, viewBox, inner } of byGeometry.values()) {
		symbols.byName.set(name, { viewBox, inner });
	}

	const referenced = new Set();
	let changedPages = 0;
	let totalRewritten = 0;
	let before = 0;
	let after = 0;

	for (const file of pages) {
		const html = readFileSync(file, "utf8");
		before += Buffer.byteLength(html);
		const { html: updated, rewritten } = rewritePage(html, { defined, byGeometry });
		after += Buffer.byteLength(updated);
		for (const name of referencedSymbols(updated)) referenced.add(name);
		if (updated !== html) {
			writeFileSync(file, updated);
			changedPages++;
			totalRewritten += rewritten;
		}
	}

	// A symbol nothing points at any more is dead weight in a file every
	// visitor downloads.
	for (const name of [...symbols.byName.keys()]) {
		if (!referenced.has(name)) symbols.byName.delete(name);
	}

	const sprite = renderSprite(symbols);
	writeFileSync(spriteFile, sprite);

	const saved = before - after;
	console.log(
		`${totalRewritten} icons across ${changedPages} pages now reference ${symbols.byName.size} symbols.\n` +
			`HTML ${Math.round(before / 1024)} KiB -> ${Math.round(after / 1024)} KiB ` +
			`(${Math.round(saved / 1024)} KiB, ${Math.round((saved / before) * 100)}% smaller), ` +
			`plus one ${Math.round(Buffer.byteLength(sprite) / 1024)} KiB sprite served once.`
	);
}
