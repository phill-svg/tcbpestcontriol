// Moving, adding and removing whole blocks in a page's HTML file.
//
// Text edits are an overlay: stored in D1, applied at the edge, addressed by
// hashing the words. That works because a content hash does not care where on
// the page the words sit. Structure is the opposite -- it is *only* position --
// so none of that machinery applies, and these operations write the file in
// the repository instead. The file stays the one description of the page.
//
// Everything here is a byte splice. The document is never parsed into a tree
// and re-serialised: it is scanned for block boundaries, and the bytes between
// those boundaries are moved around. Quote style, attribute order, entity
// spelling, the comment banners between sections and the indentation all
// survive untouched, so a reordered page still reads as the hand-written file
// it is and the diff shows only what moved.
//
// Pure: no Worker APIs, no Node APIs, no I/O. The caller reads the file and
// writes the commit.

import { NODE_PATTERN, RAW_TEXT_ELEMENTS } from "./bake-edits.js";
import { SKIPPED_ELEMENTS, normaliseText, MAX_TEXT_LENGTH, MAX_ATTR_LENGTH, previewableImagePath } from "../assets/js/content-address.js";
import { escapeHtmlText, escapeStyleAttribute, decodeEntities } from "./html-entities.js";

// What counts as a block: the things worth moving, and nothing else. A
// <section> or a <div> is scaffolding -- dragging one would move its children
// with it and the ordinals of everything inside would go with them, which is
// a different feature with a different set of hazards.
const BLOCK_TAGS = new Set(["p", "h2", "h3", "h4", "h5", "h6", "li", "img"]);

// Elements that never close, so an opening tag written without a slash must
// not be counted as opening a depth. `<img src="x">` is the common case here
// and it is also a block, so getting this wrong would swallow the rest of the
// page into the image.
const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// Skipped for the same reason the text walk skips them, and it has to be the
// same set or the two disagree about what is on the page. <title> is dropped
// from it because the text walk handles that one specially and it is outside
// <main> regardless.
//
// <noscript> matters more than it looks: with scripting on -- which is what
// the browser and HTMLRewriter both assume -- its contents are raw text, so
// neither of them sees the analytics <img> inside it. Counting that image
// here would put every later block one ordinal out of step with the browser.
const SKIP_TAGS = new Set([...SKIPPED_ELEMENTS].filter((tag) => tag !== "title"));

// Control characters, minus tab/newline/carriage return -- normaliseText
// collapses those to a space anyway. Same rule content-edits.js applies to
// stored text, so what gets inserted is held to what gets saved.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Where a block may legally sit. An <li> outside a list and a <p> inside one
// are both invalid HTML that a browser will silently reparent, which moves the
// block somewhere the person dragging it did not ask for.
function allowedIn(tag, parentTag) {
	const inList = parentTag === "ul" || parentTag === "ol";
	return tag === "li" ? inList : !inList;
}

// Every block inside `root`, in document order.
//
// Returns { blocks, error }. `error` is set for markup this cannot read --
// an unbalanced tag, a missing close, no <main> at all -- and when it is set
// the caller must refuse the whole operation. Splicing a file the scanner
// does not understand is how a page gets truncated.
export function findBlocks(html, { root = "main" } = {}) {
	const source = String(html || "");
	const blocks = [];
	// Open elements, innermost last. Each is { name, start } for a block, or
	// { name } for anything else -- the stack is what gives a block its parent
	// and what tells us the file is balanced.
	const stack = [];
	let rootDepth = -1;
	let skipDepth = 0;
	let cursor = 0;

	NODE_PATTERN.lastIndex = 0;
	let match;
	while ((match = NODE_PATTERN.exec(source)) !== null) {
		const [full, closing, rawName, , selfClosing] = match;
		cursor = match.index + full.length;

		// Comments and declarations have no capture groups and are never
		// looked inside.
		if (rawName === undefined) continue;
		const name = rawName.toLowerCase();

		if (closing) {
			if (SKIP_TAGS.has(name) && skipDepth > 0) {
				skipDepth--;
				continue;
			}
			if (skipDepth > 0) continue;

			// Pop back to the matching open tag. Unbalanced markup is reported
			// rather than guessed at.
			const open = stack.pop();
			if (!open || open.name !== name) {
				return { blocks: [], error: `Unbalanced markup: </${name}> at ${match.index} does not close <${open ? open.name : "nothing"}>.` };
			}
			if (open.block) {
				open.block.end = match.index + full.length;
				blocks.push(open.block);
			}
			if (stack.length === rootDepth) rootDepth = -1;
			continue;
		}

		if (skipDepth > 0) continue;

		if (SKIP_TAGS.has(name)) {
			if (!selfClosing) skipDepth++;
			// A raw-text element's body can contain anything that looks like a
			// tag, so jump the scanner past it wholesale.
			if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
				const closeAt = source.toLowerCase().indexOf(`</${name}`, cursor);
				if (closeAt !== -1) NODE_PATTERN.lastIndex = closeAt;
			}
			continue;
		}

		const isVoid = selfClosing || VOID_ELEMENTS.has(name);

		if (name === root && rootDepth === -1) {
			rootDepth = stack.length;
			if (!isVoid) stack.push({ name });
			continue;
		}

		// Only blocks inside the root are addressable at all.
		const inRoot = rootDepth !== -1 && stack.length > rootDepth;
		const parentTag = stack.length ? stack[stack.length - 1].name : "";

		if (inRoot && BLOCK_TAGS.has(name)) {
			const block = {
				ordinal: -1, // assigned in document order once the walk finishes
				tag: name,
				start: match.index,
				end: isVoid ? match.index + full.length : -1,
				leadStart: leadStartOf(source, match.index),
				parentTag,
			};
			if (isVoid) blocks.push(block);
			else stack.push({ name, block });
			continue;
		}

		if (!isVoid) stack.push({ name });
	}

	if (stack.length) {
		return { blocks: [], error: `Unbalanced markup: <${stack[stack.length - 1].name}> is never closed.` };
	}
	if (!blocks.length) {
		return { blocks: [], error: `No blocks found inside <${root}>.` };
	}

	// A container block closes after the ones nested inside it, so the push
	// order is close order, not document order. Sort by where each one opens.
	blocks.sort((a, b) => a.start - b.start);
	blocks.forEach((block, index) => {
		block.ordinal = index;
	});
	return { blocks };
}

// The whitespace a block owns: back over spaces and tabs, and over at most one
// newline, and only when nothing but whitespace lies between that newline and
// the tag. A block that sits on its own line therefore takes its line with it
// and leaves none behind; a block written inline between two others takes
// nothing and does not weld itself to its neighbour.
function leadStartOf(source, start) {
	let index = start;
	while (index > 0 && (source[index - 1] === " " || source[index - 1] === "\t")) index--;
	if (index > 0 && source[index - 1] === "\n") index--;
	if (index > 0 && source[index - 1] === "\r") index--;
	return index;
}

// The markup for a block the editor asked to insert.
//
// A payload is a shape, never HTML. Every current safety guarantee in the
// editor rests on stored content being plain text that gets escaped on the way
// out; accepting markup here would hand an admin session a way to put a
// <script> into a page permanently, in the file, where no overlay validation
// would ever look at it again. So the tag is chosen from a fixed set here and
// the text is escaped into it.
export function renderBlock(payload = {}) {
	const type = String(payload.type || "");
	const text = cleanText(payload.text, MAX_TEXT_LENGTH);

	if (type === "paragraph") {
		if (!text) return { error: "A paragraph needs some words." };
		return { html: `<p>${escapeHtmlText(text)}</p>` };
	}

	if (type === "heading") {
		// h1 is excluded deliberately: there is one per page and it is the
		// page's own subject. A second would be an SEO problem the editor
		// itself reports elsewhere.
		const level = Number(payload.level);
		if (level !== 2 && level !== 3) return { error: "A heading has to be level 2 or 3." };
		if (!text) return { error: "A heading needs some words." };
		return { html: `<h${level}>${escapeHtmlText(text)}</h${level}>` };
	}

	if (type === "list-item") {
		if (!text) return { error: "A list item needs some words." };
		return { html: `<li>${escapeHtmlText(text)}</li>` };
	}

	if (type === "image") {
		// The return value, not the input. previewableImagePath rebuilds the
		// path from a known-good shape rather than approving what it was given,
		// which is the same discipline the style allowlist uses.
		const src = previewableImagePath(cleanText(payload.src, MAX_ATTR_LENGTH));
		if (!src) return { error: "That image path is not one this can use." };
		const alt = cleanText(payload.alt, MAX_ATTR_LENGTH);
		// Empty alt is allowed and meaningful -- it marks a decorative image --
		// so it is written rather than omitted.
		return { html: `<img src="${escapeStyleAttribute(src)}" alt="${escapeStyleAttribute(alt)}" loading="lazy">` };
	}

	return { error: `"${type}" is not a kind of block this can add.` };
}

// Control characters stripped, whitespace collapsed, length capped -- the same
// treatment stored text gets in content-edits.js.
function cleanText(value, max) {
	const stripped = String(value == null ? "" : value).replace(CONTROL_CHARS, "");
	return normaliseText(stripped).slice(0, max);
}

// Applies a batch of operations to a document.
//
// All ordinals refer to `html` as given, never to the half-transformed result,
// so a batch is a set of simultaneous statements about one document rather
// than a sequence that has to be read in order.
//
// Returns { html, applied } on success, or { error } -- and on any error
// nothing is applied at all. A partly-reordered page is worse than a
// refusal, because nobody would know which half took.
export function applyStructure(html, ops = [], { root = "main" } = {}) {
	const source = String(html || "");
	const { blocks, error } = findBlocks(source, { root });
	if (error) return { error };
	if (!Array.isArray(ops) || !ops.length) return { error: "Nothing to do." };
	if (ops.length > 50) return { error: "Too many changes at once." };

	// Each op becomes cuts (byte ranges to remove) and pastes (text to insert
	// at an offset). Resolving every op against the original document first is
	// what makes the batch order-independent.
	const cuts = [];
	const pastes = [];

	for (const op of ops) {
		const kind = String(op && op.op);

		if (kind === "insert") {
			const at = resolveAnchor(op.to, blocks);
			if (at.error) return at;
			const rendered = renderBlock(op.block);
			if (rendered.error) return rendered;
			const anchor = blocks[at.ordinal];
			if (!allowedIn(tagOf(op.block), anchor.parentTag)) {
				return { error: `A ${tagOf(op.block)} cannot go inside <${anchor.parentTag}>.` };
			}
			// The new block adopts the indentation of where it lands, not of
			// where it came from.
			pastes.push({ at: at.offset, text: leadOf(source, anchor) + rendered.html });
			continue;
		}

		if (kind === "delete" || kind === "move") {
			const block = blocks[op.block];
			if (!block) return { error: `There is no block ${op.block} on this page.` };
			const mismatch = checkExpect(source, block, op.expect);
			if (mismatch) return mismatch;
			cuts.push({ from: block.leadStart, to: block.end, block });

			if (kind === "move") {
				const at = resolveAnchor(op.to, blocks);
				if (at.error) return at;
				const anchor = blocks[at.ordinal];
				if (anchor.ordinal === block.ordinal) return { error: "That block is already there." };
				if (!allowedIn(block.tag, anchor.parentTag)) {
					return { error: `A <${block.tag}> cannot go inside <${anchor.parentTag}>.` };
				}
				pastes.push({ at: at.offset, text: leadOf(source, anchor) + source.slice(block.start, block.end) });
			}
			continue;
		}

		return { error: `"${kind}" is not something this can do.` };
	}

	const conflict = findConflict(cuts, pastes);
	if (conflict) return { error: conflict };

	return { html: splice(source, cuts, pastes), applied: ops.length };
}

const tagOf = (block) =>
	block && block.type === "heading" ? `h${Number(block.level)}` : block && block.type === "list-item" ? "li" : block && block.type === "image" ? "img" : "p";

// The whitespace an insertion point should carry, copied from the block it is
// landing next to so the new markup lines up with its neighbours.
const leadOf = (source, anchor) => source.slice(anchor.leadStart, anchor.start);

// `{ before: N }` resolves to where block N's own line begins, `{ after: N }`
// to where it ends. The unit a block occupies is [leadStart, end) -- its
// indentation belongs to it and travels with it -- so those are the two edges
// between units, and an insertion at either is a boundary rather than a point
// inside something. That matters for a swap: "put B where A was" resolves to
// exactly the offset where A's cut begins, and a paste on a cut boundary is
// allowed where a paste inside one is refused.
function resolveAnchor(to, blocks) {
	const before = to && to.before;
	const after = to && to.after;
	const ordinal = before !== undefined ? before : after;
	const block = blocks[ordinal];
	if (!block) return { error: `There is no block ${ordinal} to put it next to.` };
	if (before !== undefined && after !== undefined) return { error: "A block goes either before or after, not both." };
	return { ordinal, offset: before !== undefined ? block.leadStart : block.end };
}

// The client says what it believes it is acting on. If the file has moved on
// since the page was loaded -- a deploy landed, somebody else committed -- the
// ordinals it computed describe a document that no longer exists, and the
// first sign of that is the text at the target not being the text it named.
function checkExpect(source, block, expect) {
	if (!expect) return null;
	if (expect.tag && expect.tag !== block.tag) {
		return { error: `Block ${block.ordinal} is a <${block.tag}>, not a <${expect.tag}>. Reload the page and try again.` };
	}
	if (expect.text === undefined) return null;
	const actual = normaliseText(decodeEntities(source.slice(block.start, block.end).replace(/<[^>]*>/g, " ")));
	const wanted = normaliseText(expect.text);
	if (!actual.startsWith(wanted.slice(0, 40))) {
		return { error: `Block ${block.ordinal} does not say what the editor expected. Reload the page and try again.` };
	}
	return null;
}

// Overlapping edits. A cut that swallows another op's target means the two
// ops disagree about what the document is, and applying either would give a
// result nobody asked for.
function findConflict(cuts, pastes) {
	for (let i = 0; i < cuts.length; i++) {
		for (let j = i + 1; j < cuts.length; j++) {
			if (cuts[i].from < cuts[j].to && cuts[j].from < cuts[i].to) {
				return `Blocks ${cuts[i].block.ordinal} and ${cuts[j].block.ordinal} overlap -- one is inside the other.`;
			}
		}
	}
	for (const paste of pastes) {
		for (const cut of cuts) {
			// Landing exactly on a boundary is how a swap works and is fine.
			// Landing strictly inside a range that is being removed is not.
			if (paste.at > cut.from && paste.at < cut.to) {
				return `Block ${cut.block.ordinal} is being removed, so nothing can be put inside it.`;
			}
		}
	}
	return "";
}

// Emit the document with the cuts removed and the pastes inserted.
//
// The one rule that makes swaps work: at a given offset, everything being
// inserted there is emitted before a cut starting there. Swapping A[0,10) and
// B[10,20) is "cut A, paste it at 10" plus "cut B, paste it at 0" -- and at
// offset 0 the pasted B has to come out before A is removed, or the two
// operations cancel.
function splice(source, cuts, pastes) {
	const points = new Set([0, source.length]);
	for (const cut of cuts) {
		points.add(cut.from);
		points.add(cut.to);
	}
	for (const paste of pastes) points.add(paste.at);

	const out = [];
	const ordered = [...points].sort((a, b) => a - b);
	for (let i = 0; i < ordered.length; i++) {
		const at = ordered[i];
		for (const paste of pastes) {
			if (paste.at === at) out.push(paste.text);
		}
		const next = ordered[i + 1];
		if (next === undefined) break;
		const removed = cuts.some((cut) => cut.from <= at && next <= cut.to);
		if (!removed) out.push(source.slice(at, next));
	}
	return out.join("");
}
