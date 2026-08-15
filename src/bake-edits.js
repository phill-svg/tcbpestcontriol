// Writing published edits back into the HTML files.
//
// The live site applies edits as an overlay at the edge, which is what makes
// publishing instant. But the repository has to stay the real source of
// truth, or the next person to open spider-control/index.html would be
// reading copy the website stopped using months ago.
//
// So this walks a page's HTML exactly the way the Worker's rewriter walks it
// -- same skipped elements, same entity decoding, same content hash, same
// ordinals -- and substitutes the published values in place. Sharing the
// addressing module with the Worker is what guarantees the two agree; if
// they ever drifted, this would quietly edit the wrong sentence.
//
// Anything that doesn't match is reported rather than guessed at. A
// mismatch means the file has been edited by hand since the change was
// published, and a human should look at it.

import { normaliseText, hashValue, SKIPPED_ELEMENTS, EDITABLE_ATTRS, META_TITLE_ADDRESS, META_DESCRIPTION_ADDRESS } from "../assets/js/content-address.js";
import { decodeEntities, escapeHtmlText } from "./html-entities.js";

// Elements whose content is raw text, not markup. A `<` inside a script is
// just a less-than sign, so scanning for the next tag would go badly wrong --
// these are jumped over wholesale instead.
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

// Comments and declarations (`<!doctype html>`) are matched as nodes in their
// own right, ahead of the tag alternative. That is not a detail: a real
// parser makes both of them *boundaries* between text nodes, so
// `<p>Hello <!-- note --> world</p>` is two text nodes, not one. Treating a
// comment as ordinary text instead would give the run a content hash the
// browser and the Worker never produce, and -- worse -- a commented-out block
// of old markup would take an ordinal away from the live copy below it.
//
// The attribute-text alternatives are deliberately disjoint: `[^"'>]` excludes
// both quote characters, so a `"` can only ever be consumed by the
// `"[^"]*"` branch. An earlier version used `[^>]` there, which meant a run of
// quotes could be partitioned between the two branches in exponentially many
// ways -- `<A` followed by 40 quote characters took 3.6 seconds to reject, and
// each extra quote doubled it. CodeQL was right to flag it.
//
// The trade-off is that a tag containing an *unmatched* quote no longer
// matches at all. That is the safe failure: the scanner leaves it as text and
// applies no edit there, rather than mis-parsing it.
const NODE_PATTERN = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;

// Splits a tag's attribute text into name/value pairs, keeping the exact
// source offsets so a value can be replaced without disturbing anything else
// about how the tag was written (quote style, attribute order, spacing).
function readAttributes(attrText) {
	const found = [];
	const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
	let match;
	while ((match = pattern.exec(attrText)) !== null) {
		const quoted = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5];
		found.push({
			name: match[1].toLowerCase(),
			value: quoted,
			// Offsets of the whole `name="value"` run within attrText, so it can
			// be swapped out without disturbing the rest of the tag.
			matchStart: match.index,
			matchEnd: match.index + match[0].length,
		});
	}
	return found;
}

// Rewrites one HTML document.
//
// `edits` is a Map of address -> new value. Returns the new HTML plus the
// addresses that were actually applied and the ones that could not be found,
// so the caller can report honestly rather than claiming a clean sweep.
export function bakeEdits(html, edits) {
	const applied = new Set();
	const ordinals = new Map();
	const nextOrdinal = (key) => {
		const seen = ordinals.get(key) || 0;
		ordinals.set(key, seen + 1);
		return seen;
	};

	const out = [];
	let cursor = 0;
	let skipDepth = 0;
	let inTitle = false;

	NODE_PATTERN.lastIndex = 0;
	let match;
	while ((match = NODE_PATTERN.exec(html)) !== null) {
		const [full, closing, rawName, attrText, selfClosing] = match;

		// --- the text run that sat before this node --------------------------
		const text = html.slice(cursor, match.index);
		if (text) {
			if (skipDepth > 0) {
				out.push(text);
			} else if (inTitle) {
				const replacement = edits.get(META_TITLE_ADDRESS);
				if (replacement === undefined) {
					out.push(text);
				} else {
					out.push(escapeHtmlText(replacement));
					applied.add(META_TITLE_ADDRESS);
				}
			} else {
				out.push(rewriteTextRun(text, edits, nextOrdinal, applied));
			}
		}
		cursor = match.index + full.length;

		// A comment or a declaration is emitted exactly as written and never
		// looked inside. `rawName` is undefined for those, since only the tag
		// alternative of the pattern has capture groups.
		if (rawName === undefined) {
			out.push(full);
			continue;
		}
		const name = rawName.toLowerCase();

		// --- the tag itself ---------------------------------------------------
		if (closing) {
			if (SKIPPED_ELEMENTS.has(name) && skipDepth > 0) skipDepth--;
			if (name === "title") inTitle = false;
			out.push(full);
			continue;
		}

		// Attributes inside a skipped element are skipped too. The case that
		// forced this is the analytics pixel inside <noscript>: with scripting
		// enabled -- which is what both the browser and HTMLRewriter assume --
		// the contents of <noscript> are raw text, so neither of them sees an
		// <img> there at all. Rewriting one here would have handed that pixel an
		// address the other two never issue.
		let tagText = full;
		if (skipDepth === 0 && (EDITABLE_ATTRS[name] || name === "meta")) {
			tagText = rewriteTag(full, name, attrText, edits, nextOrdinal, applied);
		}
		out.push(tagText);

		// A void or self-closing element never opens a region to skip.
		if (!selfClosing && SKIPPED_ELEMENTS.has(name)) {
			if (name === "title") {
				inTitle = true;
			} else {
				skipDepth++;
			}
		}

		// Raw-text elements are jumped over in one go, because their contents
		// can contain characters that look like markup but aren't.
		if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
			const closeTag = `</${name}`;
			const closeAt = html.toLowerCase().indexOf(closeTag, cursor);
			if (closeAt !== -1) {
				out.push(html.slice(cursor, closeAt));
				cursor = closeAt;
				NODE_PATTERN.lastIndex = closeAt;
			}
		}
	}

	// Whatever trails the final tag.
	const tail = html.slice(cursor);
	if (tail) out.push(skipDepth > 0 ? tail : rewriteTextRun(tail, edits, nextOrdinal, applied));

	const missing = [...edits.keys()].filter((address) => !applied.has(address));
	return { html: out.join(""), applied: [...applied], missing };
}

function rewriteTextRun(raw, edits, nextOrdinal, applied) {
	const normalised = normaliseText(decodeEntities(raw));
	if (!normalised) return raw;

	const address = `t:${hashValue(normalised)}:${nextOrdinal(`t|${normalised}`)}`;
	const replacement = edits.get(address);
	if (replacement === undefined) return raw;

	// Keep the original indentation, exactly as the Worker does, so the diff
	// shows a wording change and not a reflow of the whole file.
	const leading = raw.match(/^\s*/)[0];
	const trailing = raw.match(/\s*$/)[0];
	applied.add(address);
	return `${leading}${escapeHtmlText(replacement)}${trailing}`;
}

function rewriteTag(full, name, attrText, edits, nextOrdinal, applied) {
	const attributes = readAttributes(attrText);

	// <meta name="description"> and the social variants are addressed by name
	// rather than by content -- see content-address.js.
	if (name === "meta") {
		const nameAttr = attributes.find((attr) => attr.name === "name");
		const propertyAttr = attributes.find((attr) => attr.name === "property");
		const key = (nameAttr && nameAttr.value) || (propertyAttr && propertyAttr.value) || "";
		const isDescription = ["description", "og:description", "twitter:description"].includes(key);
		const isTitle = ["og:title", "twitter:title"].includes(key);
		const address = isDescription ? META_DESCRIPTION_ADDRESS : isTitle ? META_TITLE_ADDRESS : null;
		if (!address) return full;
		const replacement = edits.get(address);
		if (replacement === undefined) return full;
		const content = attributes.find((attr) => attr.name === "content");
		if (!content) return full;
		applied.add(address);
		return replaceAttrValue(full, attrText, content, replacement);
	}

	let result = full;
	let workingAttrText = attrText;
	for (const attr of EDITABLE_ATTRS[name] || []) {
		// Re-read each time: replacing one value shifts the offsets of the
		// attributes that follow it.
		const current = readAttributes(workingAttrText).find((candidate) => candidate.name === attr);
		if (!current) continue;
		const normalised = normaliseText(decodeEntities(current.value));
		const address = `a:${name}:${attr}:${hashValue(normalised)}:${nextOrdinal(`${name}|${attr}|${normalised}`)}`;
		const replacement = edits.get(address);
		if (replacement === undefined) continue;
		const updated = replaceAttrValue(result, workingAttrText, current, replacement);
		// Keep the attribute text in step with the tag text so the next
		// attribute's offsets are still meaningful.
		workingAttrText = workingAttrText.slice(0, current.matchStart) + `${attr}="${escapeAttr(replacement)}"` + workingAttrText.slice(current.matchEnd);
		result = updated;
		applied.add(address);
	}
	return result;
}

function escapeAttr(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Rewrites just the one attribute inside the tag's source text, leaving the
// rest of the tag byte-for-byte alone.
function replaceAttrValue(tagText, attrText, attr, value) {
	const attrStart = tagText.indexOf(attrText);
	if (attrStart === -1) return tagText;
	const from = attrStart + attr.matchStart;
	const to = attrStart + attr.matchEnd;
	return `${tagText.slice(0, from)}${attr.name}="${escapeAttr(value)}"${tagText.slice(to)}`;
}

// "/spider-control" -> "spider-control/index.html", "/" -> "index.html".
// Mirrors fetchAsset() in src/index.js, which serves a directory path by
// looking for index.html inside it.
export function pathToFile(pagePath) {
	const clean = String(pagePath || "/").replace(/^\/+|\/+$/g, "");
	return clean ? `${clean}/index.html` : "index.html";
}
