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

import { findBlocks, renderBlock, applyStructure, BLOCK_TAGS } from "../src/page-structure.js";

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

	const fromEditor = match[1].split(",").map((tag) => tag.trim());
	assert.deepEqual(fromEditor.slice().sort(), [...BLOCK_TAGS].sort());
});
