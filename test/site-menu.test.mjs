// The header menu: one definition, written into every page.
//
// This rewrites 139 files in a single commit, so the tests worth having are
// the ones about what it must not touch. A menu that renders correctly but
// eats a page's mobile button, or rewrites every line ending in the file, or
// quietly renumbers the wording overlay, would all look fine in a browser and
// be wrong on the live site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateMenu, renderMenuLines, locateMenus, replaceMenus, navTextCounts, changedNavTexts } from "../src/site-menu.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const flat = (pairs) => ({ items: pairs.map(([label, href]) => ({ label, href, children: [] })) });

// Today's menu, with the absolute links most pages already use.
const SEED = flat([
	["Residential", "/residential"],
	["Commercial", "/commercial"],
	["Pests We Treat", "/pests-we-treat"],
	["Areas We Cover", "/locations"],
	["Blog", "/blog"],
	["Pricing", "/pricing"],
	["Contact", "/contact"],
]);

// A header shaped like the real ones, including a mobile button that is not
// the usual "Get a Quote".
const PAGE = [
	"<header>",
	'<nav class="main-nav">',
	'<a href="/residential">Residential</a>',
	'<a href="/blog">Blog</a>',
	"</nav>",
	'<div class="header-actions"><a class="btn btn-primary" href="/book">Get a Quote</a></div>',
	'<nav class="mobile-nav">',
	'<a href="/residential">Residential</a>',
	'<a href="/blog">Blog</a>',
	'<a href="tel:0261059771">02 6105 9771</a>',
	'<a class="btn btn-primary" href="/book">Book Today</a>',
	"</nav>",
	"</header>",
	"<main><p>Blog posts about pests.</p></main>",
].join("\n");

// --- checking a menu ------------------------------------------------------

test("a menu is refused unless it is the one shape this can render", () => {
	assert.match(validateMenu({}).error, /at least one item/);
	assert.match(validateMenu({ items: [] }).error, /at least one item/);
	assert.match(validateMenu({ items: [{ label: "", href: "/x" }] }).error, /needs a label/);
	assert.match(validateMenu({ items: [{ label: "x".repeat(41), href: "/x" }] }).error, /too long/);
	assert.match(validateMenu({ items: new Array(13).fill({ label: "A", href: "/a" }) }).error, /at most 12/);
	assert.match(validateMenu({ items: [{ label: "A", href: "/a", children: "nope" }] }).error, /not a list/);
});

test("a menu item cannot point anywhere a link should not", () => {
	// This menu is on every page at once, so an unsafe link is unsafe
	// everywhere at once.
	for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.example/", ""]) {
		assert.match(validateMenu(flat([["Bad", href]])).error, /does not point at an address/, href);
	}
	// A phone number and an outside site are both fine to type.
	assert.equal(validateMenu(flat([["Call", "tel:0261059771"]])).error, undefined);
	assert.equal(validateMenu(flat([["Partner", "https://example.com/"]])).error, undefined);
});

test("a dropdown is one level deep", () => {
	// A flyout inside a dropdown is unusable on a phone. It is refused rather
	// than flattened, so what gets saved is what was asked for.
	const nested = {
		items: [{ label: "Pests", href: "/pests-we-treat", children: [{ label: "Ants", href: "/ant-control", children: [{ label: "Too deep", href: "/x" }] }] }],
	};
	assert.match(validateMenu(nested).error, /menu inside a menu/);
});

test("labels are tidied before anything is rendered from them", () => {
	const { menu } = validateMenu({ items: [{ label: "  Pests \n We   Treat ", href: " /pests-we-treat ", children: [] }] });
	assert.deepEqual(menu.items[0], { label: "Pests We Treat", href: "/pests-we-treat", children: [] });
});

// --- rendering ------------------------------------------------------------

test("an item with nothing under it is exactly the link every page has today", () => {
	// This is what makes writing the current menu back a no-op on most pages.
	assert.deepEqual(renderMenuLines(flat([["Blog", "/blog"]])), ['<a href="/blog">Blog</a>']);
});

test("an item with a dropdown keeps its own link and gains a button to open it", () => {
	const lines = renderMenuLines({
		items: [{ label: "Pests We Treat", href: "/pests-we-treat", children: [{ label: "Ant Control", href: "/ant-control" }] }],
	});
	assert.deepEqual(lines, [
		'<div class="nav-item has-menu">',
		'<a href="/pests-we-treat">Pests We Treat</a>',
		'<button aria-expanded="false" aria-label="Show Pests We Treat pages" class="nav-expand" type="button"></button>',
		'<div class="nav-menu">',
		'<a href="/ant-control">Ant Control</a>',
		"</div>",
		"</div>",
	]);
	// The button has no text node, so it adds nothing to the wording overlay's
	// counts -- only the links do.
	assert.ok(!/<button[^>]*>[^<]+<\/button>/.test(lines.join("")));
});

test("labels and addresses are escaped, never inserted as markup", () => {
	const [line] = renderMenuLines(flat([['<script>x</script> & "co"', '/search?a=1&b="2"']]));
	assert.equal(line, '<a href="/search?a=1&amp;b=&quot;2&quot;">&lt;script&gt;x&lt;/script&gt; &amp; &quot;co&quot;</a>');
});

// --- writing it into a page ----------------------------------------------

test("the mobile menu's phone link and button are left exactly as the page had them", () => {
	// /ant-control's mobile button says "Book Today" and
	// /servicem8-setup-training's points at /contact. Rebuilding the whole
	// <nav> would put both back to "Get a Quote" without anyone noticing.
	const { html, error } = replaceMenus(PAGE, SEED);
	assert.equal(error, undefined);
	assert.ok(html.includes('<a href="tel:0261059771">02 6105 9771</a>\n<a class="btn btn-primary" href="/book">Book Today</a>\n</nav>'));
	// And the desktop-only button outside both menus is untouched too.
	assert.ok(html.includes('<div class="header-actions"><a class="btn btn-primary" href="/book">Get a Quote</a></div>'));
	assert.ok(html.endsWith("<main><p>Blog posts about pests.</p></main>"));
});

test("both menus get the new links, in the same order", () => {
	const { html } = replaceMenus(PAGE, SEED);
	const where = locateMenus(html);
	const main = html.slice(where.main.innerStart, where.main.linksEnd);
	const mobile = html.slice(where.mobile.innerStart, where.mobile.linksEnd);
	assert.equal(main, mobile);
	assert.equal((main.match(/<a /g) || []).length, 7);
});

test("a page keeps its own line endings", () => {
	// The working copy is CRLF on Windows. Writing LF into it would show every
	// line of the header as changed.
	const crlf = PAGE.replace(/\n/g, "\r\n");
	const { html } = replaceMenus(crlf, SEED);
	assert.ok(!/[^\r]\n/.test(html), "a bare LF was written into a CRLF file");
});

test("writing the same menu twice changes nothing the second time", () => {
	const once = replaceMenus(PAGE, SEED).html;
	assert.equal(replaceMenus(once, SEED).html, once);
});

test("a comment or an attribute mentioning </nav> does not end a menu early", () => {
	const tricky = PAGE.replace(
		'<nav class="main-nav">',
		'<nav class="main-nav" data-note="closes at </nav>">\n<!-- old: </nav> -->'
	);
	const { html, error } = replaceMenus(tricky, SEED);
	assert.equal(error, undefined);
	assert.ok(html.includes('<nav class="main-nav" data-note="closes at </nav>">'));
	assert.ok(html.includes('<a class="btn btn-primary" href="/book">Book Today</a>'));
});

test("a page whose menus are not the expected shape is refused, not guessed at", () => {
	assert.match(replaceMenus("<header></header><main></main>", SEED).error, /no desktop menu/);
	assert.match(replaceMenus(PAGE.replace('<nav class="mobile-nav">', "<nav>"), SEED).error, /no mobile menu/);
	// Without the phone link there is no telling where the menu links stop, and
	// guessing is how a page loses its button.
	assert.match(replaceMenus(PAGE.replace("tel:0261059771", "/call"), SEED).error, /no phone link/);
});

// --- what the wording overlay would see -----------------------------------

test("the texts that a menu change renumbers are exactly the ones whose count changed", () => {
	// An override on identical text further down a page is numbered by how many
	// copies of that text come before it. Adding "Blog posts" to the menu adds
	// two copies (desktop and mobile) ahead of the one in <main>.
	const before = replaceMenus(PAGE, SEED).html;
	const added = replaceMenus(before, {
		items: [...SEED.items, { label: "Blog posts about pests.", href: "/blog", children: [] }],
	}).html;
	assert.deepEqual(changedNavTexts(before, added).changed, ["Blog posts about pests."]);

	// Reordering moves no text past any other copy of itself, so nothing is
	// renumbered and nothing should be reported.
	const reordered = replaceMenus(before, { items: [...SEED.items].reverse() }).html;
	assert.deepEqual(changedNavTexts(before, reordered).changed, []);

	// Renaming takes one text away and adds another.
	const renamed = replaceMenus(before, { items: SEED.items.map((item) => (item.label === "Blog" ? { ...item, label: "News" } : item)) }).html;
	assert.deepEqual(changedNavTexts(before, renamed).changed.sort(), ["Blog", "News"]);
});

test("the counts include the mobile copy, and ignore the phone link and button", () => {
	const { counts } = navTextCounts(replaceMenus(PAGE, SEED).html);
	assert.equal(counts.get("Residential"), 2);
	assert.equal(counts.get("02 6105 9771"), undefined);
	assert.equal(counts.get("Book Today"), undefined);
});

// --- every real page ------------------------------------------------------

function htmlFilesWithMenus() {
	const skip = new Set(["node_modules", ".git", ".wrangler", ".claude", "test"]);
	const files = [];
	(function walk(dir) {
		for (const entry of readdirSync(dir)) {
			if (skip.has(entry)) continue;
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith(".html")) files.push(full);
		}
	})(repoRoot);
	return files.filter((file) => readFileSync(file, "utf8").includes('class="main-nav"'));
}

test("every page with a menu, and both templates, can have it rewritten", () => {
	// Pages, 404.html and the two templates new pages are made from. If any of
	// them cannot be read, a site-wide save would refuse -- better to find out
	// here than from the editor.
	const files = htmlFilesWithMenus();
	assert.ok(files.length >= 139, `expected every page, found ${files.length}`);
	for (const template of ["_blog-template.html", "_service-template.html", "404.html"]) {
		assert.ok(files.some((file) => file.endsWith(template)), `${template} should carry the menu`);
	}

	const problems = [];
	for (const file of files) {
		const html = readFileSync(file, "utf8");
		const once = replaceMenus(html, SEED);
		if (once.error) problems.push(`${path.relative(repoRoot, file)}: ${once.error}`);
		else if (replaceMenus(once.html, SEED).html !== once.html) problems.push(`${path.relative(repoRoot, file)}: not idempotent`);
	}
	assert.deepEqual(problems, []);
});

test("every page's menu is exactly what assets/menu.json renders", () => {
	// The drift this whole module exists to stop. Before it, the menu had been
	// copied into 139 files by hand and had quietly become four different menus.
	// A page edited by hand now fails here instead -- run `npm run build:menu`
	// to put it back.
	const { menu, error } = validateMenu(JSON.parse(readFileSync(path.join(repoRoot, "assets", "menu.json"), "utf8")));
	assert.equal(error, undefined, "assets/menu.json must itself be a valid menu");

	const drifted = [];
	for (const file of htmlFilesWithMenus()) {
		const html = readFileSync(file, "utf8");
		if (replaceMenus(html, menu).html !== html) drifted.push(path.relative(repoRoot, file));
	}
	assert.deepEqual(drifted, [], "these pages' menus differ from assets/menu.json -- run npm run build:menu");
});

test("every page carries the dropdown rules in its critical CSS", () => {
	// The header is above the fold, so its CSS is inlined into each page and
	// the full stylesheet loads later. A page whose inline copy lacked
	// .nav-menu{display:none} would paint every dropdown's links expanded
	// until the stylesheet arrived.
	const blocks = new Set();
	for (const file of htmlFilesWithMenus()) {
		const inline = (readFileSync(file, "utf8").match(/<style>(@font-face[\s\S]*?)<\/style>/) || [])[1] || "";
		assert.ok(inline.includes(".nav-menu{display:none"), `${path.relative(repoRoot, file)} has no inline rule hiding dropdowns`);
		blocks.add(inline);
	}
	// And it is one block, not a slowly diverging copy per page.
	assert.equal(blocks.size, 1, "the inline critical CSS differs between pages");
});

test("writing today's menu back only changes the pages whose links were relative", () => {
	// Pages that already use absolute links come back byte-identical, which is
	// the proof that the rest of the header survives untouched. The ones that
	// change are the ../residential and residential copies, and the only lines
	// that change in them are the menu links.
	for (const file of htmlFilesWithMenus()) {
		const html = readFileSync(file, "utf8");
		const { html: rewritten } = replaceMenus(html, SEED);
		const before = html.split("\n");
		const after = rewritten.split("\n");
		assert.equal(after.length, before.length, `${file}: line count changed`);
		for (let i = 0; i < before.length; i++) {
			if (before[i] === after[i]) continue;
			assert.match(before[i], /^<a href="(\.\.\/)*[a-z-]+">[^<]+<\/a>\r?$/, `${file}: an unexpected line changed: ${before[i]}`);
		}
	}
});
