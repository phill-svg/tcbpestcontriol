// The visual site editor.
//
// Click a word on the page, change it, publish. No hunting through 200 HTML
// files for the sentence you want.
//
// Three modes, chosen by the Worker and handed over in data-tcb-mode:
//   browse  -- just an "Edit page" button in the corner
//   edit    -- the real editor (the page is served with NO edits applied;
//              see the long note in src/index.js for why that matters)
//   preview -- the page as it *would* look once drafts are published
//
// The one rule that keeps this honest: an edit is addressed by hashing the
// text as the HTML file writes it. In edit mode the page therefore shows
// unedited copy, and this script paints the current values back over the top
// once it has finished working out the addresses. Everything you see is up
// to date; everything saved is anchored to the file.

import {
	normaliseText,
	normalisePath,
	hashValue,
	SKIPPED_ELEMENTS,
	IGNORED_SUBTREE_ATTR,
	EDITABLE_ATTRS,
	META_TITLE_ADDRESS,
	META_DESCRIPTION_ADDRESS,
	MAX_TEXT_LENGTH,
	isSafeHref,
	isSafeImageSrc,
	previewableImagePath,
	STYLE_COLOURS,
	STYLE_FONTS,
	parseStyleParts,
	buildStyleString,
} from "./content-address.js";
import { checkSeo, googlePreview, summarisePage, TITLE_MAX, DESCRIPTION_MAX } from "./seo-check.js";
import { checkSite, unverifiedTargets } from "./seo-site.js";

// The call that actually starts all this is the very last statement in the
// file. It cannot run from up here: `class Editor` is declared further down,
// and a class binding is not initialised until execution reaches it, so
// calling start() at the top throws "Cannot access 'Editor' before
// initialization" the moment edit mode is used.
function start(mode) {
	if (mode === "edit") new Editor().mount();
	else if (mode === "preview") mountPreviewBar();
	else mountLaunchButton();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const PATH = normalisePath(location.pathname);

// Search Console reports pages as whole URLs. Everything in this editor keys
// off paths, and a full URL is also too wide to read in the panel.
function pathOf(pageUrl) {
	try {
		return normalisePath(new URL(pageUrl).pathname);
	} catch {
		return String(pageUrl || "");
	}
}

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) node.appendChild(child);
	return node;
}

// Everything this script adds to the page carries data-tcb-injected, so the
// text walk below skips it. Without that the editor's own chrome would be
// counted as page content and shift every ordinal after it.
function chrome(tag, props = {}, children = []) {
	const node = el(tag, props, children);
	node.setAttribute(IGNORED_SUBTREE_ATTR, "");
	node.setAttribute("data-tcb-editor", "ui");
	return node;
}

function withUrlParams(changes) {
	const url = new URL(location.href);
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	return url.toString();
}

async function api(path, options = {}) {
	// A leading slash means "this exact endpoint"; anything else is relative to
	// the content API, which is where most calls go.
	const response = await fetch(path.startsWith("/") ? path : `/api/content/${path}`, {
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		...options,
	});
	let body = null;
	try {
		body = await response.json();
	} catch {
		/* a proxy error page, or an empty body -- handled below */
	}
	if (!response.ok) {
		// 401/403 almost always means the session quietly expired mid-session,
		// which is worth saying plainly rather than showing "request failed".
		if (response.status === 401 || response.status === 403) {
			throw new Error("Your sign-in has expired. Open /staff-chat, sign in again, then reload this page.");
		}
		const error = new Error((body && body.error) || `Something went wrong (${response.status}).`);
		// Some failures carry more than a sentence -- the Search Console setup
		// steps, for one -- and flattening them to a message throws that away.
		error.status = response.status;
		error.body = body || {};
		throw error;
	}
	return body || {};
}

// Turns a stored declaration string into something readable for the change
// list. "font-size:2rem;color:#e5251a" is accurate but nobody wants to read
// CSS to find out what they changed.
function describeStyle(css) {
	const parts = parseStyleParts(css);
	if (!Object.keys(parts).length) return "(styling cleared)";
	const words = [];
	if (parts["font-size"]) words.push(`size ${parts["font-size"]}`);
	if (parts.color) {
		const named = STYLE_COLOURS.find((colour) => colour.value === parts.color);
		words.push(named ? named.label.toLowerCase() : parts.color);
	}
	if (parts["font-weight"] === "700") words.push("bold");
	if (parts["font-style"] === "italic") words.push("italic");
	if (parts["text-transform"] === "uppercase") words.push("uppercase");
	if (parts["font-family"]) {
		const named = STYLE_FONTS.find((font) => font.value === parts["font-family"]);
		if (named) words.push(`${named.label.toLowerCase()} font`);
	}
	return words.join(", ");
}

// ---------------------------------------------------------------------------
// Browse + preview modes
// ---------------------------------------------------------------------------

function mountLaunchButton() {
	document.body.appendChild(
		chrome("div", { class: "tcb-launch" }, [
			el("button", {
				type: "button",
				class: "tcb-btn tcb-btn-primary",
				text: "Edit page",
				onclick: () => {
					location.href = withUrlParams({ edit: "1", preview: null });
				},
			}),
		])
	);
}

function mountPreviewBar() {
	document.body.appendChild(
		chrome("div", { class: "tcb-bar tcb-bar-preview" }, [
			el("span", { class: "tcb-bar-label", text: "Preview — this is how the page will look once you publish." }),
			el("div", { class: "tcb-bar-actions" }, [
				el("button", {
					type: "button",
					class: "tcb-btn",
					text: "Back to editing",
					onclick: () => {
						location.href = withUrlParams({ edit: "1", preview: null });
					},
				}),
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-primary",
					text: "Publish now",
					onclick: async (event) => {
						const button = event.currentTarget;
						button.disabled = true;
						button.textContent = "Publishing…";
						try {
							await api("publish", { method: "POST", body: JSON.stringify({ path: PATH }) });
							// Other Worker isolates hold their copy of the published
							// set for up to 30s; a beat here means the reload almost
							// always lands on the new copy rather than the old.
							setTimeout(() => {
								location.href = withUrlParams({ edit: null, preview: null });
							}, 1200);
						} catch (error) {
							button.disabled = false;
							button.textContent = "Publish now";
							alert(error.message);
						}
					},
				}),
			]),
		])
	);
}

// ---------------------------------------------------------------------------
// Indexing: working out every editable thing on the page, and its address
// ---------------------------------------------------------------------------

const SKIP_SELECTOR = [...SKIPPED_ELEMENTS].concat(`[${IGNORED_SUBTREE_ATTR}]`).join(",");

// The walk has to visit exactly the text nodes the Worker's parser visits, in
// the same order, or the ordinals drift apart and edits stop matching. That
// is why skipped subtrees are defined once, in content-address.js, and shared.
//
// Exported so test/address-parity.test.mjs can run this exact function in a
// real browser and compare its output, address for address, against what the
// Worker and the sync script produce for the same page. That parity is the
// assumption the whole editor rests on.
export function indexDocument() {
	const texts = [];
	const attrs = [];
	const ordinals = new Map();
	const nextOrdinal = (key) => {
		const seen = ordinals.get(key) || 0;
		ordinals.set(key, seen + 1);
		return seen;
	};

	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const raw = node.nodeValue;
		const normalised = normaliseText(raw);
		// Whitespace between tags takes no ordinal on either side.
		if (!normalised) continue;
		texts.push({
			kind: "text",
			node,
			original: normalised,
			originalRaw: raw,
			address: `t:${hashValue(normalised)}:${nextOrdinal(`t|${normalised}`)}`,
		});
	}

	for (const element of document.querySelectorAll(Object.keys(EDITABLE_ATTRS).join(","))) {
		if (element.closest(SKIP_SELECTOR)) continue;
		const tag = element.tagName.toLowerCase();
		for (const attr of EDITABLE_ATTRS[tag] || []) {
			if (!element.hasAttribute(attr)) continue;
			// getAttribute gives the value as authored, which is what the Worker
			// hashes too. `element.href` would give a resolved absolute URL and
			// would never match.
			const normalised = normaliseText(element.getAttribute(attr));
			attrs.push({
				kind: "attr",
				element,
				tag,
				attr,
				original: normalised,
				address: `a:${tag}:${attr}:${hashValue(normalised)}:${nextOrdinal(`${tag}|${attr}|${normalised}`)}`,
			});
		}
	}

	return { texts, attrs };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

class Editor {
	constructor() {
		const { texts, attrs } = indexDocument();
		this.entries = new Map(); // address -> entry
		for (const entry of texts.concat(attrs)) {
			// A duplicate address would mean two things claim the same identity;
			// the first wins, matching the Worker, which applies to the first
			// match it streams past.
			if (!this.entries.has(entry.address)) this.entries.set(entry.address, entry);
		}
		this.rows = new Map(); // address -> stored row from the API
		this.active = null; // the field currently being typed into
		this.busy = false;
	}

	async mount() {
		this.buildChrome();
		document.body.classList.add("tcb-editing-mode");
		try {
			const { edits } = await api(`edits?path=${encodeURIComponent(PATH)}`);
			for (const row of edits) this.rows.set(row.address, row);
			this.paintStoredValues();
		} catch (error) {
			this.toast(error.message, "error");
		}
		this.bindPageInteractions();
		this.refreshStatus();
		this.checkDraftPost();
	}

	// Current values are painted on *after* indexing, so the addresses stay
	// anchored to what the HTML file says while the screen shows what the site
	// currently says. Drafts win over published, so you always edit forward
	// from your own most recent change.
	paintStoredValues() {
		for (const [address, row] of this.rows) {
			const value = row.draft !== null && row.draft !== undefined ? row.draft : row.published;
			if (value === null || value === undefined) continue;

			// A styling row is addressed by the same hash as the text it styles,
			// in the "s:" namespace, so it resolves back to the same entry.
			if (address.startsWith("s:")) {
				const entry = this.entries.get(`t:${address.slice(2)}`);
				if (!entry) continue;
				this.previewStyle(entry, value);
				this.markEdited(entry);
				continue;
			}

			const entry = this.entries.get(address);
			if (!entry) continue;
			this.renderValue(entry, value);
			this.markEdited(entry);
		}
	}

	renderValue(entry, value) {
		if (entry.kind === "text") {
			const raw = entry.originalRaw;
			const leading = raw.match(/^\s*/)[0];
			const trailing = raw.match(/\s*$/)[0];
			entry.node.nodeValue = `${leading}${value}${trailing}`;
			this.refreshDeletedMarker(entry, value);
		} else {
			entry.element.setAttribute(entry.attr, value);
		}
	}

	// Deleted text leaves nothing on screen to click, which would make it the
	// one change you cannot undo from the page itself. So while editing, a
	// small marker stands in its place -- visible, and clicking it restores
	// the original wording. Visitors never see this; it only exists in the
	// editor's own chrome.
	refreshDeletedMarker(entry, value) {
		if (value === "") {
			if (entry.marker && entry.marker.isConnected) return;
			const marker = chrome("button", {
				type: "button",
				class: "tcb-deleted",
				text: "deleted — click to restore",
				onclick: (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.revertEdit(entry.address);
				},
			});
			entry.marker = marker;
			entry.node.parentNode.insertBefore(marker, entry.node);
		} else if (entry.marker) {
			if (entry.marker.parentNode) entry.marker.parentNode.removeChild(entry.marker);
			entry.marker = null;
		}
	}

	markEdited(entry) {
		const target = entry.kind === "text" ? entry.node.parentElement : entry.element;
		if (target) target.classList.add("tcb-has-edit");
	}

	unmarkEdited(entry) {
		const target = entry.kind === "text" ? entry.node.parentElement : entry.element;
		if (target) target.classList.remove("tcb-has-edit");
	}

	// -- chrome ---------------------------------------------------------------

	buildChrome() {
		this.status = el("span", { class: "tcb-bar-label", text: this.isTouch ? "Tap any text to change it." : "Click any text to change it." });

		this.publishButton = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-primary",
			text: "Publish",
			onclick: () => this.publish(),
		});
		this.previewButton = el("button", {
			type: "button",
			class: "tcb-btn",
			text: "Preview",
			onclick: () => {
				location.href = withUrlParams({ preview: "1", edit: null });
			},
		});

		this.bar = chrome("div", { class: "tcb-bar" }, [
			el("span", { class: "tcb-bar-badge", text: "Editing" }),
			this.status,
			el("div", { class: "tcb-bar-actions" }, [
				el("button", {
					type: "button",
					class: "tcb-btn",
					text: "Page title & description",
					onclick: () => this.openPageSettings(),
				}),
				el("button", { type: "button", class: "tcb-btn", text: "SEO check", onclick: () => this.openSeoCheck() }),
				el("button", { type: "button", class: "tcb-btn", text: "New post", onclick: () => this.openNewPost() }),
				el("button", { type: "button", class: "tcb-btn", text: "Changes", onclick: () => this.openChanges() }),
				this.previewButton,
				this.publishButton,
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-quiet",
					text: "Done",
					onclick: () => {
						location.href = withUrlParams({ edit: null, preview: null });
					},
				}),
			]),
		]);
		document.body.appendChild(this.bar);

		// A single hover outline element, moved around, rather than a class on
		// every candidate: outlining hundreds of elements at once would make
		// the page unreadable and force a lot of style recalculation.
		this.hover = chrome("div", { class: "tcb-hover" });
		document.body.appendChild(this.hover);

		// Two buttons, shown independently: styling applies to any run of text,
		// while the link/image one only appears over an <a> or an <img>.
		this.styleChipButton = el("button", {
			type: "button",
			class: "tcb-chip-btn",
			text: "Style",
			onclick: () => this.openStylePanel(),
		});
		this.attrChipButton = el("button", {
			type: "button",
			class: "tcb-chip-btn",
			text: "Edit link",
			onclick: () => this.openAttrPanel(),
		});
		for (const button of [this.styleChipButton, this.attrChipButton]) {
			button.addEventListener("mousedown", (event) => event.preventDefault());
		}
		this.chip = chrome("div", { class: "tcb-chip" }, [this.styleChipButton, this.attrChipButton]);
		this.chip.hidden = true;
		document.body.appendChild(this.chip);

		this.toastNode = chrome("div", { class: "tcb-toast" });
		this.toastNode.hidden = true;
		document.body.appendChild(this.toastNode);
	}

	toast(message, kind = "info") {
		this.toastNode.textContent = message;
		this.toastNode.className = `tcb-toast tcb-toast-${kind}`;
		this.toastNode.hidden = false;
		clearTimeout(this.toastTimer);
		// Errors stay up long enough to actually be read.
		this.toastTimer = setTimeout(() => {
			this.toastNode.hidden = true;
		}, kind === "error" ? 8000 : 2600);
	}

	refreshStatus() {
		let drafts = 0;
		let published = 0;
		for (const row of this.rows.values()) {
			if (row.draft !== null && row.draft !== undefined) drafts++;
			else if (row.published !== null && row.published !== undefined) published++;
		}
		this.publishButton.disabled = drafts === 0;
		this.previewButton.disabled = drafts === 0;
		if (drafts) {
			this.status.textContent = `${drafts} unpublished ${drafts === 1 ? "change" : "changes"} on this page.`;
		} else if (published) {
			this.status.textContent = `${published} published ${published === 1 ? "change" : "changes"} on this page.`;
		} else {
			this.status.textContent = this.isTouch ? "Tap any text to change it." : "Click any text to change it.";
		}
	}

	// -- page interaction -----------------------------------------------------

	bindPageInteractions() {
		// Capture phase, so links and buttons never get a chance to act on the
		// click. In edit mode the whole page is a document, not a website.
		document.addEventListener(
			"click",
			(event) => {
				if (this.isChrome(event.target)) return;
				if (this.active && this.active.span.contains(event.target)) return;
				event.preventDefault();
				event.stopPropagation();
				this.handlePageClick(event);
			},
			true
		);
		document.addEventListener("submit", (event) => {
			if (!this.isChrome(event.target)) event.preventDefault();
		}, true);

		document.addEventListener("mousemove", (event) => this.updateHover(event));
		window.addEventListener("scroll", () => this.hideHover(true), { passive: true });
		window.addEventListener("resize", () => this.hideHover(true));
	}

	isChrome(node) {
		return !!(node && node.closest && node.closest(`[data-tcb-editor], [${IGNORED_SUBTREE_ATTR}]`));
	}

	handlePageClick(event) {
		if (this.active) this.commitActive();

		const image = event.target.closest && event.target.closest("img");
		if (image) {
			const entry = this.findAttrEntry(image, "src");
			if (entry) return this.openAttrPanel(entry);
		}

		const entry = this.findTextEntryAt(event);
		if (entry) return this.beginTextEdit(entry);

		const link = event.target.closest && event.target.closest("a[href]");
		if (link) {
			const linkEntry = this.findAttrEntry(link, "href");
			if (linkEntry) return this.openAttrPanel(linkEntry);
		}
		this.toast("That part of the page can't be edited here — ask Claude to change it in the code.");
	}

	findAttrEntry(element, attr) {
		for (const entry of this.entries.values()) {
			if (entry.kind === "attr" && entry.element === element && entry.attr === attr) return entry;
		}
		return null;
	}

	// Turns a click position into the exact text node under the cursor. The
	// two APIs are the same idea under different names -- Chrome and Safari
	// ship caretRangeFromPoint, Firefox ships caretPositionFromPoint.
	textNodeAtPoint(x, y) {
		if (document.caretRangeFromPoint) {
			const range = document.caretRangeFromPoint(x, y);
			return range && range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null;
		}
		if (document.caretPositionFromPoint) {
			const position = document.caretPositionFromPoint(x, y);
			return position && position.offsetNode.nodeType === Node.TEXT_NODE ? position.offsetNode : null;
		}
		return null;
	}

	findTextEntryAt(event) {
		const node = this.textNodeAtPoint(event.clientX, event.clientY);
		if (node) {
			const entry = this.entryForNode(node);
			if (entry) return entry;
		}
		// Clicking the padding of a heading lands on the element, not on its
		// text, which is a very easy thing to do -- so fall back to the element's
		// own text when it has exactly one editable run.
		const element = event.target.closest ? event.target : null;
		if (!element) return null;
		const candidates = [];
		for (const child of element.childNodes) {
			if (child.nodeType !== Node.TEXT_NODE) continue;
			const entry = this.entryForNode(child);
			if (entry) candidates.push(entry);
		}
		return candidates.length === 1 ? candidates[0] : null;
	}

	entryForNode(node) {
		for (const entry of this.entries.values()) {
			if (entry.kind === "text" && entry.node === node) return entry;
		}
		return null;
	}

	// True on touchscreens, where there is no pointer to hover with. The chip
	// is pinned open while editing instead -- see pinChip.
	get isTouch() {
		return window.matchMedia && window.matchMedia("(hover: none)").matches;
	}

	updateHover(event) {
		// While editing, the chip is pinned beside the field and must stay put.
		// Only the hover outline is cleared.
		if (this.active) {
			this.hover.style.display = "none";
			return;
		}
		// Reaching for the chip must not dismiss it. The pointer has to cross
		// onto the chip to click it, and the chip is chrome, so the check below
		// would hide the one control the user is aiming at -- and, worse, move
		// it out from under the cursor mid-click.
		if (this.chip.contains(event.target)) return this.cancelHoverHide();
		if (this.isChrome(event.target)) return this.hideHover();

		const image = event.target.closest && event.target.closest("img");
		const link = event.target.closest && event.target.closest("a[href]");
		const textEntry = this.findTextEntryAt(event);

		let target = null;
		if (textEntry) target = textEntry.node.parentElement;
		else if (image) target = image;
		else if (link) target = link;

		if (!target) return this.hideHover();

		const rect = target.getBoundingClientRect();
		if (!rect.width && !rect.height) return this.hideHover();
		Object.assign(this.hover.style, {
			display: "block",
			top: `${rect.top + window.scrollY}px`,
			left: `${rect.left + window.scrollX}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});

		// The chip is the way in to a link's address or an image's file --
		// clicking those directly edits their visible text instead, which is
		// what you want the great majority of the time.
		const chipEntry = image ? this.findAttrEntry(image, "src") : link ? this.findAttrEntry(link, "href") : null;
		this.chipEntry = chipEntry;
		this.styleEntry = textEntry;

		this.attrChipButton.hidden = !chipEntry;
		if (chipEntry) this.attrChipButton.textContent = image ? "Change image" : "Edit link";
		this.styleChipButton.hidden = !textEntry;

		if (chipEntry || textEntry) {
			this.cancelHoverHide();
			this.chip.hidden = false;
			Object.assign(this.chip.style, {
				top: `${rect.top + window.scrollY + 2}px`,
				left: `${rect.left + window.scrollX + rect.width}px`,
			});
		} else {
			this.chip.hidden = true;
		}
	}

	// Hiding is delayed by default. Getting from the text to the chip means
	// crossing whatever sits between them, and for those few milliseconds the
	// pointer is over neither -- so hiding immediately would snatch the chip
	// away mid-reach, every time. The delay is cancelled the moment the
	// pointer lands on anything that should keep it up.
	hideHover(immediate = false) {
		if (immediate) {
			this.cancelHoverHide();
			this.applyHoverHide();
			return;
		}
		if (this.hoverHideTimer) return;
		this.hoverHideTimer = setTimeout(() => {
			this.hoverHideTimer = null;
			this.applyHoverHide();
		}, 260);
	}

	cancelHoverHide() {
		if (!this.hoverHideTimer) return;
		clearTimeout(this.hoverHideTimer);
		this.hoverHideTimer = null;
	}

	applyHoverHide() {
		this.hover.style.display = "none";
		// A pinned chip belongs to the edit in progress, not to the pointer.
		if (!this.chipPinned) this.chip.hidden = true;
	}

	// Anchors the chip beside the field being edited and leaves it there.
	//
	// This is what makes the editor usable on a phone. The chip was only ever
	// summoned by `mousemove`, which touchscreens do not fire, so Style, Edit
	// link and Change image were unreachable on mobile -- you could retype a
	// sentence but never restyle it. Pinning it to the active field needs no
	// pointer at all, and is a small improvement on desktop too: the buttons
	// stop moving around once you have committed to editing something.
	pinChip(entry, field) {
		// Located from the field, not from entry.node: opening the field lifts
		// that text node out of the document, so it has no parent to ask by the
		// time this runs. The field sits exactly where it was.
		const link = field.parentElement && field.parentElement.closest("a[href]");
		const linkEntry = link ? this.findAttrEntry(link, "href") : null;

		this.styleEntry = entry;
		this.chipEntry = linkEntry;
		this.styleChipButton.hidden = false;
		this.attrChipButton.hidden = !linkEntry;
		if (linkEntry) this.attrChipButton.textContent = "Edit link";

		const rect = field.getBoundingClientRect();
		Object.assign(this.chip.style, {
			top: `${rect.top + window.scrollY + 2}px`,
			left: `${rect.left + window.scrollX + rect.width}px`,
		});
		this.cancelHoverHide();
		this.chip.hidden = false;
		this.chipPinned = true;
	}

	unpinChip() {
		this.chipPinned = false;
		this.chip.hidden = true;
	}

	// -- inline text editing --------------------------------------------------

	beginTextEdit(entry) {
		this.hideHover();

		const raw = entry.node.nodeValue;
		const leading = raw.match(/^\s*/)[0];
		const trailing = raw.match(/\s*$/)[0];
		const core = raw.slice(leading.length, raw.length - trailing.length);

		const span = el("span", { class: "tcb-field" });
		span.setAttribute("data-tcb-editor", "field");
		// plaintext-only keeps pasted formatting out; browsers without it fall
		// back to true, and the paste handler below strips markup anyway.
		span.contentEditable = "plaintext-only";
		if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
		span.textContent = core;

		// The node's surrounding whitespace is significant between inline
		// elements ("word <b>bold</b>"), so it is preserved as real text nodes
		// on either side of the field rather than swallowed into it.
		const parent = entry.node.parentNode;
		const leadNode = leading ? document.createTextNode(leading) : null;
		const trailNode = trailing ? document.createTextNode(trailing) : null;
		parent.insertBefore(span, entry.node);
		if (leadNode) parent.insertBefore(leadNode, span);
		if (trailNode) parent.insertBefore(trailNode, span.nextSibling);
		parent.removeChild(entry.node);

		this.active = { entry, span, leadNode, trailNode, leading, trailing, before: core };

		span.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.cancelActive();
			} else if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.commitActive();
			}
		});
		span.addEventListener("paste", (event) => {
			// Pasting from Word or a web page otherwise brings a pile of markup
			// with it, and this is a plain-text field.
			event.preventDefault();
			const text = (event.clipboardData || window.clipboardData).getData("text/plain");
			document.execCommand("insertText", false, text.replace(/\s+/g, " "));
		});
		span.addEventListener("blur", () => {
			if (this.active && this.active.span === span) this.commitActive();
		});

		span.focus();
		this.pinChip(entry, span);
		const range = document.createRange();
		range.selectNodeContents(span);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	}

	// Puts a plain text node back where the editable span was, and re-points
	// the entry at it so the same sentence can be edited again immediately.
	closeActive(value) {
		const { entry, span, leadNode, trailNode, leading, trailing } = this.active;
		this.active = null;
		this.unpinChip();
		const node = document.createTextNode(`${leading}${value}${trailing}`);
		span.parentNode.replaceChild(node, span);
		if (leadNode && leadNode.parentNode) leadNode.parentNode.removeChild(leadNode);
		if (trailNode && trailNode.parentNode) trailNode.parentNode.removeChild(trailNode);
		entry.node = node;
		return entry;
	}

	cancelActive() {
		if (!this.active) return;
		const before = this.active.before;
		this.closeActive(before);
	}

	commitActive() {
		if (!this.active) return;
		const { before } = this.active;
		// innerText rather than textContent: a contenteditable can end up with
		// a stray <br> or <div> from the browser's own editing behaviour, and
		// innerText renders those back to the newlines they represent.
		const value = normaliseText(this.active.span.innerText);
		const entry = this.closeActive(value);
		// closeActive rebuilds the text node directly rather than going through
		// renderValue, so the deleted-marker has to be brought into step here.
		this.refreshDeletedMarker(entry, value);

		// Clearing the field deletes the words. No confirmation prompt: the
		// original is still in the HTML file, the change list shows it as
		// deleted, and both the marker left behind and Revert bring it back --
		// so a prompt would only be in the way of something already undoable.
		if (!value) {
			if (!before) return;
			this.save(entry, "", before);
			return;
		}
		if (value === before) return;
		if (value.length > MAX_TEXT_LENGTH) {
			this.renderValue(entry, before);
			this.toast(`That's too long (limit ${MAX_TEXT_LENGTH} characters).`, "error");
			return;
		}
		this.save(entry, value, before);
	}

	async save(entry, value, previous) {
		this.markEdited(entry);
		try {
			await api("save", {
				method: "POST",
				body: JSON.stringify({ path: PATH, address: entry.address, original: entry.original, value }),
			});
			const row = this.rows.get(entry.address) || { address: entry.address, kind: entry.kind, original: entry.original, published: null };
			row.draft = value;
			this.rows.set(entry.address, row);
			this.refreshStatus();
			this.toast(value === "" ? "Text deleted. Publish when you're ready." : "Saved as a draft. Publish when you're ready.");
		} catch (error) {
			// Roll the page back to what it showed before, so the screen never
			// claims a change that isn't stored.
			this.renderValue(entry, previous);
			if (!this.rows.has(entry.address)) this.unmarkEdited(entry);
			this.toast(error.message, "error");
		}
	}

	// -- links and images -----------------------------------------------------

	openAttrPanel(entry = this.chipEntry) {
		if (!entry) return;
		// Committed first: while a field is open its text node has been lifted
		// out of the document, so anything reading entry.node.parentElement -- as
		// the size stepper does -- would be looking at nothing.
		if (this.active) this.commitActive();
		const isImage = entry.tag === "img";
		const altEntry = isImage ? this.findAttrEntry(entry.element, "alt") : null;

		const currentSrc = entry.element.getAttribute(entry.attr) || "";
		const valueInput = el("input", { type: "text", class: "tcb-input", value: currentSrc });
		valueInput.value = currentSrc;

		const altInput = altEntry ? el("input", { type: "text", class: "tcb-input" }) : null;
		if (altInput) altInput.value = entry.element.getAttribute("alt") || "";

		const preview = isImage ? el("img", { class: "tcb-preview", alt: "" }) : null;
		// The preview only ever shows a path rebuilt by previewableImagePath()
		// -- the value assigned is the one it returns, never the one typed. It
		// is stricter than the isSafeImageSrc() gate used on save, because the
		// preview fires a real request on every keystroke; see the note in
		// content-address.js. A blank preview therefore doubles as live
		// validation that the path is wrong.
		//
		// CodeQL reports js/xss-through-dom on the assignment below and it is a
		// false positive. It cannot be silenced from here: GitHub's default
		// code-scanning setup ignores inline `// codeql[...]` markers, so the
		// alert has to be dismissed once in the repository's Security tab
		// (Code scanning -> the alert -> Dismiss -> False positive). Recording
		// the argument here so whoever does that is not taking it on trust:
		//
		//  1. CodeQL's taint tracking follows the string out of the regex match
		//     and does not model that an anchored pattern constrains what comes
		//     back. Regex sanitisers are a known blind spot -- the same alert
		//     appeared when the guard was a boolean helper, and rewriting it to
		//     return its own match did not change the verdict.
		//  2. The returned string cannot express a scheme, a host, a quote, an
		//     angle bracket, whitespace, a query or a fragment: the pattern
		//     admits only [A-Za-z0-9._~-] and "/", must start with a single
		//     "/", and must end in an image extension. test/content-edits.test
		//     fuzzes exactly that over ~138,000 inputs, covering every
		//     metacharacter in every position, and nothing escapes.
		//  3. The sink is an <img src>, which cannot execute script in any case
		//     -- not even via a data: SVG, which browsers load in a
		//     non-scripting mode. A second, independent reason this could not
		//     be XSS even with the guard removed entirely.
		//
		// If the guard is ever loosened, the dismissal should be revisited.
		const showPreview = (value) => {
			if (!preview) return;
			const safePath = previewableImagePath(value);
			if (safePath) preview.src = safePath;
			else preview.removeAttribute("src");
		};
		if (preview) {
			showPreview(currentSrc);
			valueInput.addEventListener("input", () => showPreview(valueInput.value));
		}

		const fields = [
			el("label", { class: "tcb-label" }, [
				el("span", { text: isImage ? "Image file" : "Link address" }),
				valueInput,
			]),
		];
		if (preview) fields.push(preview);
		if (isImage) fields.push(el("div", { class: "tcb-picker" }));
		if (altInput) {
			fields.push(
				el("label", { class: "tcb-label" }, [
					el("span", { text: "Alt text (describes the image for screen readers and Google)" }),
					altInput,
				])
			);
		}
		if (!isImage) {
			fields.push(
				el("p", {
					class: "tcb-hint",
					text: "A page on this site (/termite-treatment), or a full https://, mailto: or tel: link.",
				})
			);
		}

		const dialog = this.openDialog(isImage ? "Change image" : "Edit link", fields, async () => {
			const value = valueInput.value.trim();
			if (isImage && !isSafeImageSrc(value)) {
				throw new Error("Pick an image already on this site — the path should start with /assets/.");
			}
			if (!isImage && !isSafeHref(value)) {
				throw new Error("Links must be a page on this site, or start with https://, mailto: or tel:.");
			}
			await this.saveDirect(entry, value);
			if (altEntry && altInput) await this.saveDirect(altEntry, altInput.value.trim());
		});

		if (isImage) this.fillImagePicker(dialog.querySelector(".tcb-picker"), valueInput, showPreview);
	}

	// The Worker can't list the assets directory at runtime, so the picker is
	// driven by a manifest generated at author time by
	// scripts/build-image-manifest.js. If it isn't there, the path box still
	// works on its own.
	async fillImagePicker(container, input, showPreview) {
		if (!container) return;
		try {
			const response = await fetch("/assets/images/manifest.json", { credentials: "same-origin" });
			if (!response.ok) return;
			const { images } = await response.json();
			// The manifest is generated from this repo, so this filter is belt
			// and braces rather than a real threat -- but it means every path
			// reaching an <img> in the editor has passed the same check, with no
			// second route in that only happens to be safe today.
			const usable = (Array.isArray(images) ? images : []).filter((image) => image && isSafeImageSrc(image.path));
			if (!usable.length) return;
			container.appendChild(el("p", { class: "tcb-hint", text: "Or pick one:" }));
			const grid = el("div", { class: "tcb-picker-grid" });
			for (const image of usable) {
				const button = el("button", { type: "button", class: "tcb-picker-item", title: image.path });
				button.appendChild(el("img", { src: image.path, alt: "", loading: "lazy" }));
				button.addEventListener("click", () => {
					input.value = image.path;
					showPreview(image.path);
				});
				grid.appendChild(button);
			}
			container.appendChild(grid);
		} catch {
			/* no manifest -- the free-text path box is enough */
		}
	}

	// Used by the dialogs, where the new value is known up front rather than
	// typed into the page itself.
	async saveDirect(entry, value) {
		const before =
			entry.kind === "attr" ? entry.element.getAttribute(entry.attr) || "" : entry.node.nodeValue;
		this.renderValue(entry, value);
		this.markEdited(entry);
		try {
			await api("save", {
				method: "POST",
				body: JSON.stringify({ path: PATH, address: entry.address, original: entry.original, value }),
			});
			const row = this.rows.get(entry.address) || { address: entry.address, kind: entry.kind, original: entry.original, published: null };
			row.draft = value;
			this.rows.set(entry.address, row);
			this.refreshStatus();
		} catch (error) {
			if (entry.kind === "attr") entry.element.setAttribute(entry.attr, before);
			else entry.node.nodeValue = before;
			if (!this.rows.has(entry.address)) this.unmarkEdited(entry);
			throw error;
		}
	}

	// If this page is an unpublished post, say so and offer to publish it.
	// Without this a draft would be a page you could reach and edit but never
	// finish, with no sign anywhere that it was waiting.
	async checkDraftPost() {
		if (!/^\/blog-/.test(PATH)) return;
		let posts = [];
		try {
			({ posts } = await api("/api/blog/posts"));
		} catch {
			return;
		}
		const post = (posts || []).find((candidate) => `/${candidate.slug}` === PATH);
		if (!post || post.status !== "draft") return;

		const publish = el("button", { type: "button", class: "tcb-btn tcb-btn-primary", text: "Publish post" });
		publish.addEventListener("click", async () => {
			publish.disabled = true;
			publish.textContent = "Publishing…";
			try {
				await api("/api/blog/publish", { method: "POST", body: JSON.stringify({ slug: post.slug }) });
				banner.replaceChildren(
					el("span", {
						class: "tcb-bar-label",
						text: "Published. It is on the blog, the sitemap and the feed — live in a minute or two.",
					})
				);
			} catch (error) {
				publish.disabled = false;
				publish.textContent = "Publish post";
				this.toast(error.message, "error");
			}
		});

		const banner = chrome("div", { class: "tcb-bar tcb-bar-draft" }, [
			el("span", { class: "tcb-bar-badge", text: "Draft" }),
			el("span", {
				class: "tcb-bar-label",
				text: "Nobody can find this post yet — it is not on the blog, the sitemap or the feed, and Google is told to skip it.",
			}),
			el("div", { class: "tcb-bar-actions" }, [publish]),
		]);
		document.body.appendChild(banner);
	}

	// -- writing a new blog post ----------------------------------------------

	// BLOG-GUIDE.md's seven manual steps, as a form. Only the parts that need
	// deciding are asked for: the slug, date, read time, canonical URL, social
	// tags and related-post cards are all derived server-side.
	//
	// The wording does not have to be final here. Once the draft exists it is
	// an ordinary page, so it can be opened with ?edit=1 and polished with the
	// same click-to-edit the rest of the site uses.
	async openNewPost() {
		let options = { categories: [], services: [] };
		try {
			options = await api("/api/blog/options");
		} catch (error) {
			this.toast(error.message, "error");
			return;
		}

		const field = (label, control, hint) =>
			el("label", { class: "tcb-label" }, hint ? [el("span", { text: label }), control, el("span", { class: "tcb-hint", text: hint })] : [el("span", { text: label }), control]);

		const titleInput = el("input", { type: "text", class: "tcb-input", placeholder: "Controlling Ants in Your Canberra Home This Summer" });
		const descriptionInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "2" });
		const descriptionCount = el("span", { class: "tcb-hint" });
		const updateCount = () => {
			const length = descriptionInput.value.trim().length;
			descriptionCount.textContent = `${length} characters — Google shows about 155.`;
			descriptionCount.className = length > 200 || (length && length < 20) ? "tcb-hint tcb-hint-warn" : "tcb-hint";
		};
		descriptionInput.addEventListener("input", updateCount);
		updateCount();

		const categorySelect = el("select", { class: "tcb-input" });
		for (const category of options.categories) categorySelect.appendChild(el("option", { value: category, text: category }));

		const serviceSelect = el("select", { class: "tcb-input" });
		for (const service of options.services) serviceSelect.appendChild(el("option", { value: service.url, text: service.name }));

		const heroInput = el("input", { type: "text", class: "tcb-input", value: "/assets/images/pest-ant-macro.webp" });
		const heroAltInput = el("input", { type: "text", class: "tcb-input" });
		const heroPreview = el("img", { class: "tcb-preview", alt: "" });
		const showHero = (value) => {
			const safe = previewableImagePath(value);
			if (safe) heroPreview.src = safe;
			else heroPreview.removeAttribute("src");
		};
		heroInput.addEventListener("input", () => showHero(heroInput.value));
		showHero(heroInput.value);
		const picker = el("div", { class: "tcb-picker" });
		this.fillImagePicker(picker, heroInput, showHero);

		const introInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "3" });
		const pestInput = el("input", { type: "text", class: "tcb-input", placeholder: "ant control" });

		// Sections are added and removed as needed, rather than being fixed at
		// the template's three.
		const sectionList = el("div", { class: "tcb-sections" });
		const addSection = (heading = "", paragraph = "") => {
			const headingInput = el("input", { type: "text", class: "tcb-input", placeholder: "Section heading" });
			headingInput.value = heading;
			const paragraphInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "3", placeholder: "Section text" });
			paragraphInput.value = paragraph;
			const row = el("div", { class: "tcb-section" }, [
				headingInput,
				paragraphInput,
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-quiet",
					text: "Remove section",
					onclick: () => row.remove(),
				}),
			]);
			row.headingInput = headingInput;
			row.paragraphInput = paragraphInput;
			sectionList.appendChild(row);
		};
		addSection();
		addSection();

		this.openDialog(
			"New blog post",
			[
				el("p", { class: "tcb-hint", text: "This creates the post as a draft. Nothing links to it and Google is told to ignore it until you publish." }),
				field("Title", titleInput),
				field("Description", descriptionInput),
				descriptionCount,
				field("Category", categorySelect),
				field("Main image", heroInput),
				heroPreview,
				picker,
				field("Image description", heroAltInput, "What the picture shows, for screen readers and Google."),
				field("Opening paragraph", introInput),
				sectionList,
				el("button", { type: "button", class: "tcb-btn", text: "Add another section", onclick: () => addSection() }),
				field("Topic for the closing call to action", pestInput, "Filled into “a conversation about ___ in and around your home”."),
				field("Service page to link", serviceSelect),
			],
			async () => {
				const sections = [...sectionList.children].map((row) => ({
					heading: row.headingInput.value.trim(),
					paragraph: row.paragraphInput.value.trim(),
				}));
				const result = await api("/api/blog/create", {
					method: "POST",
					body: JSON.stringify({
						title: titleInput.value,
						description: descriptionInput.value,
						category: categorySelect.value,
						heroSrc: heroInput.value.trim(),
						heroAlt: heroAltInput.value,
						intro: introInput.value,
						sections,
						pestTopic: pestInput.value,
						relatedServiceUrl: serviceSelect.value,
					}),
				});
				// Straight into the draft, in edit mode, so the wording can be
				// worked on where it will actually appear.
				setTimeout(() => {
					location.href = `${result.url}?edit=1`;
				}, 1200);
			},
			{ confirmLabel: "Create draft" }
		);
	}

	// -- styling a run of text ------------------------------------------------

	// Styling wraps the run in a <span>, so the preview here does the same
	// thing the Worker will do -- what you see while the panel is open is
	// exactly what gets served.
	openStylePanel(entry = this.styleEntry) {
		if (!entry || entry.kind !== "text") return;
		// Committed first: while a field is open its text node has been lifted
		// out of the document, so anything reading entry.node.parentElement -- as
		// the size stepper does -- would be looking at nothing.
		if (this.active) this.commitActive();

		const address = `s:${entry.address.slice(2)}`;
		const row = this.rows.get(address);
		const current = parseStyleParts((row && (row.draft ?? row.published)) || "");

		// Size is offered as steps relative to whatever this text already is,
		// but stored as an absolute rem value read off the live element. That
		// keeps it contextual (a heading steps in heading-sized jumps) without
		// the value compounding if it were ever applied twice.
		const host = entry.node.parentElement;
		const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		const baseRem = (parseFloat(getComputedStyle(host).fontSize) || rootSize) / rootSize;
		const currentRem = current["font-size"] ? parseFloat(current["font-size"]) : baseRem;

		const parts = { ...current };
		const preview = () => this.previewStyle(entry, buildStyleString(parts));

		const sizeLabel = el("span", { class: "tcb-size-value" });
		const setSize = (rem) => {
			const clamped = Math.min(8, Math.max(0.5, Math.round(rem * 100) / 100));
			parts["font-size"] = `${clamped}rem`;
			sizeLabel.textContent = `${clamped}rem`;
			preview();
		};
		sizeLabel.textContent = `${Math.round(currentRem * 100) / 100}rem`;

		const sizeRow = el("div", { class: "tcb-style-row" }, [
			el("button", {
				type: "button",
				class: "tcb-btn",
				text: "−",
				onclick: () => setSize((parseFloat(parts["font-size"]) || currentRem) * 0.9),
			}),
			sizeLabel,
			el("button", {
				type: "button",
				class: "tcb-btn",
				text: "+",
				onclick: () => setSize((parseFloat(parts["font-size"]) || currentRem) * 1.1),
			}),
			el("button", {
				type: "button",
				class: "tcb-btn tcb-btn-quiet",
				text: "Reset size",
				onclick: () => {
					delete parts["font-size"];
					sizeLabel.textContent = `${Math.round(baseRem * 100) / 100}rem`;
					preview();
				},
			}),
		]);

		const swatches = el("div", { class: "tcb-swatches" });
		for (const colour of STYLE_COLOURS) {
			const swatch = el("button", {
				type: "button",
				class: "tcb-swatch",
				title: colour.label,
				onclick: () => {
					if (colour.value) parts.color = colour.value;
					else delete parts.color;
					for (const other of swatches.children) other.classList.remove("tcb-swatch-on");
					swatch.classList.add("tcb-swatch-on");
					preview();
				},
			});
			// "Default" is the absence of a colour, so it gets a slash rather
			// than a fill -- a white swatch would read as "white text".
			swatch.style.background = colour.value || "transparent";
			if (!colour.value) swatch.textContent = "⊘";
			if ((current.color || "") === colour.value) swatch.classList.add("tcb-swatch-on");
			swatches.appendChild(swatch);
		}

		const toggle = (label, property, on, off) =>
			el("button", {
				type: "button",
				class: `tcb-btn${(current[property] || off) === on ? " tcb-btn-on" : ""}`,
				text: label,
				onclick: (event) => {
					const button = event.currentTarget;
					const active = parts[property] === on;
					if (active) delete parts[property];
					else parts[property] = on;
					button.classList.toggle("tcb-btn-on", !active);
					preview();
				},
			});

		const fontSelect = el("select", { class: "tcb-input" });
		for (const font of STYLE_FONTS) {
			const option = el("option", { value: font.value, text: font.label });
			if ((current["font-family"] || "") === font.value) option.selected = true;
			fontSelect.appendChild(option);
		}
		fontSelect.addEventListener("change", () => {
			if (fontSelect.value) parts["font-family"] = fontSelect.value;
			else delete parts["font-family"];
			preview();
		});

		const fields = [
			el("p", { class: "tcb-hint", text: "Changes show on the page as you make them." }),
			el("label", { class: "tcb-label" }, [el("span", { text: "Size" }), sizeRow]),
			el("label", { class: "tcb-label" }, [el("span", { text: "Colour" }), swatches]),
			el("label", { class: "tcb-label" }, [
				el("span", { text: "Weight & style" }),
				el("div", { class: "tcb-style-row" }, [
					toggle("Bold", "font-weight", "700", "400"),
					toggle("Italic", "font-style", "italic", "normal"),
					toggle("UPPERCASE", "text-transform", "uppercase", "none"),
				]),
			]),
			el("label", { class: "tcb-label" }, [el("span", { text: "Font" }), fontSelect]),
		];

		this.openDialog("Style this text", fields, async () => {
			await this.saveStyle(entry, address, buildStyleString(parts));
		}, {
			// Closing without saving has to put the page back, since every
			// control has already changed it.
			onCancel: () => this.previewStyle(entry, (row && (row.draft ?? row.published)) || ""),
			extraActions: [
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-quiet",
					text: "Clear styling",
					onclick: async (event) => {
						const button = event.currentTarget;
						button.disabled = true;
						try {
							await this.saveStyle(entry, address, "");
							this.previewStyle(entry, "");
							button.closest(".tcb-overlay").remove();
						} catch {
							button.disabled = false;
						}
					},
				}),
			],
		});
	}

	// Applies styling in the browser the same way the Worker will: by wrapping
	// the run in a span. The wrapper is marked as editor chrome so the text
	// walk keeps ignoring it, and removed again when the styling is cleared.
	previewStyle(entry, css) {
		if (!css) {
			if (entry.styleWrap && entry.styleWrap.parentNode) {
				entry.styleWrap.parentNode.insertBefore(entry.node, entry.styleWrap);
				entry.styleWrap.parentNode.removeChild(entry.styleWrap);
			}
			entry.styleWrap = null;
			return;
		}
		if (!entry.styleWrap || !entry.styleWrap.isConnected) {
			const wrap = chrome("span", { class: "tcb-styled" });
			entry.node.parentNode.insertBefore(wrap, entry.node);
			wrap.appendChild(entry.node);
			entry.styleWrap = wrap;
		}
		entry.styleWrap.setAttribute("style", css);
	}

	async saveStyle(entry, address, css) {
		const previous = this.rows.get(address);
		try {
			await api("save", {
				method: "POST",
				body: JSON.stringify({ path: PATH, address, original: entry.original, value: css }),
			});
		} catch (error) {
			this.toast(error.message, "error");
			throw error;
		}
		const row = previous || { address, kind: "style", original: entry.original, published: null };
		row.draft = css;
		this.rows.set(address, row);
		this.markEdited(entry);
		this.refreshStatus();
	}

	// -- SEO check ------------------------------------------------------------

	// Checks the page in front of you rather than the whole site. A survey of
	// all 134 pages found five issues, two of them on the staff dashboard,
	// which has no business being in Google anyway -- so a bulk audit would
	// mostly report that everything is fine. What changed is that this editor
	// can now rewrite titles and descriptions, so the useful thing is catching
	// a problem being introduced, on the page where it is being introduced.
	openSeoCheck() {
		// The editor's own chrome is excluded, or its buttons would be counted
		// as links with unhelpful text.
		const page = summarisePage(document, `[data-tcb-editor], [${IGNORED_SUBTREE_ATTR}]`);

		// The title and description come from the stored edit rather than from
		// the document, when one exists.
		//
		// This used to read document.title, which gave different answers for
		// the same page depending on history: saving in Page settings assigns
		// document.title, so the check saw the new wording -- but after a
		// reload it saw the file's wording again, because edit mode serves the
		// page unedited. Worse, whichever it happened to see was presented as
		// simple fact, so a draft title could read as "nothing to fix" here
		// while the whole-site scan, which only ever sees published content,
		// reported the old one as a problem. Two panels contradicting each
		// other with no way to tell which was right.
		const draftFields = [];
		for (const [address, label] of [[META_TITLE_ADDRESS, "title"], [META_DESCRIPTION_ADDRESS, "description"]]) {
			const row = this.rows.get(address);
			if (!row) continue;
			const value = row.draft ?? row.published;
			if (value === null || value === undefined) continue;
			page[label] = value;
			if (row.draft !== null && row.draft !== undefined) draftFields.push(label);
		}

		const findings = checkSeo(page);

		const list = el("div", { class: "tcb-findings" });
		for (const finding of findings) {
			list.appendChild(
				el("div", { class: `tcb-finding tcb-finding-${finding.level.replace(/\s+/g, "-")}` }, [
					el("span", { class: "tcb-finding-level", text: finding.level }),
					el("div", {}, [
						el("p", { class: "tcb-finding-message", text: finding.message }),
						...(finding.detail ? [el("p", { class: "tcb-hint", text: finding.detail })] : []),
						...(finding.fix ? [el("p", { class: "tcb-finding-fix", text: finding.fix })] : []),
					]),
				])
			);
		}

		const problems = findings.filter((finding) => finding.level === "problem").length;
		const looks = findings.filter((finding) => finding.level === "worth a look").length;

		this.openDialog(
			"SEO check",
			[
				el("p", {
					class: "tcb-hint",
					text: problems || looks
						? `${problems} to fix, ${looks} worth a look on this page.`
						: "Nothing to fix on this page.",
				}),
				this.buildGooglePreview(page),
				list,
				this.buildSearchConsole(),
				this.buildSiteScan(),
			],
			null,
			{ confirmLabel: null, cancelLabel: "Close" }
		);
	}

	// What people actually searched for, from Search Console.
	//
	// Everything else in this panel is an opinion about the page. This is the
	// only part that reports what happened. It loads on a button rather than
	// when the panel opens, because it is two requests to Google and most
	// visits to this panel are about the sentence being edited, not about
	// last month's traffic.
	buildSearchConsole() {
		const status = el("p", { class: "tcb-hint" });
		const results = el("div", { class: "tcb-findings" });
		const button = el("button", { type: "button", class: "tcb-btn", text: "What people searched" });

		const number = (value) => Math.round(value).toLocaleString();
		const percent = (value) => `${(value * 100).toFixed(1)}%`;

		// A table of query, clicks, impressions and position. Position is
		// rounded to one place because Search Console's is an average, and
		// showing it to four decimals implies a precision it does not have.
		const queryTable = (rows) => {
			const table = el("div", { class: "tcb-sc-table" });
			table.appendChild(
				el("div", { class: "tcb-sc-row tcb-sc-head" }, [
					el("span", { text: "Search" }),
					el("span", { text: "Clicks" }),
					el("span", { text: "Shown" }),
					el("span", { text: "Position" }),
				])
			);
			for (const row of rows) {
				table.appendChild(
					el("div", { class: "tcb-sc-row" }, [
						el("span", { class: "tcb-sc-term", text: row.key }),
						el("span", { text: number(row.clicks) }),
						el("span", { text: number(row.impressions) }),
						el("span", { text: row.position.toFixed(1) }),
					])
				);
			}
			return table;
		};

		button.addEventListener("click", async () => {
			button.disabled = true;
			results.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = "Asking Google…";

			let page;
			let site;
			try {
				[page, site] = await Promise.all([
					api(`/api/seo/search-console?path=${encodeURIComponent(PATH)}`),
					api("/api/seo/search-console"),
				]);
			} catch (error) {
				button.disabled = false;
				status.className = "tcb-hint tcb-hint-warn";
				if (error.body && error.body.needsSetup) {
					status.textContent = "Search Console isn't connected yet. It takes about ten minutes, once.";
					const steps = el("ol", { class: "tcb-sc-steps" });
					for (const step of error.body.steps || []) steps.appendChild(el("li", { text: step }));
					results.appendChild(steps);
					results.appendChild(
						el("p", {
							class: "tcb-hint",
							text: "The last step is the one people miss — creating the key does not by itself grant access to anything.",
						})
					);
					return;
				}
				status.textContent = error.message;
				return;
			}

			button.disabled = false;
			button.textContent = "Check again";
			status.textContent = `${site.window.startDate} to ${site.window.endDate}. Google's figures stop a few days short of today.`;

			// This page first: whoever opened this panel is editing this page.
			results.appendChild(
				el("div", { class: "tcb-finding" }, [
					el("div", {}, [
						el("p", {
							class: "tcb-finding-message",
							text: page.totals.impressions
								? `This page: ${number(page.totals.clicks)} clicks from ${number(page.totals.impressions)} times shown (${percent(page.totals.ctr)}).`
								: "This page had no search traffic in this period.",
						}),
						...(page.queries.length
							? [queryTable(page.queries.slice(0, 10))]
							: [el("p", { class: "tcb-hint", text: "Nothing to show — it may be new, or not indexed yet." })]),
					]),
				])
			);

			// Where rewriting a title would pay. This is the whole reason the
			// panel exists: the shortlist is actionable in this editor.
			if (site.opportunities.missed.length) {
				const list = el("div", { class: "tcb-sc-table" });
				for (const row of site.opportunities.missed) {
					list.appendChild(
						el("div", { class: "tcb-sc-row" }, [
							el("a", { class: "tcb-scan-link", href: `${pathOf(row.key)}?edit=1`, text: pathOf(row.key) }),
							el("span", { text: number(row.clicks) }),
							el("span", { text: number(row.impressions) }),
							el("span", { text: percent(row.ctr) }),
						])
					);
				}
				results.appendChild(
					el("div", { class: "tcb-finding tcb-finding-worth-a-look" }, [
						el("span", { class: "tcb-finding-level", text: "worth a look" }),
						el("div", {}, [
							el("p", {
								class: "tcb-finding-message",
								text: "Shown often, clicked rarely. The title and description are all anyone sees before deciding — and both are editable here.",
							}),
							list,
						]),
					])
				);
			}

			// Searches sitting at the top of page two.
			if (site.opportunities.nearlyThere.length) {
				results.appendChild(
					el("div", { class: "tcb-finding tcb-finding-worth-a-look" }, [
						el("span", { class: "tcb-finding-level", text: "worth a look" }),
						el("div", {}, [
							el("p", {
								class: "tcb-finding-message",
								text: "Just off the first page. Google already thinks you are relevant for these and almost nobody is seeing you.",
							}),
							queryTable(site.opportunities.nearlyThere),
						]),
					])
				);
			}

			if (site.queries.length) {
				results.appendChild(
					el("div", { class: "tcb-finding" }, [
						el("div", {}, [
							el("p", { class: "tcb-finding-message", text: "Across the whole site, what people searched:" }),
							queryTable(site.queries.slice(0, 15)),
						]),
					])
				);
			}
		});

		return el("div", { class: "tcb-sync" }, [
			el("p", { class: "tcb-sync-title", text: "What people actually searched" }),
			el("p", {
				class: "tcb-hint",
				text: "From Google Search Console — the real phrases people typed, not a guess about them. Last 28 days.",
			}),
			button,
			status,
			results,
		]);
	}

	// Checks every page in sitemap.xml, a slice at a time.
	//
	// Batched rather than done in one call: 134 pages is far too much parsing
	// for a single Worker invocation, and asking for a slice at a time means a
	// slow scan is a longer scan rather than a failed one. Progress is shown
	// because a silent thirty-second wait reads as a hang.
	buildSiteScan() {
		const status = el("p", { class: "tcb-hint" });
		const siteResults = el("div", { class: "tcb-findings" });
		const results = el("div", { class: "tcb-findings" });
		const button = el("button", { type: "button", class: "tcb-btn", text: "Check every page" });

		button.addEventListener("click", async () => {
			button.disabled = true;
			results.replaceChildren();
			siteResults.replaceChildren();
			const pages = [];
			// What each page said, as opposed to what was wrong with it. Kept
			// because the cross-page checks -- duplicate titles, broken links,
			// pages nothing links to -- cannot be answered a page at a time.
			const scanned = [];
			let offset = 0;
			let total = 0;
			let complete = false;

			try {
				for (;;) {
					const batch = await api(`/api/seo/scan?offset=${offset}&limit=10`);
					total = batch.total;
					pages.push(...batch.results);
					scanned.push(...(batch.pages || []));
					offset += batch.scanned;
					status.className = "tcb-hint";
					status.textContent = `Checked ${offset} of ${total} pages… ${pages.length} with something to look at.`;
					if (batch.done || !batch.scanned) {
						complete = Boolean(batch.done);
						break;
					}
				}
			} catch (error) {
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				button.disabled = false;
				return;
			}

			// Only the destinations nothing has already confirmed. Every page
			// in the sitemap was just read, so the leftovers are the PDFs, the
			// odd unlisted page, and anything that no longer exists.
			let broken = [];
			try {
				// Pages that failed to load count as known too. They are already
				// reported as "in the sitemap but does not load", and fetching
				// them again would report the same page twice under two
				// different headings.
				const remaining = unverifiedTargets(scanned, [
					...scanned.map((page) => page.path),
					...pages.map((page) => page.path),
				]);
				for (let at = 0; at < remaining.length; at += 40) {
					status.textContent = `Checking ${remaining.length} links…`;
					const batch = await api("/api/seo/links", {
						method: "POST",
						body: JSON.stringify({ targets: remaining.slice(at, at + 40) }),
					});
					broken.push(...(batch.broken || []));
				}
			} catch {
				// A failed link check should not throw away a completed page
				// scan. The page findings are still worth showing, so this
				// falls through with nothing reported rather than nothing at all.
				broken = [];
			}

			const siteFindings = checkSite({ pages: scanned, broken, complete });
			if (siteFindings.length) {
				siteResults.appendChild(el("p", { class: "tcb-sync-title", text: "Across the whole site" }));
			}
			for (const finding of siteFindings) {
				siteResults.appendChild(
					el("div", { class: `tcb-finding tcb-finding-${finding.level.replace(/\s+/g, "-")}` }, [
						el("span", { class: "tcb-finding-level", text: finding.level }),
						el("div", {}, [
							el("p", { class: "tcb-finding-message", text: finding.message }),
							...(finding.detail ? [el("p", { class: "tcb-hint", text: finding.detail })] : []),
							...(finding.fix ? [el("p", { class: "tcb-finding-fix", text: finding.fix })] : []),
							...(finding.pages && finding.pages.length
								? [
										el(
											"div",
											{ class: "tcb-scan-pages" },
											finding.pages.slice(0, 6).map((path) =>
												el("a", { class: "tcb-scan-link", href: `${path}?edit=1`, text: path })
											)
										),
								  ]
								: []),
						]),
					])
				);
			}

			button.disabled = false;
			button.textContent = "Check again";

			if (!pages.length && !siteFindings.length) {
				status.className = "tcb-hint";
				status.textContent = `All ${total} pages checked. Nothing to fix.`;
				return;
			}

			if (!pages.length) {
				status.className = "tcb-hint";
				status.textContent = `All ${total} pages checked. Nothing wrong on any single page, but see below.`;
				return;
			}

			// Worst first, so the top of the list is the part worth acting on.
			const weight = (page) => (page.findings.some((finding) => finding.level === "problem") ? 0 : 1);
			pages.sort((a, b) => weight(a) - weight(b));

			const problemPages = pages.filter((page) => weight(page) === 0).length;
			const across = siteFindings.length ? ` Plus ${siteFindings.length} across the site as a whole.` : "";
			status.textContent = `${total} pages checked. ${problemPages} with something to fix, ${pages.length - problemPages} worth a look.${across}`;

			for (const page of pages) {
				const findings = el("div", { class: "tcb-scan-findings" });
				for (const finding of page.findings) {
					findings.appendChild(
						el("p", { class: `tcb-finding-message tcb-scan-${finding.level.replace(/\s+/g, "-")}`, text: finding.message })
					);
				}
				results.appendChild(
					el("div", { class: "tcb-scan-page" }, [
						el("a", { class: "tcb-scan-link", href: `${page.path}?edit=1`, text: page.path }),
						findings,
					])
				);
			}
		});

		return el("div", { class: "tcb-sync" }, [
			el("p", { class: "tcb-sync-title", text: "The whole site" }),
			el("p", {
				class: "tcb-hint",
				text: "Checks every page listed in the sitemap — the same list Google crawls — then the links between them. Takes a moment; you can watch it go.",
			}),
			button,
			status,
			siteResults,
			results,
		]);
	}

	// What the page is likely to look like in a result. A character count is
	// abstract; seeing the sentence cut off mid-word is not.
	buildGooglePreview(page) {
		const preview = googlePreview(page, location.origin, PATH);
		return el("div", { class: "tcb-serp" }, [
			el("p", { class: "tcb-hint", text: "Roughly how this page looks in Google:" }),
			el("p", { class: "tcb-serp-url", text: preview.url }),
			el("p", { class: `tcb-serp-title${preview.titleTruncated ? " tcb-serp-cut" : ""}`, text: preview.title }),
			el("p", { class: `tcb-serp-desc${preview.descriptionTruncated ? " tcb-serp-cut" : ""}`, text: preview.description }),
		]);
	}

	// -- page title and description ------------------------------------------

	openPageSettings() {
		const titleRow = this.rows.get(META_TITLE_ADDRESS);
		const descriptionRow = this.rows.get(META_DESCRIPTION_ADDRESS);
		const descriptionMeta = document.querySelector('meta[name="description"]');

		const titleInput = el("input", { type: "text", class: "tcb-input" });
		titleInput.value = (titleRow && (titleRow.draft ?? titleRow.published)) || document.title || "";

		const descriptionInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "3" });
		descriptionInput.value =
			(descriptionRow && (descriptionRow.draft ?? descriptionRow.published)) ||
			(descriptionMeta && descriptionMeta.getAttribute("content")) ||
			"";

		// Live feedback as you type. This is where an SEO problem would
		// actually get introduced, so it is worth more here than in any
		// after-the-fact report -- and a result preview showing the sentence
		// cut off mid-word means more than a character count.
		const counts = el("p", { class: "tcb-hint" });
		const serp = el("div", {});
		const refreshPreview = () => {
			const draft = { title: titleInput.value, description: descriptionInput.value };
			const titleLength = draft.title.trim().length;
			const descriptionLength = draft.description.trim().length;
			counts.textContent =
				`Title ${titleLength} characters (Google cuts around ${TITLE_MAX}), ` +
				`description ${descriptionLength} (cuts around ${DESCRIPTION_MAX}).`;
			counts.className =
				titleLength > TITLE_MAX || descriptionLength > DESCRIPTION_MAX ? "tcb-hint tcb-hint-warn" : "tcb-hint";
			serp.replaceChildren(this.buildGooglePreview(draft));
		};
		titleInput.addEventListener("input", refreshPreview);
		descriptionInput.addEventListener("input", refreshPreview);
		refreshPreview();

		this.openDialog(
			"Page title & description",
			[
				el("p", { class: "tcb-hint", text: "This is what shows up as the heading and blurb in Google results." }),
				el("label", { class: "tcb-label" }, [el("span", { text: "Page title" }), titleInput]),
				this.buildSuggestions("title", titleInput, refreshPreview),
				el("label", { class: "tcb-label" }, [el("span", { text: "Description" }), descriptionInput]),
				this.buildSuggestions("description", descriptionInput, refreshPreview),
				counts,
				serp,
			],
			async () => {
				const title = titleInput.value.trim();
				const description = descriptionInput.value.trim();
				if (!title) throw new Error("The page title can't be empty.");
				await this.saveMeta(META_TITLE_ADDRESS, title, document.title || "");
				await this.saveMeta(
					META_DESCRIPTION_ADDRESS,
					description,
					(descriptionMeta && descriptionMeta.getAttribute("content")) || ""
				);
				document.title = title;
				if (descriptionMeta) descriptionMeta.setAttribute("content", description);
			}
		);
	}

	// "Suggest one" next to the title and description fields.
	//
	// Clicking a suggestion fills the field. It does not save: the field is
	// still a field, still editable, and still has to be saved and published
	// like anything else. Nothing written here reaches the site without going
	// through the same two deliberate steps as a hand-typed change.
	buildSuggestions(kind, input, onPick) {
		const status = el("p", { class: "tcb-hint" });
		const options = el("div", { class: "tcb-suggestions" });
		const button = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Suggest one" });
		// Somewhere to push back. Without this the only response to a weak
		// suggestion is to press the button again and hope, which is a poor
		// way to spend anyone's afternoon.
		const steer = el("input", {
			type: "text",
			class: "tcb-input tcb-input-small",
			placeholder: "Anything to mention? e.g. mention Tuggeranong, lead with termites",
		});

		button.addEventListener("click", async () => {
			button.disabled = true;
			options.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = "Writing a few options…";

			let result;
			try {
				result = await api("/api/seo/suggest", {
					method: "POST",
					body: JSON.stringify({ kind, path: PATH, steer: steer.value.trim() }),
				});
			} catch (error) {
				button.disabled = false;
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				return;
			}

			button.disabled = false;
			button.textContent = "Suggest more";

			if (!result.candidates.length) {
				// Never silently empty. Everything having been thrown out is a
				// real outcome with a real reason, and "nothing happened" reads
				// as a broken button.
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = result.rejected.length
					? `Every suggestion was thrown out — ${result.rejected[0].reason}. Worth trying again.`
					: "Nothing came back. Worth trying again.";
				return;
			}

			status.textContent = result.usedSearches
				? `Written from this page, ${result.usedExamples} other pages for the house style, and the ${result.usedSearches} searches people used to find it. Click one to use it.`
				: `Written from this page and ${result.usedExamples} other pages for the house style. Click one to use it.`;

			for (const candidate of result.candidates) {
				const option = el("button", { type: "button", class: "tcb-suggestion" }, [
					el("span", { class: "tcb-suggestion-text", text: candidate }),
					el("span", { class: "tcb-suggestion-count", text: `${candidate.length}` }),
				]);
				option.addEventListener("click", () => {
					input.value = candidate;
					onPick();
					input.focus();
				});
				options.appendChild(option);
			}

			// What was thrown away and why. Hidden behind a summary because it
			// is not usually interesting -- but when the survivors are dull,
			// the reason is often that the good ones broke the no-invention
			// rule, and there is no way to know that without being shown.
			if (result.rejected.length) {
				const details = el("details", { class: "tcb-rejected" }, [
					el("summary", { text: `${result.rejected.length} thrown out` }),
					...result.rejected.map((entry) =>
						el("p", { class: "tcb-hint", text: `“${entry.text}” — ${entry.reason}` })
					),
				]);
				options.appendChild(details);
			}
		});

		return el("div", { class: "tcb-suggest-row" }, [button, steer, status, options]);
	}

	async saveMeta(address, value, original) {
		if (!value) return;
		await api("save", { method: "POST", body: JSON.stringify({ path: PATH, address, original, value }) });
		const row = this.rows.get(address) || { address, kind: "meta", original, published: null };
		row.draft = value;
		this.rows.set(address, row);
		this.refreshStatus();
	}

	// Drops the override entirely, so the page falls back through to whatever
	// the HTML file says. Shared by the change list and by the marker left in
	// place of deleted text. Rethrows so callers can leave their button
	// enabled if it failed.
	async revertEdit(address) {
		try {
			await api("revert", { method: "POST", body: JSON.stringify({ path: PATH, address }) });
		} catch (error) {
			this.toast(error.message, "error");
			throw error;
		}
		const entry = this.entries.get(address);
		if (entry) {
			if (entry.kind === "text") {
				entry.node.nodeValue = entry.originalRaw;
				this.refreshDeletedMarker(entry, entry.original);
			} else {
				entry.element.setAttribute(entry.attr, entry.original);
			}
			this.unmarkEdited(entry);
		}
		this.rows.delete(address);
		this.refreshStatus();
		this.toast("Reverted to the original wording.");
	}

	// -- change list ----------------------------------------------------------

	openChanges() {
		const list = el("div", { class: "tcb-changes" });
		const rows = [...this.rows.values()].filter(
			(row) => (row.draft !== null && row.draft !== undefined) || (row.published !== null && row.published !== undefined)
		);

		if (!rows.length) {
			list.appendChild(el("p", { class: "tcb-hint", text: "No changes on this page yet." }));
		}

		for (const row of rows) {
			const pending = row.draft !== null && row.draft !== undefined;
			const value = pending ? row.draft : row.published;
			// A synced row is live *and* written into the files, which is the
			// end state -- worth distinguishing from one that is only live.
			const inCode = !pending && row.synced_at;
			const tagText = pending ? "Draft" : inCode ? "In code" : "Live";
			const tagClass = pending ? "tcb-tag-draft" : inCode ? "tcb-tag-code" : "tcb-tag-live";
			list.appendChild(
				el("div", { class: "tcb-change" }, [
					el("span", { class: `tcb-tag ${tagClass}`, text: tagText }),
					el("div", { class: "tcb-change-body" }, [
						el("p", { class: "tcb-change-was", text: row.original || "(page setting)" }),
						el("p", {
							// An empty value means the words were deleted. Rendering that
							// as a blank line would make the change list look broken.
							class: value === "" ? "tcb-change-now tcb-change-gone" : "tcb-change-now",
							text: value === "" ? "(deleted)" : row.kind === "style" ? describeStyle(value) : value,
						}),
					]),
					el("button", {
						type: "button",
						class: "tcb-btn tcb-btn-quiet",
						text: "Revert",
						onclick: async (event) => {
							const button = event.currentTarget;
							button.disabled = true;
							const change = button.closest(".tcb-change");
							try {
								await this.revertEdit(row.address);
								if (change) change.remove();
							} catch {
								button.disabled = false;
							}
						},
					}),
				])
			);
		}

		this.openDialog("Changes on this page", [list, this.buildSyncPanel()], null, {
			confirmLabel: null,
			cancelLabel: "Close",
		});
	}

	// "Sync to code" lives here rather than in the toolbar for two reasons: the
	// toolbar is already full, and this acts on every published edit across the
	// whole site, not just this page -- so it belongs next to the change list
	// rather than next to the per-page Publish button.
	buildSyncPanel() {
		const status = el("p", { class: "tcb-hint" });
		const button = el("button", { type: "button", class: "tcb-btn", text: "Sync to code" });

		const setBusy = (busy, label) => {
			button.disabled = busy;
			button.textContent = label || "Sync to code";
		};

		button.addEventListener("click", async () => {
			setBusy(true, "Syncing…");
			status.className = "tcb-hint";
			status.textContent = "Writing your published changes into the site's code…";
			try {
				const result = await api("sync", { method: "POST", body: JSON.stringify({}) });
				if (!result.files) {
					status.textContent = result.message || "Everything is already in the code.";
				} else {
					status.textContent = `Done — ${result.edits} ${result.edits === 1 ? "change" : "changes"} written into ${
						result.files
					} ${result.files === 1 ? "file" : "files"}. The site itself doesn't change; the code just caught up.`;
				}
				if (result.problems && result.problems.length) {
					// Anything unmatched is left live on purpose. The reasons are
					// listed rather than counted: "3 were skipped" gives nobody
					// anything to act on, and when the cause is a permissions
					// problem rather than an edited file, a count actively misleads.
					status.className = "tcb-hint tcb-hint-warn";
					status.textContent += ` ${result.problems.length} left alone — ${result.problems
						.slice(0, 3)
						.join("; ")}${result.problems.length > 3 ? " …" : ""}`;
				}
			} catch (error) {
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
			} finally {
				setBusy(false);
			}
		});

		return el("div", { class: "tcb-sync" }, [
			el("p", { class: "tcb-sync-title", text: "Keep the code in step" }),
			el("p", {
				class: "tcb-hint",
				text:
					"Your published changes are live already. This folds them into the site's underlying files so the two " +
					"don't drift apart. It changes nothing visitors can see — run it whenever you think of it.",
			}),
			button,
			status,
		]);
	}

	// -- publishing -----------------------------------------------------------

	async publish() {
		if (this.busy) return;
		this.busy = true;
		this.publishButton.disabled = true;
		this.publishButton.textContent = "Publishing…";
		try {
			const result = await api("publish", { method: "POST", body: JSON.stringify({ path: PATH }) });
			this.toast(`Published ${result.published} ${result.published === 1 ? "change" : "changes"}. It's live now.`);
			for (const row of this.rows.values()) {
				if (row.draft !== null && row.draft !== undefined) {
					row.published = row.draft;
					row.draft = null;
				}
			}
		} catch (error) {
			this.toast(error.message, "error");
		} finally {
			this.busy = false;
			this.publishButton.textContent = "Publish";
			this.refreshStatus();
		}
	}

	// -- dialog ---------------------------------------------------------------

	openDialog(
		title,
		content,
		onConfirm,
		{ confirmLabel = "Save", cancelLabel = "Cancel", onCancel = null, extraActions = [] } = {}
	) {
		const body = el("div", { class: "tcb-dialog-body" }, content);
		const error = el("p", { class: "tcb-dialog-error" });
		error.hidden = true;

		const actions = el("div", { class: "tcb-dialog-actions" });
		const close = () => overlay.remove();
		// The style panel changes the page live as you touch the controls, so
		// dismissing it has to undo that -- otherwise Cancel would leave the
		// page showing something that was never saved.
		const dismiss = () => {
			if (onCancel) onCancel();
			close();
		};
		for (const action of extraActions) actions.appendChild(action);
		actions.appendChild(el("button", { type: "button", class: "tcb-btn tcb-btn-quiet", text: cancelLabel, onclick: dismiss }));
		if (confirmLabel && onConfirm) {
			const confirm = el("button", { type: "button", class: "tcb-btn tcb-btn-primary", text: confirmLabel });
			confirm.addEventListener("click", async () => {
				confirm.disabled = true;
				error.hidden = true;
				try {
					await onConfirm();
					close();
					this.toast("Saved as a draft. Publish when you're ready.");
				} catch (problem) {
					error.textContent = problem.message;
					error.hidden = false;
					confirm.disabled = false;
				}
			});
			actions.appendChild(confirm);
		}

		const panel = el("div", { class: "tcb-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
			el("h2", { class: "tcb-dialog-title", text: title }),
			body,
			error,
			actions,
		]);
		const overlay = chrome("div", { class: "tcb-overlay" }, [panel]);
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) dismiss();
		});
		document.addEventListener("keydown", function onKey(event) {
			if (event.key === "Escape") {
				dismiss();
				document.removeEventListener("keydown", onKey);
			}
		});
		document.body.appendChild(overlay);
		const firstInput = panel.querySelector("input, textarea");
		if (firstInput) firstInput.focus();
		return panel;
	}
}

// Bootstrap. Deliberately the last statement in the file -- see the note on
// start() at the top for why it can't live up there.
const root = document.querySelector('[data-tcb-editor="root"]');
if (root) start(root.dataset.tcbMode || "browse");
