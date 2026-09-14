// Moving blocks around inside a page's HTML file.
//
// Every operation here is a byte splice on hand-written markup, which means
// two whole classes of failure that a tree-based editor never has: the scanner
// can misread the file, and the splice can put the bytes back in the wrong
// order. Both produce a page that is subtly wrong rather than an error, and
// both would be committed straight to the repository. So the interesting tests
// are the ones that check the exact bytes, not the shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findBlocks, renderBlock, applyStructure, BLOCK_TAGS, BLOCK_CLASSES, COLUMN_CLASSES } from "../src/page-structure.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A page shaped the way the real ones are: tab-indented, one block per line,
// a comment banner between sections, a list, and an image.
const PAGE = [
	"<body>",
	"<header><p>Chrome, outside main</p></header>",
	"<main>",
	"\t<h2>Ants</h2>",
	"\t<p>First.</p>",
	"\t<p>Second.</p>",
	"\t<!-- a banner comment -->",
	"\t<ul>",
	"\t\t<li>Alpha</li>",
	"\t\t<li>Beta</li>",
	"\t</ul>",
	'\t<img src="/assets/images/x.webp" alt="An ant">',
	"</main>",
	"<footer><p>Also outside</p></footer>",
	"</body>",
].join("\n");

const ordinalsOf = (html) => findBlocks(html).blocks.map((b) => `${b.tag}:${b.parentTag}`);

test("blocks are found in document order, and only inside main", () => {
	const { blocks, error } = findBlocks(PAGE);
	assert.equal(error, undefined);
	// The header and footer paragraphs must not be addressable -- dragging one
	// would rearrange the site chrome on a single page.
	assert.deepEqual(ordinalsOf(PAGE), ["h2:main", "p:main", "p:main", "li:ul", "li:ul", "img:main"]);
	assert.deepEqual(
		blocks.map((b) => b.ordinal),
		[0, 1, 2, 3, 4, 5]
	);
});

test("a block owns the line it sits on, and nothing more", () => {
	const { blocks } = findBlocks(PAGE);
	const second = blocks[2];
	// leadStart reaches back over the newline and the tab, so moving this
	// paragraph leaves no blank line behind and lands indented.
	assert.equal(PAGE.slice(second.leadStart, second.start), "\n\t");
	assert.equal(PAGE.slice(second.start, second.end), "<p>Second.</p>");
});

test("swapping two blocks puts each exactly where the other was", () => {
	// The whole algorithm in one case. A swap is "cut A, paste at B" plus "cut
	// B, paste at A", and at the offset where A starts the pasted B has to be
	// emitted before A is removed -- otherwise the two cancel and both vanish.
	const { html, error } = applyStructure(PAGE, [
		{ op: "move", block: 1, to: { after: 2 } },
		{ op: "move", block: 2, to: { before: 1 } },
	]);
	assert.equal(error, undefined);
	const lines = html.split("\n");
	assert.equal(lines[4], "\t<p>Second.</p>");
	assert.equal(lines[5], "\t<p>First.</p>");
	// Nothing else moved.
	assert.equal(lines[3], "\t<h2>Ants</h2>");
	assert.equal(lines[6], "\t<!-- a banner comment -->");
});

test("rotating three blocks keeps all three", () => {
	// The failure this catches is losing one: with the emit order wrong, a
	// three-way rotation drops whichever block is both cut and pasted at the
	// same offset.
	const { html, error } = applyStructure(PAGE, [
		{ op: "move", block: 3, to: { after: 4 } },
		{ op: "move", block: 4, to: { before: 3 } },
	]);
	assert.equal(error, undefined);
	assert.ok(html.includes("<li>Alpha</li>"));
	assert.ok(html.includes("<li>Beta</li>"));
	assert.ok(html.indexOf("Beta") < html.indexOf("Alpha"));
});

test("everything the operation did not touch is byte-identical", () => {
	// A reordered page still has to read as the hand-written file it is. If a
	// splice reflows anything, every future diff of this file is noise.
	const { html } = applyStructure(PAGE, [{ op: "move", block: 1, to: { after: 2 } }]);
	assert.equal(html.split("\n")[1], "<header><p>Chrome, outside main</p></header>");
	assert.ok(html.includes('<img src="/assets/images/x.webp" alt="An ant">'));
	assert.ok(html.includes("\t<!-- a banner comment -->"));
	// Same bytes in, same bytes out -- only rearranged.
	assert.equal(html.length, PAGE.length);
});

test("a deleted block takes its own line with it", () => {
	const { html, error } = applyStructure(PAGE, [{ op: "delete", block: 1 }]);
	assert.equal(error, undefined);
	assert.ok(!html.includes("First."));
	// No blank line left where it was.
	assert.ok(!html.includes("\n\n"));
	assert.ok(html.includes("\t<h2>Ants</h2>\n\t<p>Second.</p>"));
});

test("an inserted block adopts the indentation of where it lands", () => {
	const { html, error } = applyStructure(PAGE, [
		{ op: "insert", to: { before: 1 }, block: { type: "paragraph", text: "Brand new." } },
	]);
	assert.equal(error, undefined);
	assert.ok(html.includes("\t<h2>Ants</h2>\n\t<p>Brand new.</p>\n\t<p>First.</p>"));
});

test("an inserted list item lands inside the list, indented like its siblings", () => {
	const { html, error } = applyStructure(PAGE, [
		{ op: "insert", to: { after: 4 }, block: { type: "list-item", text: "Gamma" } },
	]);
	assert.equal(error, undefined);
	assert.ok(html.includes("\t\t<li>Beta</li>\n\t\t<li>Gamma</li>"));
});

// --- refusals -------------------------------------------------------------
//
// Every one of these writes a commit to the live site if it gets through, so
// the batch is refused whole rather than applied in part. A half-reordered
// page is worse than no reorder: nobody can tell which half took.

test("a list item cannot be dropped outside a list, or a paragraph inside one", () => {
	assert.match(applyStructure(PAGE, [{ op: "move", block: 3, to: { after: 1 } }]).error, /cannot go inside/);
	assert.match(applyStructure(PAGE, [{ op: "move", block: 1, to: { after: 3 } }]).error, /cannot go inside/);
});

test("an operation naming a block that is not there is refused", () => {
	assert.match(applyStructure(PAGE, [{ op: "delete", block: 99 }]).error, /no block 99/);
	assert.match(applyStructure(PAGE, [{ op: "move", block: 1, to: { after: 99 } }]).error, /no block 99/);
});

test("a stale expectation is refused rather than applied to the wrong block", () => {
	// The client computed its ordinals against the page it loaded. If a deploy
	// landed in between, those ordinals describe a document that no longer
	// exists -- and the first sign of it is the text not matching.
	const stale = applyStructure(PAGE, [
		{ op: "delete", block: 1, expect: { tag: "p", text: "Something else entirely" } },
	]);
	assert.match(stale.error, /does not say what the editor expected/);

	const wrongTag = applyStructure(PAGE, [{ op: "delete", block: 1, expect: { tag: "h2" } }]);
	assert.match(wrongTag.error, /is a <p>, not a <h2>/);

	// The matching case still goes through.
	assert.equal(applyStructure(PAGE, [{ op: "delete", block: 1, expect: { tag: "p", text: "First." } }]).error, undefined);
});

test("an inline tag inside a block does not make the check reject a page that is in sync", () => {
	// The editor sends textContent, where an inline tag was never there. The
	// scanner reads bytes and has to turn that tag into something -- a space,
	// or two words weld together. So <p>"<span>Ainslie reads as `" Ainslie`
	// here and `"Ainslie` in the browser, and a naive comparison tells the
	// person to reload a page that is perfectly fine. One real block on this
	// site hits it: /locations-pest-control-ainslie, block 1.
	const inline = '<body><main>\n\t<p>\u201c<span class="lead">Ainslie is one of the older suburbs.</span></p>\n\t<p>Second.</p>\n</main></body>';
	const fromBrowser = "\u201cAinslie is one of the older suburbs.";

	const { error } = applyStructure(inline, [{ op: "delete", block: 0, expect: { tag: "p", text: fromBrowser } }]);
	assert.equal(error, undefined, "an inline tag must not be read as a difference");

	// Still refuses a block that genuinely says something else.
	const wrong = applyStructure(inline, [{ op: "delete", block: 0, expect: { tag: "p", text: "Something else entirely" } }]);
	assert.match(wrong.error, /does not say what the editor expected/);
});

test("markup the scanner cannot read is refused, not guessed at", () => {
	// Splicing a file this does not understand is how a page gets truncated.
	const unbalanced = "<body><main><p>One</p><div><p>Two</p></main></body>";
	assert.match(findBlocks(unbalanced).error, /Unbalanced markup/);
	assert.match(applyStructure(unbalanced, [{ op: "delete", block: 0 }]).error, /Unbalanced markup/);
});

test("two operations that disagree about the document are refused", () => {
	const nested = "<body><main><ul><li>Outer <p>Inner</p></li></ul></main></body>";
	const { blocks } = findBlocks(nested);
	const li = blocks.find((b) => b.tag === "li");
	const inner = blocks.find((b) => b.tag === "p");
	// The <p> lives inside the <li>. Deleting both is two statements about the
	// same bytes.
	assert.match(
		applyStructure(nested, [{ op: "delete", block: li.ordinal }, { op: "delete", block: inner.ordinal }]).error,
		/overlap/
	);
});

test("an empty or oversized batch does nothing", () => {
	assert.match(applyStructure(PAGE, []).error, /Nothing to do/);
	assert.match(applyStructure(PAGE, new Array(51).fill({ op: "delete", block: 0 })).error, /Too many/);
	assert.match(applyStructure(PAGE, [{ op: "explode", block: 0 }]).error, /not something this can do/);
});

// --- what the scanner has to see the same way the browser does ------------

test("script, style and noscript contents are not blocks", () => {
	// noscript is the one that bites: with scripting on -- which is what the
	// browser and HTMLRewriter both assume -- its contents are raw text, so
	// neither of them sees an <img> in there. Counting it here would put every
	// later block one ordinal out of step with the browser.
	const tricky = [
		"<body><main>",
		'\t<script>var s = "<p>not a block</p>";</script>',
		"\t<style>p { color: red }</style>",
		'\t<noscript><img src="/pixel.webp" alt=""></noscript>',
		"\t<p>The only block.</p>",
		"</main></body>",
	].join("\n");
	assert.deepEqual(ordinalsOf(tricky), ["p:main"]);
});

test("a comment between blocks does not become one, and an attribute containing > survives", () => {
	const tricky = '<body><main><p>A</p><!-- <p>ghost</p> --><p title="a > b">B</p></main></body>';
	assert.deepEqual(ordinalsOf(tricky), ["p:main", "p:main"]);
	const { html } = applyStructure(tricky, [{ op: "delete", block: 0 }]);
	assert.ok(html.includes('<p title="a > b">B</p>'));
	assert.ok(html.includes("<!-- <p>ghost</p> -->"));
});

test("a self-closing image and a bare one are both single blocks", () => {
	const both = '<body><main><img src="/a.webp" alt="a"><p>Between</p><img src="/b.webp" alt="b"/></main></body>';
	assert.deepEqual(ordinalsOf(both), ["img:main", "p:main", "img:main"]);
});

// --- what may be inserted -------------------------------------------------

test("inserted content is built from a shape, never from markup", () => {
	// The one thing that must not be possible: an admin session putting a
	// script into a page permanently, in the file, where no overlay validation
	// will ever look at it again.
	assert.equal(renderBlock({ type: "paragraph", text: "<script>alert(1)</script>" }).html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
	assert.equal(renderBlock({ type: "heading", level: 2, text: "Ants & bees" }).html, "<h2>Ants &amp; bees</h2>");
	assert.equal(renderBlock({ type: "list-item", text: "One" }).html, "<li>One</li>");
});

test("an image can only point at a path this site could serve", () => {
	assert.match(renderBlock({ type: "image", src: "javascript:alert(1)", alt: "" }).error, /not one this can use/);
	assert.match(renderBlock({ type: "image", src: "//evil.example/x.webp", alt: "" }).error, /not one this can use/);
	assert.match(renderBlock({ type: "image", src: "/assets/../../etc/passwd", alt: "" }).error, /not one this can use/);
	// Empty alt is allowed and meaningful -- it marks the image decorative.
	assert.equal(
		renderBlock({ type: "image", src: "/assets/images/x.webp", alt: "" }).html,
		'<img src="/assets/images/x.webp" alt="" loading="lazy">'
	);
});

test("a heading is level 2 or 3, and empty text is not a block", () => {
	// h1 is the page's own subject and there is one per page; a second is an
	// SEO problem the editor reports elsewhere.
	assert.match(renderBlock({ type: "heading", level: 1, text: "No" }).error, /level 2 or 3/);
	assert.match(renderBlock({ type: "heading", level: 7, text: "No" }).error, /level 2 or 3/);
	assert.match(renderBlock({ type: "paragraph", text: "   " }).error, /needs some words/);
	assert.match(renderBlock({ type: "marquee", text: "No" }).error, /not a kind of block/);
});

// --- boxes ----------------------------------------------------------------
//
// A card is the first block recognised by its class rather than its tag, and
// the first that holds other blocks. How wide it is lives on the row it sits
// in, not on the card, which is why widening is a class swap on the parent
// rather than anything written on the box itself.

const CARDS = [
	"<body><main>",
	'\t<div class="grid-cards cols-3">',
	'\t\t<div class="grid-card"><h3 class="display">One</h3><p>First card.</p></div>',
	'\t\t<div class="grid-card"><h3 class="display">Two</h3><p>Second card.</p></div>',
	"\t</div>",
	"\t<p>After the row.</p>",
	"</main></body>",
].join("\n");

test("a card is a block, and so are the heading and text inside it", () => {
	const { blocks, error } = findBlocks(CARDS);
	assert.equal(error, undefined);
	// The card opens before its own children, so it takes the lower number.
	assert.deepEqual(
		blocks.map((b) => `${b.tag}:${b.parentTag}`),
		["div:div", "h3:div", "p:div", "div:div", "h3:div", "p:div", "p:main"]
	);
	// Each card knows the row it is in, which is what a width change acts on.
	assert.deepEqual(blocks[0].parentClasses, ["grid-cards", "cols-3"]);
});

test("widening a row swaps one class and leaves the markup alone", () => {
	const { html, error } = applyStructure(CARDS, [{ op: "columns", block: 0, cols: "cols-2" }]);
	assert.equal(error, undefined);
	assert.ok(html.includes('<div class="grid-cards cols-2">'));
	assert.ok(!html.includes("cols-3"));
	// Same bytes but for the digit -- no reflow, no rewritten quotes.
	assert.equal(html.length, CARDS.length);
});

test("two cards in one row asking for the same width is one change", () => {
	// A row is a single element however many cards point at it. Without this
	// the second card would cut the same bytes the first already cut, and the
	// batch would be refused as overlapping.
	const { html, error } = applyStructure(CARDS, [
		{ op: "columns", block: 0, cols: "cols-4" },
		{ op: "columns", block: 3, cols: "cols-4" },
	]);
	assert.equal(error, undefined);
	assert.equal(html.match(/cols-4/g).length, 1);
});

test("a width only means something inside a row of boxes", () => {
	// Block 6 is the paragraph after the row -- it has no row to widen.
	assert.match(applyStructure(CARDS, [{ op: "columns", block: 6, cols: "cols-2" }]).error, /not in a row of boxes/);
	assert.match(applyStructure(CARDS, [{ op: "columns", block: 0, cols: "cols-9" }]).error, /cols-2, cols-3, cols-4/);
	assert.match(applyStructure(CARDS, [{ op: "columns", block: 0, cols: "grid-cards" }]).error, /cols-2, cols-3, cols-4/);
});

test("a new box is built to match the ones already there", () => {
	// A card that arrived shaped differently would read as a mistake rather
	// than as a new card.
	assert.equal(
		renderBlock({ type: "card", heading: "Redback", text: "Under the outdoor furniture." }).html,
		'<div class="grid-card"><h3 class="display">Redback</h3><p>Under the outdoor furniture.</p></div>'
	);
	assert.match(renderBlock({ type: "card", text: "No heading" }).error, /needs a heading/);
	assert.match(renderBlock({ type: "card", heading: "No words" }).error, /needs some words/);
	// Same escaping as every other block -- markup cannot be smuggled in.
	assert.ok(renderBlock({ type: "card", heading: "<script>x</script>", text: "ok" }).html.includes("&lt;script&gt;"));
});

test("a box can be added beside the ones already in a row", () => {
	const { html, error } = applyStructure(CARDS, [
		{ op: "insert", to: { after: 3 }, block: { type: "card", heading: "Three", text: "Third card." } },
	]);
	assert.equal(error, undefined);
	assert.ok(html.includes('<h3 class="display">Three</h3>'));
	// Indented like its siblings, on its own line.
	assert.ok(html.includes('\n\t\t<div class="grid-card"><h3 class="display">Three</h3>'));
});

test("moving a card takes its heading and text with it", () => {
	// The card's children are blocks in their own right, so this is also the
	// case where a batch could try to act on a block inside a block.
	const { html, error } = applyStructure(CARDS, [{ op: "move", block: 0, to: { after: 3 } }]);
	assert.equal(error, undefined);
	assert.ok(html.indexOf("Second card.") < html.indexOf("First card."));
	assert.ok(html.includes('<div class="grid-card"><h3 class="display">One</h3><p>First card.</p></div>'));

	// And moving a card while also acting on what is inside it is refused.
	assert.match(
		applyStructure(CARDS, [{ op: "move", block: 0, to: { after: 3 } }, { op: "delete", block: 1 }]).error,
		/overlap/
	);
});

test("every width the row control offers is one the stylesheet defines", () => {
	// The control writes these class names into the file. A name the CSS does
	// not define would silently collapse the row to a single column.
	const css = readFileSync(path.join(repoRoot, "assets", "css", "src", "04-page-components.css"), "utf8");
	for (const name of COLUMN_CLASSES) {
		assert.ok(css.includes(`.grid-cards.${name}`), `${name} has no rule in the stylesheet`);
	}
});

// --- beside ---------------------------------------------------------------
//
// Putting something next to a block wraps the two into the two-column row the
// site already uses on 105 pages, side by side from 768px and stacked on a
// phone. The existing block's bytes go into the row untouched.

test("something put beside a paragraph wraps both into a two-column row", () => {
	const { html, error } = applyStructure(PAGE, [
		{ op: "beside", target: 1, block: { type: "image", src: "/assets/images/x.webp", alt: "An ant" } },
	]);
	assert.equal(error, undefined);
	assert.ok(
		html.includes(
			'\t<div class="split-media-grid"><div class="split-media-text"><p>First.</p></div><div class="split-media-image"><img src="/assets/images/x.webp" alt="An ant" loading="lazy"></div></div>\n'
		),
		html
	);
	// Everything around it is where it was.
	assert.ok(html.includes("\t<h2>Ants</h2>\n\t<div class=\"split-media-grid\">"));
	assert.ok(html.includes("</div></div>\n\t<p>Second.</p>"));
});

test("the new block can go on the left instead", () => {
	const { html } = applyStructure(PAGE, [{ op: "beside", target: 1, side: "left", block: { type: "paragraph", text: "Left." } }]);
	assert.ok(html.includes('<div class="split-media-grid"><div class="split-media-text"><p>Left.</p></div><div class="split-media-text"><p>First.</p></div></div>'));
});

test("things that cannot sensibly have something beside them are refused", () => {
	assert.match(applyStructure(PAGE, [{ op: "beside", target: 3, block: { type: "paragraph", text: "x" } }]).error, /list item/);
	const inRow = '<body><main><div class="grid-cards cols-2"><div class="grid-card"><h3>A</h3><p>B</p></div></div></main></body>';
	assert.match(applyStructure(inRow, [{ op: "beside", target: 0, block: { type: "paragraph", text: "x" } }]).error, /already in a row/);
	const split = '<body><main><div class="split-media-grid"><div class="split-media-text"><p>A</p></div><div class="split-media-image"><img src="/assets/images/x.webp" alt=""></div></div></main></body>';
	assert.match(applyStructure(split, [{ op: "beside", target: 0, block: { type: "paragraph", text: "x" } }]).error, /already has something beside it/);
	assert.match(applyStructure(PAGE, [{ op: "beside", target: 1, block: { type: "card", heading: "A", text: "B" } }]).error, /Only a paragraph/);
	assert.match(applyStructure(PAGE, [{ op: "beside", target: 99, block: { type: "paragraph", text: "x" } }]).error, /no block 99/);
});

test("a block being put beside something cannot also be named by another change in the same save", () => {
	// In the editor, "add below" on a wrapped paragraph lands inside its
	// column. In the file, "after the paragraph" is resolved against the page as
	// loaded -- before the wrapper exists -- and would land after the whole row.
	// The preview and the saved page would disagree, so it is refused.
	const beside = { op: "beside", target: 1, block: { type: "paragraph", text: "Beside." } };
	for (const other of [
		{ op: "insert", to: { after: 1 }, block: { type: "paragraph", text: "Below." } },
		{ op: "delete", block: 1 },
		{ op: "move", block: 2, to: { before: 1 } },
	]) {
		assert.match(applyStructure(PAGE, [beside, other]).error, /cannot also be moved or added next to/, JSON.stringify(other));
	}
	// A change to a different block in the same save is fine.
	assert.equal(applyStructure(PAGE, [beside, { op: "delete", block: 2 }]).error, undefined);
});

// --- the real pages -------------------------------------------------------

test("every page in the repository can be read by the scanner", () => {
	// Cheap, no browser, and it catches a file this cannot parse before
	// somebody discovers it by dragging a block on it.
	const skip = new Set(["node_modules", ".git", ".wrangler", ".claude", "test"]);
	const pages = [];
	(function walk(dir) {
		for (const entry of readdirSync(dir)) {
			if (skip.has(entry)) continue;
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry === "index.html") pages.push(full);
		}
	})(repoRoot);

	assert.ok(pages.length > 100, `expected the whole site, found ${pages.length}`);

	// The staff dashboard is the one page with no <main>, and the editor never
	// attaches to it either -- canEdit is gated on !isStaffPage (src/index.js).
	// If that page ever grows a <main>, or any other page loses one, this list
	// changes and somebody gets told.
	const withoutBlocks = [];
	for (const page of pages) {
		const relative = path.relative(repoRoot, page).split(path.sep).join("/");
		const { blocks, error } = findBlocks(readFileSync(page, "utf8"));
		if (error) withoutBlocks.push(`${relative}: ${error}`);
		else if (!blocks.length) withoutBlocks.push(`${relative}: no blocks`);
	}
	assert.deepEqual(withoutBlocks, ["staff-chat/index.html: No blocks found inside <main>."]);
});

test("the editor and the scanner agree on what a block is", () => {
	// The block number is the entire contract between the two: the browser
	// counts blocks in the DOM and sends a number, and the scanner counts
	// blocks in the file and resolves it. If the two lists ever drift, every
	// number past the first difference points at a different element on each
	// side -- and the failure is silent, because both sides are internally
	// consistent. An edit would simply land on the wrong paragraph.
	const editor = readFileSync(path.join(repoRoot, "assets", "js", "editor.js"), "utf8");
	const match = editor.match(/const BLOCK_SELECTOR = "([^"]+)";/);
	assert.ok(match, "editor.js should declare BLOCK_SELECTOR");

	const fromEditor = match[1].split(",").map((part) => part.trim());
	// The selector mixes tags and one class, so the two halves are compared
	// against the two sets they have to match.
	const editorTags = fromEditor.filter((part) => !part.startsWith("."));
	const editorClasses = fromEditor.filter((part) => part.startsWith(".")).map((part) => part.slice(1));
	assert.deepEqual(editorTags.slice().sort(), [...BLOCK_TAGS].sort());
	assert.deepEqual(editorClasses.slice().sort(), [...BLOCK_CLASSES].sort());
});

// The heading-left, paragraph-right row from /bird-control, and a picture row.
const SPLITS =
	'<main><div class="section-head split"><div class="head-title"><div class="section-eyebrow mono">[01]</div><h2 class="section-title display">Birds.</h2></div><div class="head-text"><p>Four species.</p></div></div>' +
	'<div class="split-media-grid"><div class="split-media-text"><p>Same team.</p></div><div class="split-media-image"><img src="/a.webp" alt="x"/></div></div><p>After.</p></main>';

test("lining up a side-by-side row swaps one class on the row", () => {
	// Block 1 is the paragraph in .head-text; its row is two levels up.
	const middle = applyStructure(SPLITS, [{ op: "align", block: 1, align: "middle" }]);
	assert.equal(middle.error, undefined);
	assert.equal(middle.html, SPLITS.replace('"section-head split"', '"section-head split align-middle"'));

	// Changing it again replaces the class rather than adding a second one.
	const bottom = applyStructure(middle.html, [{ op: "align", block: 0, align: "bottom" }]);
	assert.equal(bottom.html, SPLITS.replace('"section-head split"', '"section-head split align-bottom"'));

	// The picture row works from either half.
	const top = applyStructure(SPLITS, [{ op: "align", block: 3, align: "top" }]);
	assert.ok(top.html.includes('<div class="split-media-grid align-top">'));
});

test("a line-up only means something inside a side-by-side row", () => {
	assert.match(applyStructure(SPLITS, [{ op: "align", block: 4, align: "top" }]).error, /not in a side-by-side row/);
	assert.match(applyStructure(SPLITS, [{ op: "align", block: 1, align: "centre" }]).error, /top, middle, bottom/);
	// Deleting the half that collapses the row, and lining the row up, is refused.
	assert.ok(applyStructure(SPLITS, [{ op: "delete", block: 3 }, { op: "align", block: 2, align: "top" }]).error);
});

test("every line-up class has a style behind it", () => {
	const css = readFileSync(path.join(repoRoot, "assets/css/style.min.css"), "utf8");
	for (const name of ["align-top", "align-middle", "align-bottom"]) {
		assert.ok(css.includes(`.split-media-grid.${name}`) && css.includes(`.section-head.split.${name}`), name);
	}
});
