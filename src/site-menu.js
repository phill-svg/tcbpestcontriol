// The header menu, as one definition written into every page.
//
// Every page file carries its own copy of the menu -- a <nav class="main-nav">
// for desktop and a <nav class="mobile-nav"> for phones -- because the site is
// static HTML with no shared include. Kept in step by hand, the copies had
// already drifted into four desktop and six mobile variants before this
// existed. So the menu is described once, in assets/menu.json, and this module
// renders it and splices it into each file.
//
// Two things about the splice are easy to get wrong.
//
// The mobile menu is not only the menu. After the links it carries a phone link
// and a button, and that button is not the same on every page: /ant-control
// says "Book Today", /servicem8-setup-training points at /contact. Rebuilding
// the whole <nav> would silently revert both, so only the links before the
// phone link are replaced and everything from the phone link on is kept exactly
// as each page wrote it.
//
// And menu text is addressed by the wording overlay. A label is a text node
// like any other, and an override on identical text further down a page is
// numbered by how many copies of that text come before it -- including the
// copies in the menu. navTextCounts() exists so the caller can tell when a
// menu change would renumber those.
//
// Pure: no Worker APIs, no Node APIs, no I/O.

import { NODE_PATTERN, readAttributes } from "./bake-edits.js";
import { normaliseText, isSafeHref, MAX_ATTR_LENGTH } from "../assets/js/content-address.js";
import { escapeHtmlText, escapeStyleAttribute, decodeEntities } from "./html-entities.js";

// Generous for a header, and small enough that a runaway paste cannot write a
// menu nobody could use.
const MAX_ITEMS = 12;
const MAX_CHILDREN = 20;
const MAX_LABEL = 40;

const NAV_CLASSES = ["main-nav", "mobile-nav"];

// Checks a menu before anything is rendered from it.
//
// Returns { menu } with every value trimmed, or { error }. The shape is fixed:
// a list of items, each with an optional list of children one level deep. A
// flyout inside a dropdown is unusable on a phone and nothing on this site
// needs one, so a child with children of its own is refused rather than
// silently flattened.
export function validateMenu(input) {
	const items = input && Array.isArray(input.items) ? input.items : null;
	if (!items || !items.length) return { error: "The menu needs at least one item." };
	if (items.length > MAX_ITEMS) return { error: `A menu can have at most ${MAX_ITEMS} items across the top.` };

	const clean = [];
	for (const item of items) {
		const top = cleanLink(item);
		if (top.error) return top;
		const children = item && item.children == null ? [] : item && item.children;
		if (!Array.isArray(children)) return { error: `"${top.label}" has children that are not a list.` };
		if (children.length > MAX_CHILDREN) return { error: `"${top.label}" can have at most ${MAX_CHILDREN} items under it.` };

		const cleanChildren = [];
		for (const child of children) {
			if (child && Array.isArray(child.children) && child.children.length) {
				return { error: `"${top.label}" has a menu inside a menu. Only one level of dropdown is possible.` };
			}
			const link = cleanLink(child);
			if (link.error) return link;
			cleanChildren.push(link);
		}
		clean.push({ ...top, children: cleanChildren });
	}
	return { menu: { items: clean } };
}

function cleanLink(value) {
	const label = normaliseText(value && value.label);
	const href = String((value && value.href) || "").trim();
	if (!label) return { error: "Every menu item needs a label." };
	if (label.length > MAX_LABEL) return { error: `"${label.slice(0, 20)}…" is too long for a menu label.` };
	if (href.length > MAX_ATTR_LENGTH || !isSafeHref(href)) return { error: `"${label}" does not point at an address the site can link to.` };
	return { label, href };
}

// The menu links, one per line, exactly as the pages already lay them out.
//
// An item with nothing under it is a bare <a>, byte-for-byte what every page
// has today -- so writing the current menu back into a page that already uses
// absolute links changes nothing at all. An item with children keeps its own
// link (the words still go to the page) and gains a button that opens the
// list; the button has no text, so it adds nothing for the overlay to count.
//
// Built from the shape, never from supplied markup: labels are escaped into
// text and hrefs into attributes, the same discipline renderBlock follows.
export function renderMenuLines(menu) {
	const lines = [];
	for (const item of menu.items) {
		const link = linkLine(item);
		if (!item.children || !item.children.length) {
			lines.push(link);
			continue;
		}
		lines.push('<div class="nav-item has-menu">');
		lines.push(link);
		lines.push(
			`<button aria-expanded="false" aria-label="Show ${escapeStyleAttribute(item.label)} pages" class="nav-expand" type="button"></button>`
		);
		lines.push('<div class="nav-menu">');
		for (const child of item.children) lines.push(linkLine(child));
		lines.push("</div>");
		lines.push("</div>");
	}
	return lines;
}

const linkLine = (link) => `<a href="${escapeStyleAttribute(link.href)}">${escapeHtmlText(link.label)}</a>`;

// Where each of the two menus sits in a page.
//
// Returns { main, mobile } -- each { innerStart, innerEnd, linksEnd } -- or
// { error }. `linksEnd` is where the menu links stop: the end of the inner
// markup for the desktop menu, and the start of the phone link's line for the
// mobile one. Found with the same node scanner the rest of the editor uses
// rather than a regex over raw HTML, so a comment or an attribute containing
// "</nav>" cannot end a menu early.
export function locateMenus(html) {
	const source = String(html || "");
	const found = {};
	const stack = [];

	NODE_PATTERN.lastIndex = 0;
	let match;
	while ((match = NODE_PATTERN.exec(source)) !== null) {
		const [full, closing, rawName, attrText, selfClosing] = match;
		if (rawName === undefined) continue;
		const name = rawName.toLowerCase();

		if (name !== "nav") continue;
		if (closing) {
			const open = stack.pop();
			if (open && open.which && !found[open.which]) {
				found[open.which] = { innerStart: open.innerStart, innerEnd: match.index };
			}
			continue;
		}
		if (selfClosing) continue;
		const classAttr = readAttributes(attrText).find((attr) => attr.name === "class");
		const classes = classAttr ? classAttr.value.split(/\s+/) : [];
		const which = NAV_CLASSES.find((value) => classes.includes(value)) || null;
		stack.push({ which: which === "main-nav" ? "main" : which === "mobile-nav" ? "mobile" : null, innerStart: match.index + full.length });
	}

	if (!found.main) return { error: "This page has no desktop menu (<nav class=\"main-nav\">) to replace." };
	if (!found.mobile) return { error: "This page has no mobile menu (<nav class=\"mobile-nav\">) to replace." };

	found.main.linksEnd = found.main.innerEnd;

	// The phone link is the first thing after the menu links on every page. If
	// it is not there, the mobile menu is not shaped the way this assumes, and
	// guessing where the links stop is how a page loses its button.
	const inner = source.slice(found.mobile.innerStart, found.mobile.innerEnd);
	const tel = inner.search(/<a\b[^>]*\bhref\s*=\s*["']tel:/i);
	if (tel === -1) return { error: "This page's mobile menu has no phone link, so where its menu links end cannot be found." };
	// Back to the start of that line, so the phone link keeps its own line.
	const lineStart = inner.lastIndexOf("\n", tel) + 1;
	found.mobile.linksEnd = found.mobile.innerStart + lineStart;

	return found;
}

// Writes a menu into one page. Returns { html } or { error }.
//
// Everything outside the two sets of menu links is left exactly as the page had
// it, including the line endings: a page checked out with CRLF gets CRLF back.
export function replaceMenus(html, menu) {
	const source = String(html || "");
	const where = locateMenus(source);
	if (where.error) return where;

	const eol = source.slice(where.main.innerStart, where.main.innerEnd).includes("\r\n") ? "\r\n" : "\n";
	const block = eol + renderMenuLines(menu).join(eol) + eol;

	// Later offset first, so splicing the mobile menu does not move the desktop
	// menu's offsets out from under it.
	const spans = [
		{ from: where.main.innerStart, to: where.main.linksEnd },
		{ from: where.mobile.innerStart, to: where.mobile.linksEnd },
	].sort((a, b) => b.from - a.from);

	let result = source;
	for (const span of spans) result = result.slice(0, span.from) + block + result.slice(span.to);
	return { html: result };
}

// How many times each piece of text appears in the menu links of a page.
//
// The wording overlay numbers identical text by how many copies come before it,
// so adding, removing or renaming a menu item renumbers every copy of that text
// further down the page. Comparing these counts before and after a change is
// how the caller finds out which texts moved, without needing the rest of the
// page at all.
export function navTextCounts(html) {
	const source = String(html || "");
	const where = locateMenus(source);
	if (where.error) return where;

	const counts = new Map();
	// Link addresses are overlay-addressable too, by the same hash-and-count
	// scheme, so an href override further down the page is renumbered the same
	// way a text override is.
	const hrefs = new Map();
	for (const span of [where.main, where.mobile]) {
		const links = source.slice(span.innerStart, span.linksEnd);
		for (const [, attrText, text] of links.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
			const normalised = normaliseText(decodeEntities(text.replace(/<[^>]*>/g, " ")));
			if (normalised) counts.set(normalised, (counts.get(normalised) || 0) + 1);
			const href = readAttributes(attrText).find((attr) => attr.name === "href");
			const address = href ? normaliseText(decodeEntities(href.value)) : "";
			if (address) hrefs.set(address, (hrefs.get(address) || 0) + 1);
		}
	}
	return { counts, hrefs };
}

// Texts whose count in the menu differs between two pages' worth of markup.
export function changedNavTexts(before, after) {
	const a = navTextCounts(before);
	const b = navTextCounts(after);
	if (a.error) return a;
	if (b.error) return b;
	const differ = (x, y) => [...new Set([...x.keys(), ...y.keys()])].filter((key) => (x.get(key) || 0) !== (y.get(key) || 0));
	return { changed: differ(a.counts, b.counts), changedHrefs: differ(a.hrefs, b.hrefs) };
}
