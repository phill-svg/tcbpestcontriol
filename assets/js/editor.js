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

// What that click just cost, when it cost anything.
//
// The free models report nothing and this stays empty, which is the common
// case. When Claude answered, the figure goes next to the suggestions rather
// than into a monthly total -- a cent is only worth knowing about at the
// moment you are deciding whether to press the button again, and by the time
// it turns up on a bill it is far too late to be interesting.
function priceNote(result) {
	if (typeof result.cost !== "number" || !result.cost) return "";
	const cents = result.cost * 100;
	return ` Cost ${cents < 1 ? "under a cent" : `about ${cents.toFixed(1)}c`}.`;
}

// Which model actually answered, and whether that is the one that was asked
// for. The second half is the part that earns its place: a paid model that
// fails falls back to a free one on purpose, and without this the panel looked
// identical either way -- so a broken API key, an empty account or a rejected
// request would read as "Claude wrote this" indefinitely.
function modelNote(result) {
	if (!result.label) return "";
	if (result.asked) {
		return ` ${result.asked} could not answer, so ${result.label} wrote these instead${result.fellBack ? ` (${result.fellBack})` : ""}.`;
	}
	return ` Written by ${result.label}.`;
}

// A service name from a search phrase: "borer control canberra" is not a
// heading, and neither is "Borer Control Canberra" -- the city belongs in the
// title and the breadcrumb, not in the name of the service.
function titleCase(query) {
	return String(query || "")
		.replace(/\b(canberra|act|near me)\b/gi, "")
		.trim()
		.replace(/\s+/g, " ")
		.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// The address the page will live at. Mirrors serviceSlug() on the server,
// which is the one that actually decides -- this only fills the box, and the
// server refuses anything it does not like rather than trusting this.
function slugFrom(name) {
	// Trimmed by hand rather than with /^-+|-+$/, matching serviceSlug on the
	// server. The pattern is the one the security scan objected to there, and
	// keeping a copy of it here because "this side only fills a box" is how a
	// fixed thing comes back.
	const cleaned = String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	let start = 0;
	let end = cleaned.length;
	while (start < end && cleaned[start] === "-") start += 1;
	while (end > start && cleaned[end - 1] === "-") end -= 1;
	return cleaned.slice(start, end);
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
// A picture file, as WebP, base64, ready to post.
//
// The longest edge is capped because a phone photo is 4000px wide and no
// image on this site is displayed above about 1600 -- sending the original
// would spend a megabyte to show the same picture. Quality 0.82 is where WebP
// stops being visibly lossy for photographs.
const MAX_IMAGE_EDGE = 1600;

async function toWebpBase64(file) {
	if (!file.type.startsWith("image/")) throw new Error("That is not a picture.");

	let bitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new Error("That picture could not be read. A JPEG or PNG works best.");
	}

	const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
	// A browser that cannot write WebP hands back a PNG under the same call,
	// silently. The server would refuse it on its magic bytes, which is the
	// right answer but an obscure one to receive -- so say it here instead.
	if (!blob || blob.type !== "image/webp") throw new Error("This browser cannot make WebP images. Try Chrome, Edge or Safari.");

	const reader = new FileReader();
	const dataUrl = await new Promise((resolve, reject) => {
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("That picture could not be read."));
		reader.readAsDataURL(blob);
	});
	return String(dataUrl).slice(String(dataUrl).indexOf(",") + 1);
}

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

// The blocks layout mode can move, add and remove. Deliberately the same list
// as BLOCK_TAGS in src/page-structure.js: the browser numbers them here and
// the server resolves those numbers against the file, so a disagreement about
// what counts as a block would silently act on the wrong one.
//
// A <section> or a <div> is scaffolding rather than content -- moving one
// would take everything inside it along, which is a different feature.
// Cards are matched by class rather than tag: a <div> here is usually
// scaffolding, and a .grid-card is usually the thing somebody wants to move.
// Must match BLOCK_TAGS and BLOCK_CLASSES in src/page-structure.js.
const BLOCK_SELECTOR = "p,h2,h3,h4,h5,h6,li,img,.grid-card";

// The row a card sits in, and the widths it can be. Every one collapses to a
// single column on a phone -- these choose what happens above that.
const ROW_SELECTOR = ".grid-cards";
const COLUMN_CLASSES = ["cols-2", "cols-3", "cols-4"];

// Side-by-side rows, and how their two halves line up when one is taller.
// Must match ALIGN_CLASSES and isAlignRow in src/page-structure.js.
const ALIGN_ROW_SELECTOR = ".split-media-grid, .section-head.split";
const ALIGN_CLASSES = { top: "align-top", middle: "align-middle", bottom: "align-bottom" };

// Navigation inside <main> -- the breadcrumb every page opens with. Its items
// are links to other pages, not words on this one. Must match BLOCK_SKIP_TAGS
// in src/page-structure.js, or the two sides number the blocks differently.
const BLOCK_SKIP_SELECTOR = "nav";


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
		this.undoStack = []; // this visit only -- see pushUndo
	}

	async mount() {
		// Before anything is injected and before any stored value is painted on,
		// so the numbering matches the file rather than the screen.
		this.indexBlocks();
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
		this.bindDragTargets();
		this.bindUndo();
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
		// Layout mode is a mode rather than another hover control: it changes what
		// a click on the page means, and the two would fight if both were live at
		// once. Its changes go into the file, not the overlay, so it keeps its own
		// Save rather than sharing Publish.
		this.layoutButton = el("button", {
			type: "button",
			class: "tcb-btn",
			text: "Layout",
			onclick: () => this.toggleLayoutMode(),
		});
		this.saveLayoutButton = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-primary",
			text: "Save layout",
			onclick: () => this.saveLayout(),
		});
		this.saveLayoutButton.disabled = true;

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
				el("button", { type: "button", class: "tcb-btn", text: "Menu", onclick: () => this.openMenuEditor() }),
				// It used to live only inside the Changes dialog, where nobody
				// looking for it would think to look.
				el("button", { type: "button", class: "tcb-btn", text: "Sync to code", onclick: () => this.openSync() }),
				this.layoutButton,
				this.saveLayoutButton,
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
		// Layout mode writes its own count into the same line and must not be
		// overwritten by a save that happens while it is on.
		if (this.layoutMode) return this.refreshLayoutStatus();
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

	bindUndo() {
		document.addEventListener("keydown", (event) => {
			const chord = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
			if (!chord || event.key.toLowerCase() !== "z") return;
			// Inside a field, the browser's own undo is the right one.
			if (this.active) return;
			const inForm = event.target && event.target.closest && event.target.closest("input,textarea,select,[contenteditable]");
			if (inForm) return;
			event.preventDefault();
			this.undoLast();
		});
	}

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
		// Layout mode owns clicks on the page while it is on -- its own
		// controls sit under each block, and opening a text field on top of
		// them would leave two different edits half-started at once.
		if (this.layoutMode) return;
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
		// The hover outline means "click to change these words", which is not
		// what a click does in layout mode -- there, the same pointer movement
		// drives the block toolbar instead.
		if (this.layoutMode) {
			this.hover.style.display = "none";
			this.trackLayoutHover(event);
			return;
		}
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
			const hadRow = this.rows.has(entry.address);
			const row = this.rows.get(entry.address) || { address: entry.address, kind: entry.kind, original: entry.original, published: null };
			row.draft = value;
			this.rows.set(entry.address, row);
			this.refreshStatus();
			// Undoing to the file's own words is a revert, not another save --
			// saving them back would store an override that says "leave this
			// exactly as the file already has it", which then has to be
			// published and synced to achieve nothing.
			this.pushUndo({
				label: "change",
				undo: async () => {
					if (!hadRow) return this.revertEdit(entry.address);
					this.renderValue(entry, previous);
					await this.save(entry, previous, value);
					// save() pushed its own entry for the undo we just performed.
					this.undoStack.pop();
				},
			});
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

		if (isImage) {
			const picker = dialog.querySelector(".tcb-picker");
			this.fillImagePicker(picker, valueInput, showPreview);
			picker.before(
				this.buildUploader((path) => {
					valueInput.value = path;
					showPreview(path);
				})
			);
		}
	}

	// The Worker can't list the assets directory at runtime, so the picker is
	// driven by a manifest generated at author time by
	// scripts/build-image-manifest.js. If it isn't there, the path box still
	// works on its own.
	// -- uploading a picture ---------------------------------------------------

	// Converted to WebP here, in the browser, before it is sent.
	//
	// Nothing in a Worker can run sharp, and src/assets.js only negotiates
	// AVIF for `/assets/images/*.webp` -- so a JPEG uploaded as a JPEG would
	// be the one picture on the site outside that arrangement, permanently.
	// canvas.toBlob does the conversion for free and the server checks the
	// result really is a WebP before it commits anything.
	//
	// `onDone(path)` gets the site path once the commit lands.
	buildUploader(onDone) {
		const input = el("input", { type: "file", accept: "image/*", class: "tcb-input" });
		const status = el("p", { class: "tcb-hint" });
		const button = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Upload a picture" });
		button.addEventListener("click", () => input.click());

		input.addEventListener("change", async () => {
			const file = input.files && input.files[0];
			input.value = "";
			if (!file) return;

			status.className = "tcb-hint";
			status.textContent = "Preparing the picture…";
			let base64;
			try {
				base64 = await toWebpBase64(file);
			} catch (error) {
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				return;
			}

			status.textContent = "Uploading…";
			try {
				const result = await api("upload-image", {
					method: "POST",
					body: JSON.stringify({ name: file.name, base64 }),
				});
				// The idempotent path -- same name, same bytes already on the
				// site -- answers without a commit, because there was nothing to
				// commit. Reading result.commit.url straight off would throw.
				status.textContent = result.existing
					? "That picture is already on the site. Using the copy that is there."
					: "Uploaded. It appears on the site once the rebuild finishes, a minute or two.";
				onDone(result.path);
			} catch (error) {
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
			}
		});

		return el("div", { class: "tcb-uploader" }, [button, input, status]);
	}

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

	// -- layout: adding and removing whole blocks -----------------------------

	// Numbers every block on the page, once, in document order.
	//
	// The number is the whole contract with the server, which resolves the same
	// number against the raw file. Two things keep them in step: the same tag
	// list on both sides, and the fact that nothing the Worker injects lands
	// inside <main> -- it sets an id there and nothing else, while the skip
	// link, search overlay and chat widget all go on <body>. The editor's own
	// additions do land inside, and they carry data-tcb-injected, which
	// SKIP_SELECTOR excludes.
	//
	// Frozen here and never recomputed. Every pending operation refers to the
	// page as it was loaded, whatever the screen has been rearranged into
	// since, which is what lets the server resolve a whole batch against one
	// document.
	indexBlocks() {
		const main = document.querySelector("main");
		this.blocks = main
			? [...main.querySelectorAll(BLOCK_SELECTOR)].filter((node) => !node.closest(SKIP_SELECTOR) && !node.closest(BLOCK_SKIP_SELECTOR))
			: [];
		this.layoutOps = [];
		this.layoutMode = false;
		this.hoveredBlock = -1;
		this.hoveredNode = null;
		// One operation per moved block, so dragging the same one twice is a
		// correction rather than a second instruction.
		this.movedBlocks = new Map();
		// Additions waiting to be saved, keyed by the preview element on the page,
		// so hovering one can find the change it belongs to.
		this.pendingAdditions = new Map();
		this.dragging = null;
	}

	// What the server should find at that number. If a deploy landed since this
	// page was loaded, the numbering describes a document that no longer
	// exists, and the first sign of it is the text not being what we named.
	expectFor(ordinal) {
		const node = this.blocks[ordinal];
		if (!node) return null;
		return { tag: node.tagName.toLowerCase(), text: normaliseText(node.textContent || "").slice(0, 40) };
	}

	toggleLayoutMode() {
		if (this.layoutMode) {
			// Anything pending is a real change to the page, so leaving is not a
			// silent discard: reload and it is gone, save and it is committed.
			if (this.layoutOps.length && !window.confirm("Leave layout mode? The changes you have not saved will be dropped.")) return;
			location.reload();
			return;
		}
		if (!this.blocks.length) {
			this.toast("There is nothing on this page that can be moved around.", "error");
			return;
		}
		this.layoutMode = true;
		document.body.classList.add("tcb-layout-mode");
		this.layoutButton.textContent = "Done";
		this.refreshLayoutStatus();
	}

	// One toolbar, floating over whichever block the pointer is on.
	//
	// The first version put a row of buttons under every block instead. On a
	// real page that is fifty rows of chrome at once, and inserting a <div>
	// after an <li> or inside a flex row rearranges the page you are trying to
	// look at -- the breadcrumb bar came apart. Nothing goes into the page's
	// own layout now: the toolbar is positioned over the block and the page is
	// left exactly as it renders.
	layoutToolbar() {
		if (this.toolbar) return this.toolbar;

		this.toolbarTag = el("span", { class: "tcb-block-tag" });
		this.toolbarRemove = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small tcb-btn-quiet",
			text: "Remove",
			onclick: () => this.removeBlock(),
		});

		// Only shown on a card, because only a row of cards has a width to set.
		this.toolbarWidth = el("span", { class: "tcb-toolbar-width" }, [
			el("span", { class: "tcb-block-tag", text: "across" }),
			...COLUMN_CLASSES.map((name) =>
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-small tcb-width-option",
					"data-cols": name,
					text: name.slice(-1),
					onclick: () => this.setRowColumns(name),
				})
			),
		]);
		this.toolbarWidth.hidden = true;

		// Only shown inside a side-by-side row.
		this.toolbarAlign = el("span", { class: "tcb-toolbar-width" }, [
			el("span", { class: "tcb-block-tag", text: "line up" }),
			...Object.keys(ALIGN_CLASSES).map((name) =>
				el("button", {
					type: "button",
					class: "tcb-btn tcb-btn-small tcb-align-option",
					"data-align": name,
					text: name[0].toUpperCase() + name.slice(1),
					onclick: () => this.setRowAlign(name),
				})
			),
		]);
		this.toolbarAlign.hidden = true;

		// Side by side. Hidden where it cannot apply -- see trackLayoutHover.
		this.toolbarBeside = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Add beside", onclick: () => this.addBlockAt("beside") });
		this.toolbarAbove = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Add above", onclick: () => this.addBlockAt("before") });
		this.toolbarBelow = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Add below", onclick: () => this.addBlockAt("after") });

		// For something added but not saved yet: it is not a block in the file, so
		// the ordinary controls do not apply to it -- but it has to be possible to
		// change your mind about it without undoing everything done since.
		this.toolbarChange = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small",
			text: "Change",
			onclick: () => {
				const pending = this.hoveredPending;
				if (pending) this.openAddBlock(pending.ordinal, pending.where, pending.node, { replacing: pending });
			},
		});
		this.toolbarDiscard = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small tcb-btn-quiet",
			text: "Remove",
			onclick: () => {
				if (this.hoveredPending) this.cancelAddition(this.hoveredPending);
			},
		});

		this.toolbar = chrome("div", { class: "tcb-block-toolbar" }, [
			this.toolbarTag,
			this.toolbarAbove,
			this.toolbarBelow,
			this.toolbarBeside,
			this.toolbarRemove,
			this.toolbarWidth,
			this.toolbarAlign,
			this.toolbarChange,
			this.toolbarDiscard,
		]);
		this.toolbar.hidden = true;
		// Kept over the block while the page scrolls under it.
		window.addEventListener("scroll", () => this.positionToolbar(), { passive: true });
		window.addEventListener("resize", () => this.positionToolbar(), { passive: true });
		document.body.appendChild(this.toolbar);
		return this.toolbar;
	}

	// Which block the pointer is over, if any. Called from the same mousemove
	// the hover outline uses, so layout mode costs no extra listener.
	trackLayoutHover(event) {
		// Something added but not yet saved takes priority: it is not in the
		// frozen block list at all, so without this branch it had no toolbar and
		// could only be taken back with Ctrl+Z, undoing everything after it too.
		const pendingNode = event.target && event.target.closest ? event.target.closest(".tcb-block-added") : null;
		const pending = pendingNode ? this.pendingAdditions.get(pendingNode) : null;
		if (pending) {
			if (this.hoveredPending === pending) return;
			if (this.hoveredNode) this.hoveredNode.classList.remove("tcb-block-hover");
			this.hoveredBlock = -1;
			this.hoveredPending = pending;
			this.hoveredNode = pendingNode;
			pendingNode.classList.add("tcb-block-hover");
			this.layoutToolbar();
			this.toolbarTag.textContent = "new";
			for (const button of [this.toolbarAbove, this.toolbarBelow, this.toolbarBeside, this.toolbarRemove]) button.hidden = true;
			this.toolbarWidth.hidden = true;
			this.toolbarAlign.hidden = true;
			this.toolbarChange.hidden = false;
			this.toolbarDiscard.hidden = false;
			this.toolbar.hidden = false;
			this.positionToolbar();
			return;
		}

		const target = event.target && event.target.closest ? event.target.closest(BLOCK_SELECTOR) : null;
		const ordinal = target ? this.blocks.indexOf(target) : -1;
		if (ordinal === -1) return;
		if (this.hoveredBlock === ordinal) return;

		this.hoveredPending = null;
		if (this.toolbar) {
			this.toolbarChange.hidden = true;
			this.toolbarDiscard.hidden = true;
			this.toolbarAbove.hidden = false;
			this.toolbarBelow.hidden = false;
			this.toolbarRemove.hidden = false;
		}

		if (this.hoveredNode) this.hoveredNode.classList.remove("tcb-block-hover");
		this.hoveredBlock = ordinal;
		this.hoveredNode = target;
		target.classList.add("tcb-block-hover");

		// Only whatever is under the pointer, so a drag anywhere else still
		// selects text the way it always did.
		this.makeDraggable(target);

		const toolbar = this.layoutToolbar();
		// "box" reads better than "div" for the one block that is a container,
		// and it is the word the row control uses too.
		const isCard = target.classList.contains("grid-card");
		this.toolbarTag.textContent = isCard ? "box" : target.tagName.toLowerCase();
		this.toolbarRemove.disabled = target.classList.contains("tcb-block-removed");

		// "Add beside" only where the server would accept it: not a list item,
		// not a box already in a row (add to the row instead), and not something
		// that already has a neighbour. The same rules as page-structure.js, so
		// the button is never offered for a save that would be refused.
		const inList = !!(target.parentElement && ["UL", "OL"].includes(target.parentElement.tagName));
		const alreadySplit = !!target.closest(".split-media-text, .split-media-image");
		this.toolbarBeside.hidden = inList || (isCard && !!target.closest(ROW_SELECTOR)) || alreadySplit;

		// A block that has just had something put beside it takes no further
		// change until the layout is saved: "below" it would mean inside its
		// new column here, and after the whole row in the saved file.
		const wrapped = target.dataset.tcbBeside === "1";
		for (const button of [this.toolbarAbove, this.toolbarBelow, this.toolbarBeside, this.toolbarRemove]) {
			if (wrapped) button.disabled = true;
		}
		if (!wrapped) {
			this.toolbarAbove.disabled = false;
			this.toolbarBelow.disabled = false;
			this.toolbarBeside.disabled = false;
		}

		const row = isCard ? target.closest(ROW_SELECTOR) : null;
		this.toolbarWidth.hidden = !row;
		if (row) {
			const current = COLUMN_CLASSES.find((name) => row.classList.contains(name));
			for (const button of this.toolbarWidth.querySelectorAll(".tcb-width-option")) {
				button.classList.toggle("tcb-width-current", button.dataset.cols === current);
			}
		}

		// A row made by "Add beside" is not in the file yet, so it has nothing
		// to line up until the layout is saved.
		const alignRow = wrapped ? null : target.closest(ALIGN_ROW_SELECTOR);
		this.toolbarAlign.hidden = !alignRow;
		if (alignRow) this.markAlign(alignRow);
		toolbar.hidden = false;
		this.positionToolbar();
	}

	positionToolbar() {
		if (!this.toolbar || this.toolbar.hidden || !this.hoveredNode) return;
		const box = this.hoveredNode.getBoundingClientRect();
		// Above the block where there is room, below it where there is not --
		// a toolbar off the top of the window is a toolbar you cannot press.
		const above = box.top > 44;
		this.toolbar.style.top = `${(above ? box.top - 38 : box.bottom + 6) + window.scrollY}px`;
		this.toolbar.style.left = `${Math.max(8, box.left) + window.scrollX}px`;
	}

	removeBlock() {
		const ordinal = this.hoveredBlock;
		const node = this.blocks[ordinal];
		if (!node || node.classList.contains("tcb-block-removed")) return;
		const op = { op: "delete", block: ordinal, expect: this.expectFor(ordinal) };
		this.layoutOps.push(op);
		node.classList.add("tcb-block-removed");
		this.toolbarRemove.disabled = true;
		this.pushUndo({
			label: "removal",
			undo: () => {
				node.classList.remove("tcb-block-removed");
				// Guarded: indexOf is -1 once the op is gone (a later drag of the
				// same block replaces it), and splice(-1, 1) would remove whichever
				// unrelated change happens to be last.
				if (this.layoutOps.includes(op)) this.layoutOps.splice(this.layoutOps.indexOf(op), 1);
				if (this.hoveredBlock === ordinal) this.toolbarRemove.disabled = false;
			},
		});
		this.refreshLayoutStatus();
	}

	// How many boxes go across the row this card is in.
	//
	// The width lives on the row, not on the card, so this is one change to one
	// element however many cards are in it -- and the preview applies it to the
	// live page immediately, because seeing three become four is the whole
	// point of choosing.
	setRowColumns(name) {
		const ordinal = this.hoveredBlock;
		const card = this.blocks[ordinal];
		const row = card && card.closest(ROW_SELECTOR);
		if (!row) return;

		const before = COLUMN_CLASSES.find((value) => row.classList.contains(value)) || "";
		if (before === name) return;
		row.classList.remove(...COLUMN_CLASSES);
		row.classList.add(name);

		// One operation per row. Choosing three then four is one instruction
		// about how wide it ends up, not two.
		const existing = this.layoutOps.find((op) => op.op === "columns" && this.blocks[op.block] && this.blocks[op.block].closest(ROW_SELECTOR) === row);
		const op = existing || { op: "columns", block: ordinal, expect: this.expectFor(ordinal) };
		op.cols = name;
		if (!existing) this.layoutOps.push(op);

		for (const button of this.toolbarWidth.querySelectorAll(".tcb-width-option")) {
			button.classList.toggle("tcb-width-current", button.dataset.cols === name);
		}

		this.pushUndo({
			label: "width change",
			undo: () => {
				row.classList.remove(...COLUMN_CLASSES);
				if (before) row.classList.add(before);
				const at = this.layoutOps.indexOf(op);
				if (at !== -1) this.layoutOps.splice(at, 1);
			},
		});
		this.refreshLayoutStatus();
	}

	// Which way the halves of the row this block is in line up. Like the width,
	// one change to one element, previewed on the live page straight away.
	setRowAlign(name) {
		const ordinal = this.hoveredBlock;
		const node = this.blocks[ordinal];
		const row = node && node.closest(ALIGN_ROW_SELECTOR);
		if (!row) return;

		const values = Object.values(ALIGN_CLASSES);
		const before = values.find((value) => row.classList.contains(value)) || "";
		if (before === ALIGN_CLASSES[name]) return;
		const apply = (value) => {
			row.classList.remove(...values);
			if (value) row.classList.add(value);
			this.markAlign(row);
		};
		apply(ALIGN_CLASSES[name]);

		const existing = this.layoutOps.find((op) => op.op === "align" && this.blocks[op.block] && this.blocks[op.block].closest(ALIGN_ROW_SELECTOR) === row);
		const op = existing || { op: "align", block: ordinal, expect: this.expectFor(ordinal) };
		const previous = op.align;
		op.align = name;
		if (!existing) this.layoutOps.push(op);

		this.pushUndo({
			label: "line-up change",
			undo: () => {
				apply(before);
				// Back to the earlier choice this session, or to no change at all.
				if (previous) op.align = previous;
				else if (this.layoutOps.includes(op)) this.layoutOps.splice(this.layoutOps.indexOf(op), 1);
			},
		});
		this.refreshLayoutStatus();
	}

	markAlign(row) {
		if (!this.toolbarAlign) return;
		// With no class set, the row lines up the way its stylesheet says.
		const current = Object.keys(ALIGN_CLASSES).find((name) => row.classList.contains(ALIGN_CLASSES[name])) || "";
		for (const button of this.toolbarAlign.querySelectorAll(".tcb-align-option")) {
			button.classList.toggle("tcb-width-current", button.dataset.align === current);
		}
	}

	addBlockAt(where) {
		const node = this.blocks[this.hoveredBlock];
		if (node) this.openAddBlock(this.hoveredBlock, where, node);
	}

	hideToolbar() {
		if (this.hoveredNode) this.hoveredNode.classList.remove("tcb-block-hover");
		this.hoveredNode = null;
		this.hoveredBlock = -1;
		this.hoveredPending = null;
		if (this.toolbar) this.toolbar.hidden = true;
	}

	// -- dragging a block to a new place --------------------------------------

	// Native drag and drop, not a pointer-event reimplementation. The browser
	// already does the hard parts -- the drag image, the cursor, the escape
	// key, autoscroll near the edges -- and does them the way the rest of the
	// operating system does.
	//
	// Only the block under the toolbar is draggable at any moment, so a stray
	// drag on ordinary text still selects text the way it always did.
	makeDraggable(node) {
		if (node.dataset.tcbDraggable) return;
		node.dataset.tcbDraggable = "1";
		node.draggable = true;

		node.addEventListener("dragstart", (event) => {
			if (!this.layoutMode) return event.preventDefault();
			const ordinal = this.blocks.indexOf(node);
			if (ordinal === -1 || node.classList.contains("tcb-block-removed")) return event.preventDefault();
			// Something was just put beside it; it stays put until the layout is saved.
			if (node.dataset.tcbBeside === "1") return event.preventDefault();
			this.dragging = { ordinal, node };
			node.classList.add("tcb-block-dragging");
			this.hideToolbar();
			// Required for the drop to fire at all in Firefox.
			event.dataTransfer.setData("text/plain", String(ordinal));
			event.dataTransfer.effectAllowed = "move";
		});

		node.addEventListener("dragend", () => {
			node.classList.remove("tcb-block-dragging");
			this.clearDropMarker();
			this.dragging = null;
		});
	}

	// Where a drop would land: the block under the pointer, and which side of
	// it. Anything above the block's midpoint goes before it.
	dropTargetAt(event) {
		if (!this.dragging) return null;
		const target = event.target && event.target.closest ? event.target.closest(BLOCK_SELECTOR) : null;
		if (!target || target === this.dragging.node) return null;
		const ordinal = this.blocks.indexOf(target);
		if (ordinal === -1) return null;

		const box = target.getBoundingClientRect();
		const where = event.clientY < box.top + box.height / 2 ? "before" : "after";
		return { ordinal, node: target, where };
	}

	// A block that has already been moved or removed cannot be a landmark.
	//
	// Every operation in a batch is resolved against the document as it was
	// loaded, so an anchor names where that block *used to be*. Anchoring one
	// move to another would describe a position that never existed in the file
	// the server is about to read, and it is the kind of wrong that produces a
	// plausible-looking page rather than an error.
	isStableAnchor(ordinal) {
		if (this.movedBlocks.has(ordinal)) return false;
		const node = this.blocks[ordinal];
		// A block that has just had something put beside it has moved into a new
		// column, which does not exist in the file yet either.
		return !!node && !node.classList.contains("tcb-block-removed") && node.dataset.tcbBeside !== "1";
	}

	showDropMarker(target) {
		if (!this.dropMarker) {
			this.dropMarker = chrome("div", { class: "tcb-drop-marker" });
			document.body.appendChild(this.dropMarker);
		}
		const box = target.node.getBoundingClientRect();
		const y = (target.where === "before" ? box.top - 2 : box.bottom) + window.scrollY;
		this.dropMarker.style.top = `${y}px`;
		this.dropMarker.style.left = `${box.left + window.scrollX}px`;
		this.dropMarker.style.width = `${box.width}px`;
		this.dropMarker.hidden = false;
	}

	clearDropMarker() {
		if (this.dropMarker) this.dropMarker.hidden = true;
	}

	bindDragTargets() {
		document.addEventListener("dragover", (event) => {
			if (!this.dragging) return;
			const target = this.dropTargetAt(event);
			if (!target) return this.clearDropMarker();
			// Without preventDefault the browser refuses the drop entirely.
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			this.showDropMarker(target);
		});

		document.addEventListener("drop", (event) => {
			if (!this.dragging) return;
			event.preventDefault();
			const target = this.dropTargetAt(event);
			this.clearDropMarker();
			if (target) this.dropBlock(target);
		});
	}

	dropBlock(target) {
		const { ordinal, node } = this.dragging;

		if (!this.isStableAnchor(target.ordinal)) {
			this.toast("Drop it next to a block you have not already moved or removed.", "error");
			return;
		}

		const from = { parent: node.parentElement, next: node.nextSibling };
		if (target.where === "before") target.node.before(node);
		else target.node.after(node);
		node.classList.add("tcb-block-moved");

		// One operation per block, replaced rather than appended. Dragging the
		// same paragraph three times is one instruction about where it ends up,
		// and three cuts of the same bytes is a conflict the server would
		// rightly refuse.
		const op = { op: "move", block: ordinal, to: { [target.where]: target.ordinal }, expect: this.expectFor(ordinal) };
		const existing = this.movedBlocks.get(ordinal);
		if (existing) this.layoutOps[this.layoutOps.indexOf(existing)] = op;
		else this.layoutOps.push(op);
		this.movedBlocks.set(ordinal, op);

		this.pushUndo({
			label: "move",
			undo: () => {
				if (from.next) from.parent.insertBefore(node, from.next);
				else from.parent.appendChild(node);
				node.classList.remove("tcb-block-moved");
				// Guarded: indexOf is -1 once the op is gone (a later drag of the
				// same block replaces it), and splice(-1, 1) would remove whichever
				// unrelated change happens to be last.
				if (this.layoutOps.includes(op)) this.layoutOps.splice(this.layoutOps.indexOf(op), 1);
				this.movedBlocks.delete(ordinal);
			},
		});
		this.refreshLayoutStatus();
	}

	// -- undo -----------------------------------------------------------------

	// One stack, this visit only, cleared by a reload.
	//
	// Deliberately not a history stored anywhere: a layout change becomes a
	// commit the moment it is saved, and an undo entry that outlived the save
	// would describe a file that has already moved on. Everything on this
	// stack is either still pending, or a text edit that can be re-saved.
	pushUndo(entry) {
		this.undoStack.push(entry);
		if (this.undoStack.length > 50) this.undoStack.shift();
	}

	async undoLast() {
		// While a field is open the browser's own undo owns it, and taking that
		// over would be worse than leaving it alone.
		if (this.active || this.busy) return;
		const entry = this.undoStack.pop();
		if (!entry) {
			this.toast("Nothing to undo.");
			return;
		}
		try {
			await entry.undo();
			this.toast(`Undid the last ${entry.label}.`);
		} catch (error) {
			this.toast(error.message, "error");
		}
		this.refreshStatus();
	}

	// Adding a block. The payload is a shape, never markup -- page-structure.js
	// renders the tag on the server, so nothing typed here can become an
	// element in the file.
	openAddBlock(ordinal, where, node, { replacing = null } = {}) {
		const inList = node.parentElement && ["UL", "OL"].includes(node.parentElement.tagName);
		const kindSelect = el("select", { class: "tcb-input" });
		// Inside a list the only legal block is another item, so it is the only
		// thing offered rather than something to be refused after typing.
		// Inside a row of boxes the only thing that belongs is another box, and
		// inside a list the only thing that belongs is another item. Offering
		// the rest would just be something to refuse later.
		const inRow = !!node.closest(ROW_SELECTOR);
		const beside = where === "beside";
		const kinds =
			inList && !beside
				? [["list-item", "List item"]]
				: inRow && !beside
					? [["card", "Box"]]
					: [
							// An image is the usual thing to put beside words, so it leads.
							...(beside ? [["image", "Image"]] : []),
							["paragraph", "Paragraph"],
							["heading", "Heading"],
							...(beside ? [] : [["image", "Image"]]),
						];
		for (const [value, label] of kinds) kindSelect.appendChild(el("option", { value, text: label }));

		const sideSelect = el("select", { class: "tcb-input" }, [
			el("option", { value: "right", text: "On the right" }),
			el("option", { value: "left", text: "On the left" }),
		]);
		const sideRow = el("label", { class: "tcb-label" }, [
			el("span", { text: "Which side" }),
			sideSelect,
			el("span", { class: "tcb-hint", text: "Side by side on a computer or tablet. On a phone they stack, one above the other." }),
		]);
		sideRow.hidden = !beside;

		const textInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "3" });
		const headingInput = el("input", { type: "text", class: "tcb-input" });
		const levelSelect = el("select", { class: "tcb-input" });
		for (const level of [2, 3]) levelSelect.appendChild(el("option", { value: String(level), text: `Heading ${level}` }));
		const srcInput = el("input", { type: "text", class: "tcb-input", placeholder: "/assets/images/pest-ant-macro.webp" });
		const altInput = el("input", { type: "text", class: "tcb-input" });
		const picker = el("div", { class: "tcb-picker" });

		const textRow = el("label", { class: "tcb-label" }, [el("span", { text: "Words" }), textInput]);
		const headingRow = el("label", { class: "tcb-label" }, [el("span", { text: "Box heading" }), headingInput]);
		const levelRow = el("label", { class: "tcb-label" }, [el("span", { text: "Size" }), levelSelect]);
		const srcRow = el("label", { class: "tcb-label" }, [el("span", { text: "Image" }), srcInput]);
		const altRow = el("label", { class: "tcb-label" }, [
			el("span", { text: "Image description" }),
			altInput,
			el("span", { class: "tcb-hint", text: "What the picture shows, for screen readers and Google. Leave it empty only if the image is decorative." }),
		]);

		const showRows = () => {
			const kind = kindSelect.value;
			headingRow.hidden = kind !== "card";
			levelRow.hidden = kind !== "heading";
			textRow.hidden = kind === "image";
			srcRow.hidden = kind !== "image";
			altRow.hidden = kind !== "image";
			picker.hidden = kind !== "image";
		};
		// Changing something already added: the dialog opens holding what it says
		// now, so a typo is fixed rather than retyped.
		if (replacing) {
			const was = replacing.payload;
			kindSelect.value = was.type;
			sideSelect.value = replacing.side || "right";
			textInput.value = was.text || "";
			headingInput.value = was.heading || "";
			if (was.level) levelSelect.value = String(was.level);
			srcInput.value = was.src || "";
			altInput.value = was.alt || "";
		}
		kindSelect.addEventListener("change", showRows);
		showRows();
		this.fillImagePicker(picker, srcInput, () => {});
		const uploader = this.buildUploader((path) => {
			srcInput.value = path;
		});
		picker.before(uploader);

		this.openDialog(
			replacing ? "Change what you added" : beside ? "Add something beside this" : where === "before" ? "Add a block above" : "Add a block below",
			[
				el("p", { class: "tcb-hint", text: "Nothing is written yet. It goes into the page when you press Save layout." }),
				el("label", { class: "tcb-label" }, [el("span", { text: "What kind" }), kindSelect]),
				sideRow,
				levelRow,
				headingRow,
				textRow,
				srcRow,
				picker,
				altRow,
			],
			async () => {
				const kind = kindSelect.value;
				const payload =
					kind === "image"
						? { type: "image", src: srcInput.value.trim(), alt: altInput.value }
						: kind === "card"
							? { type: "card", heading: headingInput.value, text: textInput.value }
							: kind === "heading"
								? { type: "heading", level: Number(levelSelect.value), text: textInput.value }
								: { type: kind, text: textInput.value };

				// Checked before anything on the page changes, so a change that is
				// missing its words or its picture leaves the old one where it was.
				if (!this.previewBlock(payload)) throw new Error(kind === "image" ? "Choose an image first." : "Type some words first.");

				// Changing an addition is taking the old one out and putting the new
				// one in its place. Out first: for something beside a block, the old
				// row has to be unwrapped before a new one can be wrapped around it.
				if (replacing) this.cancelAddition(replacing);
				this.applyAddition({ ordinal, where, node, payload, side: sideSelect.value });
			},
			{ confirmLabel: replacing ? "Change it" : "Add it", successMessage: null }
		);
	}

	// Puts a pending addition on the page and records how to take it off again.
	//
	// Every addition -- above, below or beside -- goes through here and comes out
	// through cancelAddition, whichever way it is taken back: its own Remove
	// button, Change, or Ctrl+Z. One way in and one way out is what keeps the
	// page, the pending list and the undo history from disagreeing about what is
	// still waiting to be saved.
	applyAddition({ ordinal, where, node, payload, side }) {
		const preview = this.previewBlock(payload);
		let op;
		let revert;

		if (where === "beside") {
			// The same markup the server will write: the site's two-column row, with
			// the existing block moved into one column untouched and the new one in
			// the other. The row itself is not marked as editor chrome -- the
			// existing block lives inside it and must stay reachable.
			const column = (child, isImage) => {
				const wrapper = el("div", { class: isImage ? "split-media-image" : "split-media-text" });
				wrapper.appendChild(child);
				return wrapper;
			};
			const row = el("div", { class: "split-media-grid" });
			const placeholder = document.createComment("tcb-beside");
			node.before(placeholder);
			const existing = column(node, node.tagName === "IMG");
			const added = column(preview, payload.type === "image");
			row.append(...(side === "left" ? [added, existing] : [existing, added]));
			placeholder.replaceWith(row);
			node.dataset.tcbBeside = "1";
			op = { op: "beside", target: ordinal, side, block: payload, expect: this.expectFor(ordinal) };
			revert = () => {
				row.replaceWith(node);
				delete node.dataset.tcbBeside;
			};
		} else {
			if (where === "before") node.before(preview);
			else node.after(preview);
			op = { op: "insert", to: { [where]: ordinal }, block: payload };
			revert = () => preview.remove();
		}

		const entry = { op, ordinal, where, node, side, payload, preview, revert };
		this.layoutOps.push(op);
		this.pendingAdditions.set(preview, entry);
		this.pushUndo({ label: where === "beside" ? "addition beside" : "addition", op, undo: () => this.cancelAddition(entry) });
		// The toolbar skips work when the pointer returns to the block it was
		// already describing, so forget that block: the next hover has to see
		// what the page looks like now.
		this.hideToolbar();
		this.refreshLayoutStatus();
		return entry;
	}

	cancelAddition(entry) {
		const at = this.layoutOps.indexOf(entry.op);
		// Already taken back. splice(-1, 1) would remove whichever change happens
		// to be last in the list instead -- a different, unrelated change -- so
		// this has to stop here rather than fall through to it.
		if (at === -1) return;
		this.layoutOps.splice(at, 1);
		entry.revert();
		this.pendingAdditions.delete(entry.preview);
		this.undoStack = this.undoStack.filter((item) => item.op !== entry.op);
		this.hideToolbar();
		this.refreshLayoutStatus();
	}

	// A stand-in for what the server will write, so the page shows the shape of
	// the result before anything is committed. Built with textContent and
	// setAttribute rather than any markup, for the same reason the server
	// renders from a shape: nothing typed here should be able to become an
	// element, not even in a preview only one person sees.
	previewBlock(payload) {
		const text = String(payload.text || "").trim();
		let node;
		if (payload.type === "card") {
			const heading = String(payload.heading || "").trim();
			if (!heading || !text) return null;
			node = el("div", { class: "grid-card" }, [el("h3", { class: "display", text: heading }), el("p", { text })]);
		} else if (payload.type === "image") {
			const safe = previewableImagePath(String(payload.src || "").trim());
			if (!safe) return null;
			node = el("img", { src: safe, alt: String(payload.alt || "") });
		} else {
			if (!text) return null;
			const tag = payload.type === "heading" ? `h${payload.level}` : payload.type === "list-item" ? "li" : "p";
			node = el(tag, { text });
		}
		node.classList.add("tcb-block-added");
		node.setAttribute(IGNORED_SUBTREE_ATTR, "");
		return node;
	}

	refreshLayoutStatus() {
		const count = this.layoutOps.length;
		this.saveLayoutButton.disabled = count === 0;
		this.status.textContent = count
			? `${count} layout ${count === 1 ? "change" : "changes"}, not saved yet.`
			: "Add or remove blocks, then press Save layout.";
	}

	// Writes the pending operations into the page's HTML file, as one commit.
	//
	// Unlike Publish this does not take effect immediately: the file is
	// committed at once, but visitors see it when Cloudflare finishes
	// redeploying a minute or two later. Until then every number on this screen
	// describes a file that has already moved on, so layout mode locks itself
	// rather than let a second save be resolved against the wrong document.
	async saveLayout() {
		if (!this.layoutOps.length || this.busy) return;

		// The location pages are 84 near-copies of one another. Changing the
		// shape of one is a legitimate thing to do, and also the moment it stops
		// matching its 83 siblings -- worth being told once, now, rather than
		// discovering months later.
		if (PATH.startsWith("/locations-pest-control-")) {
			const goAhead = await this.confirmDialog(
				"This is one of the location pages",
				"There are 84 of these and they are built to match each other. Changing the layout of this one changes only this one; the other 83 keep the shape they have now.",
				"Change this page only"
			);
			if (!goAhead) return;
		}

		this.busy = true;
		this.saveLayoutButton.disabled = true;
		this.saveLayoutButton.textContent = "Saving…";
		try {
			const result = await api("structure", { method: "POST", body: JSON.stringify({ path: PATH, ops: this.layoutOps }) });
			if (!result.changed) {
				this.toast("That would not have changed anything.");
				this.layoutOps = [];
				this.refreshLayoutStatus();
				return;
			}
			this.layoutOps = [];
			// Locked rather than reset: the file has changed, and every number on
			// this screen was worked out from the old one.
			this.lockLayout(result.commit);
		} catch (error) {
			this.toast(error.message, "error");
			this.saveLayoutButton.disabled = false;
		} finally {
			this.busy = false;
			this.saveLayoutButton.textContent = "Save layout";
		}
	}

	lockLayout(commit) {
		this.hideToolbar();
		// The commit has landed, so every pending inverse on the stack now
		// describes a file that has moved on. Dropped rather than left to be
		// replayed against the wrong document.
		this.undoStack = [];
		this.movedBlocks.clear();
		this.saveLayoutButton.disabled = true;
		this.layoutButton.disabled = true;
		this.status.textContent = "Saved. It goes live when the site finishes rebuilding, in a minute or two -- reload then.";
		this.openDialog(
			"Layout saved",
			[
				el("p", { class: "tcb-hint", text: "The page's file has been changed and committed. It reaches visitors once the site finishes rebuilding, usually a minute or two." }),
				el("p", { class: "tcb-hint", text: "There is no undo for this one: the change is a commit. To put it back, revert that commit on GitHub." }),
				...(commit && commit.url ? [el("p", {}, [el("a", { href: commit.url, target: "_blank", rel: "noopener", text: "See the commit" })])] : []),
			],
			null,
			{ confirmLabel: null, cancelLabel: "Close" }
		);
	}

	// A yes/no built on the dialog, so a warning looks like the rest of the
	// editor rather than like a browser alert.
	confirmDialog(title, message, confirmLabel) {
		return new Promise((resolve) => {
			let answered = false;
			this.openDialog(
				title,
				[el("p", { class: "tcb-hint", text: message })],
				async () => {
					answered = true;
					resolve(true);
				},
				{
					confirmLabel,
					cancelLabel: "Leave it alone",
					successMessage: null,
					onCancel: () => {
						if (!answered) resolve(false);
					},
				}
			);
		});
	}

	// -- the header menu -------------------------------------------------------

	// The menu across the top of every page, and the dropdowns under it.
	//
	// Unlike everything else in this editor it is not about the page you are on:
	// every page carries its own copy of the menu, so saving writes all of them
	// at once, as one commit, and it appears after the site rebuilds. The server
	// (the `menu` route in src/content-edits.js) does the checking; this is only
	// the list.
	//
	// Reordering is up and down buttons rather than dragging. A dialog holding a
	// dozen short rows does not need drag and drop, and buttons work the same
	// from a keyboard and a phone.
	async openMenuEditor() {
		let menu;
		let pages = [];
		try {
			const [menuResponse, pagesResponse] = await Promise.all([
				fetch("/assets/menu.json", { cache: "no-store" }),
				fetch("/assets/search-index.json", { cache: "no-store" }),
			]);
			if (!menuResponse.ok) throw new Error("The current menu could not be loaded.");
			menu = await menuResponse.json();
			// The page list is a convenience. Without it every address is typed,
			// which still works, so its failure is not a reason to refuse.
			if (pagesResponse.ok) pages = await pagesResponse.json();
		} catch (error) {
			this.toast(error.message, "error");
			return;
		}

		// Worked on as plain data and redrawn after every change: the list is a
		// dozen rows, so rebuilding it is cheaper than keeping DOM and data in
		// step by hand.
		const items = (menu.items || []).map((item) => ({
			label: item.label,
			href: item.href,
			children: (item.children || []).map((child) => ({ label: child.label, href: child.href })),
		}));

		// A page's title is written for Google -- "Ant Control Canberra | TCB
		// Pest Control" -- so the part before the bar is the useful label.
		const titleFor = new Map(
			(Array.isArray(pages) ? pages : []).map((page) => [page.url, String(page.title || "").split("|")[0].trim()])
		);

		// Native autocomplete for the address field: pick a page from the list,
		// or type anything else -- a phone number, an outside site.
		const datalistId = "tcb-menu-pages";
		const datalist = el(
			"datalist",
			{ id: datalistId },
			[...titleFor].map(([url, title]) => el("option", { value: url, label: title }))
		);

		const list = el("div", { class: "tcb-menu-list" });
		const menuStatus = el("p", { class: "tcb-hint" });
		menuStatus.hidden = true;

		const move = (array, index, by) => {
			const to = index + by;
			if (to < 0 || to >= array.length) return;
			[array[index], array[to]] = [array[to], array[index]];
			draw();
		};

		const linkFields = (entry) => {
			const label = el("input", { type: "text", class: "tcb-input", value: entry.label, placeholder: "Label", "aria-label": "Label" });
			const href = el("input", {
				type: "text",
				class: "tcb-input",
				value: entry.href,
				placeholder: "/page-address",
				list: datalistId,
				"aria-label": "Address",
			});
			label.addEventListener("input", () => {
				entry.label = label.value;
			});
			href.addEventListener("input", () => {
				entry.href = href.value;
				// Picking a page with no label yet fills the label in from its
				// title. An existing label is never overwritten.
				if (!label.value.trim() && titleFor.has(href.value)) {
					label.value = titleFor.get(href.value);
					entry.label = label.value;
				}
			});
			return [label, href];
		};

		const smallButton = (text, onclick, extra = {}) =>
			el("button", { type: "button", class: "tcb-btn tcb-btn-small tcb-btn-quiet", text, onclick, ...extra });

		function draw() {
			list.replaceChildren();
			items.forEach((item, index) => {
				const children = el(
					"div",
					{ class: "tcb-menu-children" },
					item.children.map((child, childIndex) =>
						el("div", { class: "tcb-menu-row tcb-menu-child" }, [
							...linkFields(child),
							smallButton("↑", () => move(item.children, childIndex, -1), { "aria-label": "Move up" }),
							smallButton("↓", () => move(item.children, childIndex, 1), { "aria-label": "Move down" }),
							smallButton("Remove", () => {
								item.children.splice(childIndex, 1);
								draw();
							}),
						])
					)
				);

				list.appendChild(
					el("div", { class: "tcb-menu-item" }, [
						el("div", { class: "tcb-menu-row" }, [
							...linkFields(item),
							smallButton("↑", () => move(items, index, -1), { "aria-label": "Move up" }),
							smallButton("↓", () => move(items, index, 1), { "aria-label": "Move down" }),
							smallButton("Remove", () => {
								if (item.children.length && !window.confirm(`Remove "${item.label}" and the ${item.children.length} pages under it?`)) return;
								items.splice(index, 1);
								draw();
							}),
						]),
						children,
						el("button", {
							type: "button",
							class: "tcb-btn tcb-btn-small",
							text: item.children.length ? "Add another page under this" : "Add a dropdown under this",
							onclick: () => {
								item.children.push({ label: "", href: "" });
								draw();
								// Straight into the new row's address, where the page list is.
								const rows = list.querySelectorAll(".tcb-menu-item")[index].querySelectorAll(".tcb-menu-child");
								const last = rows[rows.length - 1];
								if (last) last.querySelectorAll("input")[1].focus();
							},
						}),
					])
				);
			});
		}
		draw();

		const payload = () => ({
			items: items.map((item) => ({
				label: item.label,
				href: item.href,
				children: item.children.map((child) => ({ label: child.label, href: child.href })),
			})),
		});

		this.openDialog(
			"Menu",
			[
				el("p", {
					class: "tcb-hint",
					text: "The menu across the top of every page. Saving changes all of them at once, and it goes live when the site finishes rebuilding, a minute or two later.",
				}),
				datalist,
				menuStatus,
				list,
				el("button", {
					type: "button",
					class: "tcb-btn",
					text: "Add a menu item",
					onclick: () => {
						items.push({ label: "", href: "", children: [] });
						draw();
						const rows = list.querySelectorAll(".tcb-menu-item");
						rows[rows.length - 1].querySelector("input").focus();
					},
				}),
			],
			async () => {
				// Checked on the server first, without writing anything: the page
				// count for the confirmation comes from here, and so does every
				// reason it would be refused -- before anyone is asked to confirm a
				// save that was never going to go through.
				// Said out loud, because otherwise the only sign anything is happening
				// is the Save button going pale -- which reads as broken, not busy.
				menuStatus.hidden = false;
				menuStatus.textContent = "Checking every page on the site…";
				let check;
				try {
					check = await api("menu", { method: "POST", body: JSON.stringify({ menu: payload(), dryRun: true }) });
				} finally {
					menuStatus.hidden = true;
				}
				if (check.changed === false) {
					this.toast("The menu is already like that.");
					return;
				}

				const goAhead = await this.confirmDialog(
					"Change the menu on every page?",
					`This updates the menu on ${check.files} ${check.files === 1 ? "page" : "pages"} as one change to the site. It goes live in a minute or two. To undo it later, the change can be reverted on GitHub.`,
					"Update the menu"
				);
				// Kept open, with what was typed still in it.
				if (!goAhead) throw new Error("Not saved.");

				const result = await api("menu", { method: "POST", body: JSON.stringify({ menu: payload() }) });
				this.openDialog(
					"Menu saved",
					[
						el("p", {
							class: "tcb-hint",
							text: `The menu has been written into ${result.files} ${result.files === 1 ? "page" : "pages"}. It appears once the site finishes rebuilding, usually a minute or two.`,
						}),
						...(result.commit && result.commit.url
							? [el("p", {}, [el("a", { href: result.commit.url, target: "_blank", rel: "noopener", text: "See the change" })])]
							: []),
					],
					null,
					{ confirmLabel: null, cancelLabel: "Close" }
				);
			},
			{ confirmLabel: "Save menu", successMessage: null }
		);
	}

	// -- writing a new blog post ----------------------------------------------

	// BLOG-GUIDE.md's seven manual steps, as a form. Only the parts that need
	// deciding are asked for: the slug, date, read time, canonical URL, social
	// tags and related-post cards are all derived server-side.
	//
	// The wording does not have to be final here. Once the draft exists it is
	// an ordinary page, so it can be opened with ?edit=1 and polished with the
	// same click-to-edit the rest of the site uses.
	// `draft` is optional and arrives from the gap panel's "Give it its own
	// page": a title, description, intro and sections already written, with
	// every fact left out on purpose. Everything is still a field, and nothing
	// exists until Create is pressed -- the draft saves the typing, not the
	// deciding.
	async openNewPost(draft = null) {
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
		picker.before(
			this.buildUploader((path) => {
				heroInput.value = path;
				showHero(path);
			})
		);

		const introInput = el("textarea", { class: "tcb-input tcb-textarea", rows: "3" });
		const pestInput = el("input", { type: "text", class: "tcb-input", placeholder: "ant control" });

		// What the form says right now, sent with every per-field suggestion so
		// each one is written knowing the rest of the post. Read at click time,
		// never captured -- the form has always moved on since, and that later
		// state is the context worth sending.
		//
		// Declared above the fields it reads because addSection() attaches it
		// to each row's buttons, and the first rows are built further down --
		// the bodies only run on a click, by which point everything exists.
		const readDraft = () => ({
			title: titleInput.value,
			description: descriptionInput.value,
			intro: introInput.value,
			topic: pestInput.value || topicInput.value,
			sections: [...sectionList.children].map((row) => ({
				heading: row.headingInput.value,
				paragraph: row.paragraphInput.value,
			})),
		});

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
				this.buildDraftSuggestions("sectionHeading", headingInput, readDraft),
				paragraphInput,
				this.buildDraftSuggestions("section", paragraphInput, readDraft),
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
		// Filling the form from a draft. Two things do this -- the gap panel on
		// the way in, and the "Draft it all" button below -- and they have to
		// fill the same fields, so there is one description of what a draft is
		// rather than two that drift.
		const applyDraft = (source) => {
			titleInput.value = source.title || "";
			descriptionInput.value = source.description || "";
			updateCount();
			introInput.value = source.intro || "";
			// The search this page exists to answer, which is also the thing
			// the template threads through as the topic.
			pestInput.value = source.query || "";
			if (Array.isArray(source.sections) && source.sections.length) {
				sectionList.replaceChildren();
				for (const section of source.sections) addSection(section.heading, section.paragraph);
			}
		};

		if (draft) applyDraft(draft);
		// Two to start with, for a post being written from nothing. A draft
		// that brought its own sections has already filled these in.
		if (!sectionList.children.length) {
			addSection();
			addSection();
		}

		// Writing the whole post from a topic rather than from a blank form.
		//
		// This is the same call the gap panel makes when it offers a page for
		// a search nothing on the site answers -- it was simply only reachable
		// from there, never from the button that actually starts a post. One
		// request fills the title, the description, the opening paragraph and
		// every section; the image, the category and the closing topic are
		// still yours.
		//
		// Per-field "Suggest" buttons are deliberately not what this is. The
		// suggestion endpoint reads a published page to work from, and the
		// whole point of this dialog is that the page does not exist yet.
		const topicInput = el("input", { type: "text", class: "tcb-input", placeholder: "ants in summer" });
		const draftButton = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Draft it all" });
		const draftStatus = el("p", { class: "tcb-hint" });

		draftButton.addEventListener("click", async () => {
			const query = topicInput.value.trim();
			if (!query) {
				draftStatus.className = "tcb-hint tcb-hint-warn";
				draftStatus.textContent = "What should the post be about?";
				topicInput.focus();
				return;
			}

			draftButton.disabled = true;
			draftStatus.className = "tcb-hint";
			draftStatus.textContent = `Writing a draft about “${query}”…`;

			let drafted;
			try {
				drafted = await api("/api/seo/draft-page", { method: "POST", body: JSON.stringify({ query }) });
			} catch (error) {
				draftButton.disabled = false;
				draftStatus.className = "tcb-hint tcb-hint-warn";
				draftStatus.textContent = error.message;
				return;
			}

			draftButton.disabled = false;
			// Says it replaces rather than adds, because the second press does
			// exactly that to anything typed in between.
			draftButton.textContent = "Draft it again";
			applyDraft(drafted);
			draftStatus.textContent = `Drafted.${modelNote(drafted)}${priceNote(drafted)} Every word is still a field — nothing is created until you press Create draft.`;
		});

		this.openDialog(
			"New blog post",
			[
				el("p", { class: "tcb-hint", text: "This creates the post as a draft. Nothing links to it and Google is told to ignore it until you publish." }),
				field("What should it be about?", topicInput, "A search someone would actually type. Everything below gets written from it, and every word stays editable."),
				draftButton,
				draftStatus,
				field("Title", titleInput),
				this.buildDraftSuggestions("title", titleInput, readDraft),
				field("Description", descriptionInput),
				descriptionCount,
				this.buildDraftSuggestions("description", descriptionInput, readDraft, updateCount),
				field("Category", categorySelect),
				field("Main image", heroInput),
				heroPreview,
				picker,
				field("Image description", heroAltInput, "What the picture shows, for screen readers and Google."),
				this.buildDraftSuggestions("alt", heroAltInput, readDraft),
				field("Opening paragraph", introInput),
				this.buildDraftSuggestions("intro", introInput, readDraft),
				sectionList,
				el("button", { type: "button", class: "tcb-btn", text: "Add another section", onclick: () => addSection() }),
				field("Topic for the closing call to action", pestInput, "Filled into “a conversation about ___ in and around your home”."),
				this.buildDraftSuggestions("topic", pestInput, readDraft),
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
			// Publishing a title or description rewrites the matching og: tag
			// at serve time (src/content-edits.js), so the social-drift check
			// has to see the pair the visitor will get -- not a draft measured
			// against a tag that will be rewritten the moment it is published.
			const social = label === "title" ? "ogTitle" : "ogDescription";
			if (page[social] !== null && page[social] !== undefined) page[social] = value;
			if (row.draft !== null && row.draft !== undefined) draftFields.push(label);
		}

		// Which page this claims to be, for the canonical check.
		page.path = PATH;
		page.origin = location.origin;

		const findings = checkSeo(page);

		const list = el("div", { class: "tcb-findings" });
		for (const finding of findings) {
			list.appendChild(
				el("div", { class: `tcb-finding tcb-finding-${finding.level.replace(/\s+/g, "-")}` }, [
					el("span", { class: "tcb-finding-level", text: finding.level }),
					el("div", {}, [
						el("p", { class: "tcb-finding-message", text: finding.message }),
						// The fix block shows both sides of the change itself, so
						// the detail line would say the stale wording twice.
						...(finding.detail && !finding.action ? [el("p", { class: "tcb-hint", text: finding.detail })] : []),
						...(finding.fix ? [el("p", { class: "tcb-finding-fix", text: finding.fix })] : []),
						...(finding.action ? [this.buildFindingFix(PATH, finding.action)] : []),
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
				// Honest about scope: "SEO check" reads as more than it is, and
				// somebody who assumes speed was checked would never find out.
				el("p", {
					class: "tcb-hint",
					text: "This checks wording and structure — titles, descriptions, headings, links, and how pages relate. It does not measure speed; for that, put the address into pagespeed.web.dev.",
				}),
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

			// The strongest thing in this panel. Not an opinion about the
			// wording and not a forecast: Google has already decided this page
			// is a plausible answer for these phrases, and the page does not
			// use the words. Both halves of that are observed.
			if (page.gaps && page.gaps.length) {
				// Split by what to actually do, because they lead somewhere
				// genuinely different. Lumping them together was the first
				// version's mistake: the homepage is shown for "bird control
				// canberra" and never says "bird", but /bird-control answers
				// it better, and working "bird" into the homepage would set
				// the two competing.
				const groups = [
					{
						verdict: "add",
						level: "worth doing",
						heading: "Searches this page is shown for that no page on the site is about:",
					},
					{
						verdict: "strengthen",
						level: "worth a look",
						heading: "Searches where the right page exists but is not winning:",
					},
					{
						verdict: "elsewhere",
						level: "no action",
						heading: "Searches another page already answers better:",
					},
				];

				for (const group of groups) {
					const rows = page.gaps.filter((gap) => gap.verdict === group.verdict);
					if (!rows.length) continue;

					// The instruction sits with the search it is about, rather
					// than once at the bottom of the group. Each row is a
					// different page to open and a different phrase to use, so
					// a single shared line underneath could only be vague --
					// which is exactly how the first version read.
					const list = el("div", { class: "tcb-findings" });
					for (const gap of rows) {
						list.appendChild(
							el("div", { class: "tcb-gap" }, [
								el("p", { class: "tcb-finding-message", text: gap.sentence }),
								el("p", { class: "tcb-finding-fix", text: gap.fix }),
								...(gap.rival
									? [
											el("div", { class: "tcb-scan-pages" }, [
												el("a", {
													class: "tcb-scan-link",
													href: `${gap.rival.path}?edit=1`,
													text: `Open ${gap.rival.path}`,
												}),
											]),
									  ]
									: []),
							])
						);
					}

					results.appendChild(
						el("div", { class: `tcb-finding tcb-finding-${group.verdict === "add" ? "problem" : "worth-a-look"}` }, [
							el("span", { class: "tcb-finding-level", text: group.level }),
							el("div", {}, [
								el("p", { class: "tcb-finding-message", text: group.heading }),
								list,
								// One button for the group. A page has one
								// title, so a Fix per search meant two buttons
								// proposing two different titles for the same
								// box, where taking the second undid the first.
								...(group.verdict === "add" ? [this.buildGapFix(rows)] : []),
							]),
						])
					);
				}
			}

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

	// "Fix this" on a single measured gap.
	//
	// It does the typing, not the deciding. Options come back, one gets
	// clicked, and it lands as a draft like any other edit -- reviewable in
	// the change list, revertable, and invisible to visitors until published.
	// Nothing here writes to the live site, which matters more than usual
	// given this feature has twice given confidently wrong advice.
	//
	// Title first, then description, then the main heading. That is the order
	// of weight, and the heading is the one with room left when a phrase will
	// not fit into 62 characters alongside everything a title already carries.
	buildGapFix(gaps) {
		const status = el("p", { class: "tcb-hint" });
		const options = el("div", { class: "tcb-suggestions" });
		const button = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small",
			text: gaps.length > 1 ? `Work these ${gaps.length} into this page` : "Work it into this page",
		});

		// The advice here has always been two-sided -- work the words into
		// this page, or give the search a page of its own -- and only the
		// first side had a button, which quietly made it the recommendation
		// whether or not it was the better one. The biggest gap is the one
		// worth a page, so that is the one this offers.
		const biggest = gaps.slice().sort((a, b) => (b.impressions || 0) - (a.impressions || 0))[0];
		// Two kinds of page, because they are not interchangeable. Somebody
		// typing "borer control canberra" is ready to book, and a blog post is
		// the wrong thing to land them on; somebody typing "why do borers
		// appear in summer" is reading. Offering only the blog post -- which
		// is what this did first -- quietly made the wrong one the default for
		// exactly the searches worth having.
		const pageButton = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small",
			text: "Build a service page",
		});
		const postButton = el("button", {
			type: "button",
			class: "tcb-btn tcb-btn-small",
			text: "Write a blog post",
		});

		// The service page: drafted, shown in full, and only then created.
		//
		// This is the one thing in the editor that adds a page to the site
		// rather than editing one, so it shows everything it is about to write
		// -- heading, hero, every section, every question -- before the button
		// that writes it appears. The page is committed with a noindex and is
		// not put in the sitemap, so it exists at its address to be read and
		// edited, and Google does not see it until it is published.
		pageButton.addEventListener("click", async () => {
			pageButton.disabled = true;
			options.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = `Writing a service page about “${biggest.query}”…`;

			let draft;
			try {
				draft = await api("/api/seo/draft-service-page", {
					method: "POST",
					body: JSON.stringify({ query: biggest.query }),
				});
			} catch (error) {
				pageButton.disabled = false;
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				return;
			}
			pageButton.disabled = false;

			// Editable, not just readable. The address and the service name go
			// into the URL, the canonical tag, the breadcrumb and the schema,
			// and a model's guess at either is worth a look before it is set.
			const nameInput = el("input", { type: "text", class: "tcb-input tcb-input-small" });
			nameInput.value = draft.serviceName || titleCase(biggest.query);
			const slugInput = el("input", { type: "text", class: "tcb-input tcb-input-small" });
			slugInput.value = slugFrom(nameInput.value);
			nameInput.addEventListener("input", () => {
				slugInput.value = slugFrom(nameInput.value);
			});
			const titleInput = el("input", { type: "text", class: "tcb-input tcb-input-small" });
			titleInput.value = draft.title || "";

			const create = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Create the page" });
			const outcome = el("p", { class: "tcb-hint" });

			create.addEventListener("click", async () => {
				create.disabled = true;
				outcome.className = "tcb-hint";
				outcome.textContent = "Creating…";
				try {
					const made = await api("/api/service/create", {
						method: "POST",
						body: JSON.stringify({
							...draft,
							slug: slugInput.value.trim(),
							serviceName: nameInput.value.trim(),
							title: titleInput.value.trim(),
							// The hero picture cannot be written, only chosen,
							// and there is no borer photograph on this site.
							// The nearest existing one, changeable on the page.
							heroImage: "pest-termite-macro.webp",
							heroImageSmall: "pest-termite-macro-sm.webp",
							heroImageAlt: `${nameInput.value.trim()} in Canberra`,
						}),
					});
					outcome.textContent = `Created at ${made.url}, not yet visible to Google. Open it to read it through and change the picture.`;
					create.remove();
				} catch (error) {
					create.disabled = false;
					outcome.className = "tcb-hint tcb-hint-warn";
					outcome.textContent = error.message;
				}
			});

			status.textContent = `Drafted.${modelNote(draft)}${priceNote(draft)} Nothing has been created yet — read it through first.`;
			options.replaceChildren(
				el("label", { class: "tcb-label" }, [el("span", { text: "Service name" }), nameInput]),
				el("label", { class: "tcb-label" }, [el("span", { text: "Web address" }), slugInput]),
				el("label", { class: "tcb-label" }, [el("span", { text: "Page title" }), titleInput]),
				el("p", { class: "tcb-hint", text: draft.description || "" }),
				...draft.sections.map((section) =>
					el("div", { class: "tcb-compare" }, [
						el("p", { class: "tcb-compare-model", text: section.eyebrow || "" }),
						el("p", { class: "tcb-suggestion-text", text: section.heading || "" }),
						...(section.paragraphs || []).map((text) => el("p", { class: "tcb-hint", text })),
					])
				),
				...(draft.faqs || []).map((faq) =>
					el("p", { class: "tcb-hint", text: `${faq.question} — ${faq.answer}` })
				),
				el("p", {
					class: "tcb-hint",
					text: "It will not have written anything about the business — no licences, no guarantees, no response times. There is nothing on a new page to check those against, so none are allowed through. Add them yourself once it exists.",
				}),
				el("div", { class: "tcb-suggest-row" }, [create, outcome])
			);
		});

		postButton.addEventListener("click", async () => {
			postButton.disabled = true;
			options.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = `Drafting a page about “${biggest.query}”…`;

			let draft;
			try {
				draft = await api("/api/seo/draft-page", {
					method: "POST",
					body: JSON.stringify({ query: biggest.query }),
				});
			} catch (error) {
				postButton.disabled = false;
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				return;
			}

			postButton.disabled = false;
			status.textContent = `Drafted.${modelNote(draft)}${priceNote(draft)} Check it over — nothing is created until you save it.`;
			// Opened rather than created. A new page on a real business's site
			// is not a thing to bring into existence from one click, and the
			// composer is where the hero image, the category and the wording
			// get a look from somebody who knows the business.
			this.openNewPost(draft);
		});

		const WHERE = { title: "page title", description: "description", heading: "main heading" };

		button.addEventListener("click", async () => {
			button.disabled = true;
			options.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = "Working out where the words fit…";

			let result;
			try {
				result = await api("/api/seo/fix", { method: "POST", body: JSON.stringify({ path: PATH }) });
			} catch (error) {
				button.disabled = false;
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = error.message;
				return;
			}

			button.disabled = false;
			button.textContent = "Try again";

			if (!result.kind || !result.candidates.length) {
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent =
					"Nothing came back that both used the words and passed the checks. Worth trying again, or writing it yourself.";
				return;
			}

			// Say where it landed and why, because "it went in the heading"
			// is surprising unless you know the title was tried first.
			const skipped = (result.skipped || []).map((entry) => WHERE[entry.kind]).filter(Boolean);
			const lead = skipped.length
				? `The words would not fit in the ${skipped.join(" or the ")}, so these are for the ${WHERE[result.kind]}.`
				: `One ${WHERE[result.kind]}, covering as many of these searches as it honestly can.`;

			// A heading built out of several pieces cannot be replaced in one
			// move without losing what splits it. On this site that is a line
			// break on one page and a coloured phrase on another -- both
			// deliberate, and neither worth destroying to save a click. So the
			// wording is still offered; applying it is left to a human who can
			// see which part is which.
			const splitHeading = result.kind === "heading" && !this.headingEntry();
			status.textContent = splitHeading
				? `${lead} Your heading is in more than one piece — there is a line break or a coloured phrase in it — so this can't be dropped in without flattening that. Click the heading on the page and edit it by hand:`
				: `${lead} Click one to use it.`;

			for (const candidate of result.candidates) {
				// How many of the searches this one line answers. With more
				// than one gap in play that is the thing worth comparing, and
				// it is not visible from the wording alone.
				const covers =
					gaps.length > 1 ? `${candidate.covers.length}/${gaps.length}` : `${candidate.text.length}`;

				if (splitHeading) {
					options.appendChild(el("p", { class: "tcb-suggestion tcb-suggestion-plain", text: candidate.text }));
					continue;
				}
				const option = el("button", { type: "button", class: "tcb-suggestion" }, [
					el("span", { class: "tcb-suggestion-text", text: candidate.text }),
					el("span", { class: "tcb-suggestion-count", text: covers }),
				]);
				option.addEventListener("click", async () => {
					option.disabled = true;
					try {
						await this.applyFix(result.kind, candidate.text);
						status.className = "tcb-hint";
						status.textContent = `Saved as a draft on the ${WHERE[result.kind]}. Publish when you're ready.`;
						options.replaceChildren();
					} catch (error) {
						option.disabled = false;
						status.className = "tcb-hint tcb-hint-warn";
						status.textContent = error.message;
					}
				});
				options.appendChild(option);
			}
		});

		return el("div", { class: "tcb-suggest-row" }, [
			el("div", { class: "tcb-btn-row" }, [button, pageButton, postButton]),
			el("p", {
				class: "tcb-hint",
				text: "A service page is the kind under Pests We Treat — the one to land somebody on when they are ready to book. A blog post is for a search someone is reading rather than buying. Either way the page is created unlisted and invisible to Google until you publish it.",
			}),
			status,
			options,
		]);
	}

	// Applies one accepted suggestion. The title and description are metadata;
	// the heading is ordinary page text and goes through the same save path as
	// clicking on it and typing.
	async applyFix(kind, value) {
		if (kind === "title") {
			await this.saveMeta(META_TITLE_ADDRESS, value, document.title || "");
			document.title = value;
			return;
		}

		if (kind === "description") {
			const meta = document.querySelector('meta[name="description"]');
			await this.saveMeta(META_DESCRIPTION_ADDRESS, value, (meta && meta.getAttribute("content")) || "");
			if (meta) meta.setAttribute("content", value);
			return;
		}

		const entry = this.headingEntry();
		if (!entry) {
			throw new Error("This page's main heading is split across several pieces, so it can't be replaced in one go. Click it and edit it directly.");
		}
		const previous = entry.node.nodeValue;
		this.renderValue(entry, value);
		await this.save(entry, value, previous);
	}

	// The editable text of the first <h1>, when it is a single piece.
	//
	// Several headings on this site wrap part of themselves in a span for the
	// accent colour, which splits them into two text nodes with two separate
	// addresses. Replacing one half would mangle the heading, so this returns
	// nothing rather than guessing, and the caller says so plainly.
	headingEntry() {
		const heading = document.querySelector("h1");
		if (!heading) return null;
		const inside = [...this.entries.values()].filter(
			(entry) => entry.kind === "text" && entry.node.parentElement && heading.contains(entry.node)
		);
		return inside.length === 1 ? inside[0] : null;
	}

	// Checks every page in sitemap.xml, a slice at a time.
	//
	// Batched rather than done in one call: 134 pages is far too much parsing
	// for a single Worker invocation, and asking for a slice at a time means a
	// slow scan is a longer scan rather than a failed one. Progress is shown
	// because a silent thirty-second wait reads as a hang.
	buildSiteScan() {
		const status = el("p", { class: "tcb-hint" });
		const history = el("p", { class: "tcb-hint" });
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
			let redirected = [];
			let extraPages = [];
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
					redirected.push(...(batch.redirects || []));
					// Everything sent to /api/seo/links is absent from the
					// sitemap by construction, so a target that answered with a
					// real page is a page the sitemap does not know about.
					extraPages.push(...(batch.pages || []));
				}
			} catch {
				// A failed link check should not throw away a completed page
				// scan. The page findings are still worth showing, so this
				// falls through with nothing reported rather than nothing at all.
				broken = [];
				redirected = [];
				extraPages = [];
			}

			const siteFindings = checkSite({ pages: scanned, broken, redirected, extraPages, complete });
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
							// A whole-site finding's fix edits pages other than
							// this one, so it takes no path -- the server works
							// out which pages are affected from the same rule
							// that produced the finding.
							...(finding.action ? [this.buildFindingFix(null, finding.action)] : []),
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

			// What changed since last time. The scan's findings vanish when the
			// dialog closes, and "is this getting better or worse" is the one
			// question a list of findings cannot answer about itself. Stored in
			// this browser only -- enough for the person who runs the scans.
			this.noteScanHistory(history, pages, siteFindings);

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
					// Findings that carry an action can be fixed from right here,
					// without opening the page -- the scan is where these appear
					// eight at a time, and eight page visits is how a list of
					// chores stays a list of chores.
					if (finding.action) findings.appendChild(this.buildFindingFix(page.path, finding.action));
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
			history,
			siteResults,
			results,
		]);
	}

	// The Fix button on a finding that carries an action. Today the only kind
	// is "social" -- a stale og:title or og:description -- and the fix runs
	// server-side: /api/seo/fix-social publishes the page's own current
	// wording, which the serving layer rewrites the social tags to match.
	// Nothing a visitor reads changes, which is why this needs no review step
	// the way a suggestion does.
	//
	// Both sides of the change are shown before the button. "Fix" with no
	// before-and-after asks the person to trust the tool; showing the stale
	// wording and its replacement lets them check it in the time it takes to
	// read two lines -- and catch the one case where the tool has it
	// backwards, because the wording somebody meant to change was the title.
	buildFindingFix(path, action) {
		if (action.kind === "titles") return this.buildTitleEndingFix(action);
		if (action.kind !== "social") return el("span");
		// The mechanism, spelled out: which lines in the page's code change,
		// and when the change lands where. Somebody deciding whether to press
		// a button that edits their website is owed the how, not just the
		// before and after.
		const tags = action.field === "title" ? "og:title and twitter:title" : "og:description and twitter:description";
		const status = el("span", { class: "tcb-hint" });
		const button = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Fix" });
		button.addEventListener("click", async () => {
			button.disabled = true;
			status.textContent = "Fixing…";
			try {
				const result = await api("/api/seo/fix-social", {
					method: "POST",
					body: JSON.stringify({ path, field: action.field }),
				});
				button.remove();
				status.textContent = result.already
					? `Nothing to do — ${result.already}.`
					: `Fixed — ${tags} now match the page ${action.field}.`;
			} catch (error) {
				button.disabled = false;
				status.textContent = error.message;
			}
		});
		return el("div", {}, [
			...(action.from ? [el("p", { class: "tcb-hint", text: `Shares currently say: “${action.from}”` })] : []),
			...(action.to ? [el("p", { class: "tcb-hint", text: `Fix changes that to the page's own ${action.field}: “${action.to}”` })] : []),
			el("p", {
				class: "tcb-hint",
				text: `How: it rewrites the ${tags} lines in this page's code to match the ${action.field} — the same as publishing a ${action.field} edit, except the wording stays exactly what it already is. The fix is live as soon as it runs, and “Sync to code” writes it into the HTML file permanently. Nothing on the page itself changes.`,
			}),
			el("div", { class: "tcb-suggest-row" }, [button, status]),
		]);
	}

	// Fix for the shared title ending, which edits pages other than this one.
	//
	// Every other Fix in this panel changes one page you are looking at. This
	// one changes seventeen you are not, so it asks twice: the first press
	// fetches exactly what would change and lists it, and only the second
	// press writes anything. A bulk edit that happens on one click, to pages
	// out of sight, is the one button here worth being slow about.
	buildTitleEndingFix(action) {
		const status = el("p", { class: "tcb-hint" });
		const preview = el("div", { class: "tcb-scan-pages" });
		const button = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: `Show the ${action.count} changes` });
		let planned = null;

		button.addEventListener("click", async () => {
			button.disabled = true;
			try {
				if (!planned) {
					status.textContent = "Working out what would change…";
					const result = await api("/api/seo/fix-titles", {
						method: "POST",
						body: JSON.stringify({ ending: action.ending, replacement: action.replacement, preview: true }),
					});
					planned = result.changes || [];
					preview.replaceChildren(
						...planned.map((change) =>
							el("p", { class: "tcb-hint", text: `${change.path}: “${change.from}” → “${change.to}”` })
						)
					);
					if (!planned.length) {
						status.textContent = "Nothing left to change — these have been edited already.";
						button.remove();
						return;
					}
					status.textContent = `${planned.length} titles would change. Nothing has been written yet.`;
					button.textContent = `Apply to ${planned.length} pages`;
					button.disabled = false;
					return;
				}

				status.textContent = "Applying…";
				const result = await api("/api/seo/fix-titles", {
					method: "POST",
					body: JSON.stringify({ ending: action.ending, replacement: action.replacement }),
				});
				button.remove();
				preview.replaceChildren();
				status.textContent =
					`Changed ${result.changed} titles.` +
					(result.skipped ? ` ${result.skipped} left alone because they had already been edited by hand.` : "") +
					" Live now, and revertable a page at a time from each page's own editor.";
			} catch (error) {
				button.disabled = false;
				status.textContent = error.message;
			}
		});

		return el("div", {}, [
			el("p", {
				class: "tcb-hint",
				text: `How: it replaces the ending “| ${action.ending}” with “| ${action.replacement}” on the titles that already repeat its last word, and only those. Pages you have edited yourself are left alone. The change is live as soon as it runs, and “Sync to code” writes it into the HTML files permanently.`,
			}),
			el("div", { class: "tcb-suggest-row" }, [button, status]),
			preview,
		]);
	}

	// One line of memory between scans: what the last one counted, and whether
	// this one is better or worse. localStorage rather than the server -- the
	// numbers are only meaningful to whoever runs the scans, and this browser
	// is where they run them.
	noteScanHistory(element, pages, siteFindings) {
		const count = (level) =>
			pages.reduce((sum, page) => sum + page.findings.filter((finding) => finding.level === level).length, 0) +
			siteFindings.filter((finding) => finding.level === level).length;
		const now = { when: Date.now(), problems: count("problem"), looks: count("worth a look") };

		try {
			const last = JSON.parse(localStorage.getItem("tcb-seo-scan-history") || "null");
			if (last && typeof last.problems === "number") {
				const date = new Date(last.when).toLocaleDateString();
				const shift =
					now.problems === last.problems && now.looks === last.looks
						? "no change"
						: `now ${now.problems} and ${now.looks}`;
				element.textContent = `Last scan (${date}): ${last.problems} to fix, ${last.looks} worth a look — ${shift}.`;
			}
			localStorage.setItem("tcb-seo-scan-history", JSON.stringify(now));
		} catch {
			// Private browsing or a full quota; the scan itself is unaffected.
		}
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

	// "Suggest" next to a field of a post that does not exist yet.
	//
	// The published-page version below cannot serve this: it works from a
	// path, and the whole point of the composer is that there is no page at
	// that path. This posts the half-written form instead, so a suggestion
	// for the third section is written knowing the title and the first two.
	//
	// `readDraft` is a function rather than a snapshot because it is called
	// at click time -- the form has usually moved on since the button was
	// built, and that later state is exactly the context worth sending.
	buildDraftSuggestions(kind, input, readDraft, onPick = () => {}) {
		const status = el("p", { class: "tcb-hint" });
		const options = el("div", { class: "tcb-suggestions" });
		const button = el("button", { type: "button", class: "tcb-btn tcb-btn-small", text: "Suggest" });

		button.addEventListener("click", async () => {
			button.disabled = true;
			options.replaceChildren();
			status.className = "tcb-hint";
			status.textContent = "Writing a few options…";

			let result;
			try {
				result = await api("/api/seo/draft-field", {
					method: "POST",
					body: JSON.stringify({ kind, draft: readDraft(), current: input.value }),
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
				// Never silently empty -- everything having been thrown out is
				// a real outcome with a real reason, and a button that appears
				// to do nothing reads as broken.
				status.className = "tcb-hint tcb-hint-warn";
				status.textContent = result.rejected.length
					? `Every option was thrown out — ${result.rejected[0].reason}. Worth trying again.`
					: "Nothing came back. Worth trying again.";
				return;
			}

			status.textContent = `Click one to use it.${modelNote(result)}${priceNote(result)}`;
			if (result.asked) status.className = "tcb-hint tcb-hint-warn";

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

			if (result.rejected.length) {
				const details = el("details", { class: "tcb-rejected" }, [
					el("summary", { text: `${result.rejected.length} thrown out` }),
					...result.rejected.map((entry) => el("p", { class: "tcb-hint", text: `“${entry.text}” — ${entry.reason}` })),
				]);
				options.appendChild(details);
			}
		});

		return el("div", { class: "tcb-suggest-row" }, [button, status, options]);
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

			// Says what it was actually working from, because "it just made
			// something up" is the reasonable default assumption otherwise.
			const from = [`this page`, `${result.usedExamples} others for the house style`];
			if (result.usedSearches) from.push(`the ${result.usedSearches} searches people used to find it`);
			if (result.usedGaps) from.push(`${result.usedGaps} phrases Google shows it for but it never mentions`);
			status.textContent = `Written from ${from.join(", ")}. Click one to use it.${modelNote(result)}${priceNote(result)}`;
			// A fallback is not a failure, but it is not what was asked for
			// either, and on a paid model it is the difference between getting
			// what you are paying for and not.
			if (result.asked) status.className = "tcb-hint tcb-hint-warn";

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

		return el("div", { class: "tcb-suggest-row" }, [el("div", { class: "tcb-btn-row" }, [button]), steer, status, options]);
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
	// The bar's own way into Sync to code. Same panel the Changes dialog shows;
	// what it adds is saying plainly which changes it covers, because the three
	// kinds of change here reach the code in three different ways and that is
	// not something anyone should have to work out from the result.
	openSync() {
		this.openDialog(
			"Sync to code",
			[
				el("p", {
					class: "tcb-hint",
					text: "Writes every published wording change, on every page, into the site's code as one change. The site looks the same afterwards — the code just catches up with it.",
				}),
				el("p", {
					class: "tcb-hint",
					text: "Unpublished drafts are not included: publish them first. Layout, menu and picture changes do not need this — they are written into the code the moment you save them. Text styling (size and colour) stays as a live setting and is not written into the code.",
				}),
				this.buildSyncPanel(),
			],
			null,
			{ confirmLabel: null, cancelLabel: "Close" }
		);
	}

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
		{ confirmLabel = "Save", cancelLabel = "Cancel", onCancel = null, extraActions = [], successMessage = "Saved as a draft. Publish when you're ready." } = {}
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
					if (successMessage) this.toast(successMessage);
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
