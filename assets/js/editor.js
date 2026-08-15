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
} from "./content-address.js";

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
	const response = await fetch(`/api/content/${path}`, {
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
		throw new Error((body && body.error) || `Something went wrong (${response.status}).`);
	}
	return body || {};
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
	}

	// Current values are painted on *after* indexing, so the addresses stay
	// anchored to what the HTML file says while the screen shows what the site
	// currently says. Drafts win over published, so you always edit forward
	// from your own most recent change.
	paintStoredValues() {
		for (const [address, row] of this.rows) {
			const value = row.draft !== null && row.draft !== undefined ? row.draft : row.published;
			if (value === null || value === undefined) continue;
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
		} else {
			entry.element.setAttribute(entry.attr, value);
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
		this.status = el("span", { class: "tcb-bar-label", text: "Click any text to change it." });

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

		this.chip = chrome("div", { class: "tcb-chip" }, [
			el("button", { type: "button", class: "tcb-chip-btn", text: "Edit link", onclick: () => this.openAttrPanel() }),
		]);
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
			this.status.textContent = "Click any text to change it.";
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
		window.addEventListener("scroll", () => this.hideHover(), { passive: true });
		window.addEventListener("resize", () => this.hideHover());
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

	updateHover(event) {
		if (this.active || this.isChrome(event.target)) return this.hideHover();

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
		if (chipEntry) {
			this.chipEntry = chipEntry;
			this.chip.querySelector(".tcb-chip-btn").textContent = image ? "Change image" : "Edit link";
			this.chip.hidden = false;
			Object.assign(this.chip.style, {
				top: `${rect.top + window.scrollY - 12}px`,
				left: `${rect.left + window.scrollX + rect.width}px`,
			});
		} else {
			this.chip.hidden = true;
			this.chipEntry = null;
		}
	}

	hideHover() {
		this.hover.style.display = "none";
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
		const entry = this.closeActive(value || before);

		if (!value) {
			this.toast("Text can't be empty — use Changes → Revert to restore the original wording.", "error");
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
			this.toast("Saved as a draft. Publish when you're ready.");
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

		this.openDialog(
			"Page title & description",
			[
				el("p", { class: "tcb-hint", text: "This is what shows up as the heading and blurb in Google results." }),
				el("label", { class: "tcb-label" }, [el("span", { text: "Page title" }), titleInput]),
				el("label", { class: "tcb-label" }, [el("span", { text: "Description" }), descriptionInput]),
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

	async saveMeta(address, value, original) {
		if (!value) return;
		await api("save", { method: "POST", body: JSON.stringify({ path: PATH, address, original, value }) });
		const row = this.rows.get(address) || { address, kind: "meta", original, published: null };
		row.draft = value;
		this.rows.set(address, row);
		this.refreshStatus();
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
			list.appendChild(
				el("div", { class: "tcb-change" }, [
					el("span", { class: `tcb-tag ${pending ? "tcb-tag-draft" : "tcb-tag-live"}`, text: pending ? "Draft" : "Live" }),
					el("div", { class: "tcb-change-body" }, [
						el("p", { class: "tcb-change-was", text: row.original || "(page setting)" }),
						el("p", { class: "tcb-change-now", text: value }),
					]),
					el("button", {
						type: "button",
						class: "tcb-btn tcb-btn-quiet",
						text: "Revert",
						onclick: async (event) => {
							const button = event.currentTarget;
							button.disabled = true;
							try {
								await api("revert", { method: "POST", body: JSON.stringify({ path: PATH, address: row.address }) });
								const entry = this.entries.get(row.address);
								if (entry) {
									if (entry.kind === "text") entry.node.nodeValue = entry.originalRaw;
									else entry.element.setAttribute(entry.attr, entry.original);
									this.unmarkEdited(entry);
								}
								this.rows.delete(row.address);
								this.refreshStatus();
								button.closest(".tcb-change").remove();
								this.toast("Reverted to the original wording.");
							} catch (error) {
								button.disabled = false;
								this.toast(error.message, "error");
							}
						},
					}),
				])
			);
		}

		this.openDialog("Changes on this page", [list], null, { confirmLabel: null, cancelLabel: "Close" });
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

	openDialog(title, content, onConfirm, { confirmLabel = "Save", cancelLabel = "Cancel" } = {}) {
		const body = el("div", { class: "tcb-dialog-body" }, content);
		const error = el("p", { class: "tcb-dialog-error" });
		error.hidden = true;

		const actions = el("div", { class: "tcb-dialog-actions" });
		const close = () => overlay.remove();
		actions.appendChild(el("button", { type: "button", class: "tcb-btn tcb-btn-quiet", text: cancelLabel, onclick: close }));
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
			if (event.target === overlay) close();
		});
		document.addEventListener("keydown", function onKey(event) {
			if (event.key === "Escape") {
				close();
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
