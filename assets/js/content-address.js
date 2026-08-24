// How the visual editor names a piece of content.
//
// The site is ~200 hand-written HTML files with no ids on most elements, so
// an edit can't be stored as "element #47" -- adding a paragraph above it
// would silently repoint the edit at the wrong words. Instead an edit is
// addressed by *what it currently says*: a hash of the normalised text (or
// attribute value), plus an ordinal that only counts other occurrences of
// that same value on the same page.
//
// The nice property of hashing the content itself is that unrelated edits
// elsewhere on the page can never shift an address. The ordinal only moves
// if you duplicate or delete one of the identical copies, and even then the
// stored `original` lets us detect the mismatch and skip rather than
// corrupt the page.
//
// This module is the single source of truth for that addressing, shared by
// all three places that need to agree on it:
//   - assets/js/editor.js   (browser -- creates addresses when you click)
//   - src/content-edits.js  (Worker -- matches addresses while streaming HTML)
//   - scripts/sync-content-edits.js (Node -- bakes edits into the HTML files)
// If they ever disagree, edits silently stop applying, so they all import
// this one file rather than each carrying their own copy.

// Collapse all runs of whitespace and trim. HTML authors indent freely and
// the browser renders "Hello\n   world" the same as "Hello world", so the
// address has to ignore that difference or an edit made in the browser would
// never match the source file.
export function normaliseText(value) {
	return String(value == null ? "" : value)
		.replace(/\s+/g, " ")
		.trim();
}

// FNV-1a, run twice with different offset bases and concatenated, giving a
// 64-bit-equivalent address in 13 base36 characters. Plain FNV-1a is 32-bit,
// and on a page with a few hundred text nodes the birthday odds of a 32-bit
// collision are around 1-in-30,000 -- low, but this runs across 200 pages
// forever, so the second pass buys a lot of headroom for very little work.
//
// Hashing UTF-8 bytes rather than UTF-16 code units keeps the result
// identical across the Worker, the browser and Node.
export function hashValue(value) {
	const bytes = new TextEncoder().encode(value);
	return fnv1a(bytes, 0x811c9dc5) + fnv1a(bytes, 0x01000193);
}

function fnv1a(bytes, offsetBasis) {
	let hash = offsetBasis;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		// Multiply by the FNV prime (16777619) in 32-bit space. Math.imul
		// keeps this exact -- a plain `*` would lose precision past 2^53.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0");
}

// A run of text between two tags, e.g. the "Fast, friendly pest control"
// inside an <h1>. `ordinal` is the 0-based index among text nodes on the
// page whose normalised value is byte-identical to this one.
export function textAddress(text, ordinal) {
	return `t:${hashValue(normaliseText(text))}:${ordinal}`;
}

// An attribute value, e.g. an <a href> or an <img src>. Tag and attribute
// are part of the address so an href and a src that happen to hold the same
// string can never be confused for one another.
export function attrAddress(tagName, attrName, value, ordinal) {
	return `a:${tagName.toLowerCase()}:${attrName.toLowerCase()}:${hashValue(normaliseText(value))}:${ordinal}`;
}

// The <title> and <meta name="description"> are addressed by name rather
// than by content: there is exactly one of each per page, and they are the
// two fields most likely to be rewritten repeatedly (they drive the Google
// result snippet), so a content-based address would churn needlessly.
export const META_TITLE_ADDRESS = "m:title";
export const META_DESCRIPTION_ADDRESS = "m:description";

// Elements whose text is markup, machine data, or otherwise not page copy.
// Both the browser walk and the Worker's streaming parse skip these, so
// their text can never take up an ordinal on one side but not the other.
//
// <head> is not listed: the browser walk starts at <body> and never reaches
// it, and on the Worker side the only things inside <head> carrying text are
// <title>, <style> and <script>, which are all listed here in their own
// right. Skipping on <head> itself would mean depending on an explicit
// </head> being present in every one of the 200-odd source files.
export const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "svg", "template", "title"]);

// Marks content the Worker injects into every page (the skip link, the
// search overlay, the chat widget) and the editor's own UI. The Worker never
// sees this markup through its own rewriter -- HTMLRewriter does not re-parse
// what it injects -- so the browser has to skip it too, otherwise the two
// sides would count different text nodes and every ordinal past the first
// injection would disagree.
export const IGNORED_SUBTREE_ATTR = "data-tcb-injected";

// ---------------------------------------------------------------------------
// Styling a run of text
// ---------------------------------------------------------------------------

// A styled run is addressed by the same content hash as its text, in its own
// namespace, so a single sentence can carry both a wording change and a
// styling change without the two colliding.
export function styleAddress(text, ordinal) {
	return `s:${hashValue(normaliseText(text))}:${ordinal}`;
}

// The complete set of properties the editor may set, each with a pattern its
// value must match exactly. Nothing outside this table can ever reach the
// page: values are not passed through, they are re-built from what matched.
//
// Every property here is non-compounding on purpose. The style is applied by
// wrapping the run in a <span>, and if a run somehow ended up wrapped twice,
// a relative unit like `em` would multiply -- text would grow a little every
// time. `rem` is relative to the document root, so a double wrap is merely
// redundant rather than wrong. Colour, weight, style and family cannot
// compound at all.
export const STYLE_PROPERTIES = {
	// Order matters: it is the order they are written out in, which keeps the
	// stored string canonical so the same styling always compares equal.
	"font-family": /^var\(--font-(sans|display|mono)\)$/,
	"font-size": /^(0\.[5-9]\d?|[1-7](\.\d\d?)?|8)rem$/,
	"font-weight": /^(400|500|600|700)$/,
	"font-style": /^(normal|italic)$/,
	"text-transform": /^(none|uppercase)$/,
	color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,
};

// Parses a declaration string and rebuilds it from only what is recognised.
// Anything unknown, malformed, or carrying stray punctuation is dropped
// rather than corrected, so the result is always a strict subset of the
// table above -- which is what makes it safe to write into a style attribute.
export function sanitiseStyle(css) {
	const found = new Map();
	for (const part of String(css == null ? "" : css).split(";")) {
		const colon = part.indexOf(":");
		if (colon === -1) continue;
		const property = part.slice(0, colon).trim().toLowerCase();
		const value = part.slice(colon + 1).trim();
		const pattern = STYLE_PROPERTIES[property];
		if (!pattern || !pattern.test(value)) continue;
		found.set(property, value);
	}
	return Object.keys(STYLE_PROPERTIES)
		.filter((property) => found.has(property))
		.map((property) => `${property}:${found.get(property)}`)
		.join(";");
}

// Convenience pair for the editor: CSS text in, property map out, and back.
// Both run through sanitiseStyle, so a map built from either is always
// canonical and always inside the allowlist.
export function parseStyleParts(css) {
	const parts = {};
	for (const declaration of sanitiseStyle(css).split(";")) {
		if (!declaration) continue;
		const colon = declaration.indexOf(":");
		parts[declaration.slice(0, colon)] = declaration.slice(colon + 1);
	}
	return parts;
}

export function buildStyleString(parts) {
	return sanitiseStyle(
		Object.entries(parts || {})
			.map(([property, value]) => `${property}:${value}`)
			.join(";")
	);
}

// The colours offered in the editor: the site's own palette, plus black and
// white. Free-form hex is accepted too -- this is just what the swatches show.
export const STYLE_COLOURS = [
	{ label: "Default", value: "" },
	{ label: "Red", value: "#e5251a" },
	{ label: "Deep red", value: "#c41613" },
	{ label: "Black", value: "#111114" },
	{ label: "Grey", value: "#5a5a62" },
	{ label: "White", value: "#ffffff" },
];

export const STYLE_FONTS = [
	{ label: "Default", value: "" },
	{ label: "Body", value: "var(--font-sans)" },
	{ label: "Display", value: "var(--font-display)" },
	{ label: "Mono", value: "var(--font-mono)" },
];

// Page paths are the other half of an edit's identity. Normalise them the
// same way the site's own routing does (no trailing slash, no query string,
// no fragment) so "/about", "/about/" and "/about?x=1" are one page and not
// three.
export function normalisePath(pathname) {
	let path = String(pathname || "/");
	const cut = path.search(/[?#]/);
	if (cut !== -1) path = path.slice(0, cut);
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path || "/";
}

// Guard rails shared by the editor UI and the API. Text is capped generously
// (the longest paragraph on the site is well under this) purely so a runaway
// paste can't write a megabyte into D1.
export const MAX_TEXT_LENGTH = 8000;
export const MAX_ATTR_LENGTH = 2000;

// Attributes the editor is allowed to change, per tag. Deliberately tiny:
// this is a copy-editing tool, and letting arbitrary attributes through
// would turn a stored edit into a way to add event handlers to the page.
export const EDITABLE_ATTRS = {
	a: ["href"],
	img: ["src", "alt"],
};

// An href is written straight back into the page, so a stored edit must
// never be able to smuggle in `javascript:` (or `data:`, which can carry a
// whole HTML document). Only ordinary in-site and web links are accepted.
export function isSafeHref(value) {
	const href = String(value || "").trim();
	if (!href) return false;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
		return /^(https?:|mailto:|tel:)/i.test(href);
	}
	// Relative, root-relative and fragment links have no scheme at all.
	return !href.startsWith("//");
}

// Images may only be swapped for something already hosted on the site.
// There is no upload path in the editor, so anything else is either a typo
// or an attempt to hotlink, and both are worth rejecting loudly.
export function isSafeImageSrc(value) {
	const src = String(value || "").trim();
	if (!src) return false;
	return src.startsWith("/") && !src.startsWith("//");
}

// A deliberately tighter rule, used only for the editor's live image preview.
//
// A same-origin path is good enough to *store*, but the preview issues a real
// request on every keystroke as someone types, and there is no reason for that
// to be able to reach /api/... or to walk upwards with "..". So the preview
// requires something that actually looks like an image file, and callers
// assign the returned string rather than the one they were given -- nothing
// reaches the DOM that has not been rebuilt from a known-good shape.
//
// Returns the safe path, or null. The trailing "/" in the segment group makes
// each repetition unambiguous, so the nested quantifier cannot backtrack
// badly (checked at 5000 segments in the tests).
const PREVIEWABLE_IMAGE = /^\/(?!\/)(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.(?:webp|jpg|jpeg|png|svg|avif|gif)$/i;

export function previewableImagePath(value) {
	const match = PREVIEWABLE_IMAGE.exec(String(value == null ? "" : value).trim());
	if (!match) return null;
	// The character class means ".." can only ever appear as a whole segment,
	// so rejecting it here closes path traversal completely.
	return match[0].split("/").includes("..") ? null : match[0];
}
