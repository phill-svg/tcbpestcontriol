// The icon sprite, and the references every page makes into it.
//
// The failure this guards against is silent and site-wide: a <use> pointing
// at a symbol the sprite does not contain draws nothing at all, with no error
// anywhere. Nothing about the page looks broken in a diff -- the icon is
// simply absent. So the reference list and the symbol list have to be checked
// against each other, on every page, rather than trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSprite, referencedSymbols, planSymbols, rewritePage, isConvertible, parseAttributes, SPRITE_VERSION } from "../scripts/build-icon-sprite.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function pages(dir = repoRoot, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === ".wrangler") continue;
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) pages(full, out);
		else if (name === "index.html" || name === "404.html" || name === "_blog-template.html") out.push(full);
	}
	return out;
}

const sprite = readFileSync(path.join(repoRoot, "assets/icons.svg"), "utf8");
const symbols = parseSprite(sprite);
const files = pages();

test("every icon reference on every page resolves to a symbol in the sprite", () => {
	const dangling = [];
	let total = 0;
	for (const file of files) {
		const html = readFileSync(file, "utf8");
		for (const name of referencedSymbols(html)) {
			total++;
			if (!symbols.has(name)) dangling.push(`${path.relative(repoRoot, file)} -> #${name}`);
		}
	}
	assert.ok(total > 40, `expected the sprite to be in use across the site, saw ${total} distinct references`);
	assert.deepEqual(dangling, [], "a reference with no symbol behind it draws nothing, and says nothing");
});

test("the sprite carries no symbol nothing points at", () => {
	// Dead weight in a file every visitor downloads.
	const referenced = new Set();
	for (const file of files) for (const name of referencedSymbols(readFileSync(file, "utf8"))) referenced.add(name);
	assert.deepEqual([...symbols.keys()].filter((name) => !referenced.has(name)), []);
});

test("the sprite is well-formed and uses the XML spelling of viewBox", () => {
	// assets/icons.svg is parsed as XML, not HTML, so `viewbox` would be a
	// different attribute and the symbol would have no coordinate system --
	// every icon scaled to nothing. An HTML parser hands back the lowercase
	// spelling, so this is an easy thing to carry across by accident.
	assert.ok(sprite.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\">"));
	assert.equal(sprite.includes("viewbox="), false, "lowercase viewbox is not the SVG attribute");
	for (const [name, entry] of symbols) {
		assert.match(entry.viewBox, /^[\d.\-\s]+$/, `${name} needs a numeric viewBox`);
		assert.ok(entry.inner.trim().length, `${name} has no geometry`);
	}
	// An XML comment may not contain a double hyphen, which makes the whole
	// file unparseable -- the first version of the generator wrote one.
	const comment = sprite.match(/<!--([\s\S]*?)-->/);
	if (comment) assert.equal(comment[1].includes("--"), false);
});

test("every reference carries the sprite's cache-busting version", () => {
	// /assets/icons.svg is immutable for a year (see _headers). A reference
	// without the version could never be updated for anyone who has already
	// loaded the old sprite.
	for (const file of files) {
		for (const [, href] of readFileSync(file, "utf8").matchAll(/<use href="([^"]+)"/g)) {
			assert.match(href, /^\/assets\/icons\.svg\?v=\d+#/, `${path.relative(repoRoot, file)}: ${href}`);
			assert.equal(href.split("?v=")[1].split("#")[0], String(SPRITE_VERSION));
		}
	}
});

test("no page still carries a dead Tailwind class on an icon", () => {
	// These style nothing -- there is no Tailwind build here -- and were 205
	// KiB of the HTML the site served.
	const dead = /\bclass="[^"]*\b(lucide|size-\d|text-ink-\w+|group-hover:[\w-]+)\b/;
	const offenders = files
		.filter((file) => {
			const html = readFileSync(file, "utf8");
			return [...html.matchAll(/<svg\b[^>]*>/g)].some((match) => dead.test(match[0]));
		})
		.map((file) => path.relative(repoRoot, file));
	assert.deepEqual(offenders, []);
});

test("the generators emit the same markup the pages use", () => {
	// If a generated page carried inline icons, the next build:icons run would
	// find work to do and the two would drift apart.
	for (const name of ["blog-posts.js", "service-pages.js"]) {
		const source = readFileSync(path.join(repoRoot, "src", name), "utf8");
		assert.equal(/class="[^"]*\blucide\b/.test(source), false, `${name} still writes dead classes`);
		assert.ok(source.includes("/assets/icons.svg?v="), `${name} should reference the sprite`);
	}
});

// -- the generator's own logic -----------------------------------------------

test("only the repeated decorative icons are converted", () => {
	const line = parseAttributes(
		'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
	);
	assert.equal(isConvertible(line, "<path d=\"M5 12h14\"></path>"), true);

	// Carries a label rather than aria-hidden: left alone.
	assert.equal(isConvertible(parseAttributes('fill="none" stroke="currentColor"'), "<path/>"), false);
	// Drawn at a different stroke width: keeps its own attributes inline.
	const thin = parseAttributes('aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"');
	assert.equal(isConvertible(thin, "<path/>"), false);
	// Already converted.
	assert.equal(isConvertible(line, '<use href="/assets/icons.svg?v=1#bug"></use>'), false);
});

test("one shape gets one symbol, named for the icon rather than a hash", () => {
	// The bug this pins: the same arrow is written with a lucide- class on
	// some pages and a bare class="icon" on others. Naming each as it was met
	// produced two symbols for one drawing.
	const withName =
		'<svg aria-hidden="true" class="lucide lucide-arrow-right icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewbox="0 0 24 24"><path d="M5 12h14"></path></svg>';
	const without =
		'<svg aria-hidden="true" class="icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewbox="0 0 24 24"><path d="M5 12h14"></path></svg>';

	// Bare one first, so the readable name has to win from a later page.
	const planned = planSymbols([without, withName]);
	assert.equal(planned.size, 1, "one shape, one symbol");
	assert.equal([...planned.values()][0].name, "arrow-right");
});

test("rewriting keeps the attributes that decide how an icon looks", () => {
	// fill and stroke are inherited, and inherit across the <use> boundary --
	// which is what lets `.footer-rating svg { fill: var(--accent) }` still
	// reach the path inside the symbol. Moving them onto the symbol instead
	// would leave the stars black.
	const html =
		'<svg aria-hidden="true" class="lucide lucide-bug size-4 icon icon-accent" fill="none" height="24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewbox="0 0 24 24" width="24"><path d="M12 2v2"></path></svg>';
	const byGeometry = planSymbols([html]);
	const { html: out, rewritten } = rewritePage(html, { defined: new Set(["icon", "icon-accent", "icon-line"]), byGeometry });

	assert.equal(rewritten, 1);
	assert.match(out, /class="icon-line icon icon-accent"/, "defined classes kept, dead ones dropped");
	assert.match(out, /height="24"/);
	assert.match(out, /width="24"/);
	assert.match(out, /viewbox="0 0 24 24"/);
	assert.match(out, /<use href="\/assets\/icons\.svg\?v=\d+#bug"><\/use>/);
	assert.equal(/stroke-width="2"/.test(out), false, "the standard presentation set becomes .icon-line");
});

test("rewriting is idempotent", () => {
	const html =
		'<svg aria-hidden="true" class="icon" fill="none" height="24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewbox="0 0 24 24" width="24"><path d="M12 2v2"></path></svg>';
	const byGeometry = planSymbols([html]);
	const once = rewritePage(html, { defined: new Set(["icon", "icon-line"]), byGeometry });
	const twice = rewritePage(once.html, { defined: new Set(["icon", "icon-line"]), byGeometry });
	assert.equal(twice.html, once.html);
	assert.equal(twice.rewritten, 0, "a converted icon is not converted again");
});
