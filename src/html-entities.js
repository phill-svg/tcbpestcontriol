// Decoding and escaping HTML character references.
//
// The browser and the server see the *same* words in two different forms.
// In the page, an apostrophe may be written `&#39;` and an ampersand
// `&amp;`; by the time the browser hands that text to the editor the DOM has
// already decoded it to `'` and `&`. HTMLRewriter, by contrast, streams text
// exactly as it appears in the file, entities and all (verified against
// workerd -- a text chunk for `Tom &amp; Jerry` really does arrive as the
// nine characters `&amp;`, not as `&`).
//
// Since an edit is addressed by a hash of its text, the two sides have to
// agree on the decoded form or an edit to any sentence containing a
// punctuation entity would silently never match. So everything that reads
// raw HTML -- the Worker's rewriter and the sync script -- decodes first.
//
// Anything not in the table below is left exactly as written. That is the
// safe failure: an unrecognised entity makes the hash differ from the
// browser's, the address simply doesn't match, and the page renders
// untouched rather than wrongly.

// The named references that actually occur in hand-written marketing copy.
// The full HTML5 list runs to well over 2,000 entries and carrying it here
// would be dead weight for a pest control website.
const NAMED = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	bull: "•",
	middot: "·",
	times: "×",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	pound: "£",
	euro: "€",
	eacute: "é",
	egrave: "è",
	uuml: "ü",
	ouml: "ö",
	auml: "ä",
	ccedil: "ç",
	frac12: "½",
	frac14: "¼",
	sup2: "²",
	sup3: "³",
	rarr: "→",
	larr: "←",
	check: "✓",
};

// `&amp;` must be decoded last in spirit -- but a single regex pass handles
// that naturally, because it never re-scans its own output. `&amp;lt;`
// therefore decodes to the literal text `&lt;`, which is correct.
const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

export function decodeEntities(value) {
	const input = String(value == null ? "" : value);
	if (!input.includes("&")) return input;

	return input.replace(ENTITY_PATTERN, (match, body) => {
		if (body[0] === "#") {
			const codePoint =
				body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			// Surrogates and out-of-range values are not valid characters and
			// String.fromCodePoint would throw on them.
			if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
			return String.fromCodePoint(codePoint);
		}
		const named = NAMED[body];
		return named === undefined ? match : named;
	});
}

// Escaping for text written back into the page. The rewriter re-emits text
// with `{ html: true }` (the only mode that round-trips existing markup
// byte-for-byte), which means replacement text is inserted verbatim -- so it
// has to be escaped here instead. Getting this wrong would turn a stored
// edit into stored HTML injection, so it escapes the full set rather than
// only the two characters that are strictly required in text position.
export function escapeHtmlText(value) {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
