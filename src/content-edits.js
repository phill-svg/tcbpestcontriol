// Server side of the visual site editor.
//
// Three jobs live here:
//   1. Storing edits in D1 (a draft value and a published value per address).
//   2. Applying published edits to every page as it streams through
//      HTMLRewriter, so a copy change is live the moment it's published --
//      no deploy, no cache purge.
//   3. The admin API the browser editor talks to.
//
// The static HTML files in the repo stay the source of truth. Edits made
// here are an overlay on top of them, and scripts/sync-content-edits.js
// bakes the overlay back into the files. Once a page's text has been baked
// in, the matching override simply stops matching (its `original` text is no
// longer in the file) and becomes an inert row -- it can never double-apply.
//
// See assets/js/content-address.js for how an edit names its target, and
// EDITING-GUIDE.md for the whole workflow written for a non-developer.

import {
	normaliseText,
	normalisePath,
	hashValue,
	EDITABLE_ATTRS,
	MAX_TEXT_LENGTH,
	MAX_ATTR_LENGTH,
	SKIPPED_ELEMENTS,
	isSafeHref,
	isSafeImageSrc,
	META_TITLE_ADDRESS,
	META_DESCRIPTION_ADDRESS,
} from "../assets/js/content-address.js";
import { decodeEntities, escapeHtmlText } from "./html-entities.js";

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS content_edits (
  path         TEXT NOT NULL,
  address      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  original     TEXT NOT NULL,
  draft        TEXT,
  published    TEXT,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_at INTEGER,
  PRIMARY KEY (path, address)
)`;

// Published copy shows up within this long at the outside. Every HTML page
// view would otherwise cost a D1 round trip, which is a real latency tax on
// a marketing site, so each Worker isolate keeps its answers this long.
// Publishing clears the cache in the isolate that handled it; the rest catch
// up as their entries expire, which is why the editor waits a moment before
// reloading after a publish.
const CACHE_TTL_MS = 30_000;

// Per-isolate caches. `pathIndex` is the important one: it answers "does
// this page have any published edits at all?" for every page on the site in
// a single small query, so the ~200 pages that have never been edited cost
// nothing beyond one shared lookup per isolate per 30s.
let pathIndex = null; // { paths: Set<string>, expires: number }
const pageCache = new Map(); // path -> { edits: Map<address, string>, expires: number }
let tableReady = false;
// "The table didn't exist last time I looked", with an expiry rather than a
// plain flag. The table is created lazily by the first save, which happens in
// one isolate; every *other* isolate has already concluded the table is
// missing. Left sticky, those isolates would go on serving unedited pages for
// as long as they lived, and a publish would appear to work for some visitors
// and not others.
let tableMissingUntil = 0;

function invalidateCaches() {
	pathIndex = null;
	pageCache.clear();
}

// The table is created on demand rather than by a manual migration step.
// Everything else in this repo is deploy-and-go, and asking for a
// `wrangler d1 execute` before the editor works would be a trap.
async function ensureTable(env) {
	if (tableReady) return;
	await env.DB.prepare(TABLE_DDL).run();
	tableReady = true;
	tableMissingUntil = 0;
}

// Reads tolerate the table not existing yet (nobody has saved an edit on
// this deployment), because a missing table must never take the site down.
async function readSafely(env, run) {
	if (Date.now() < tableMissingUntil) return null;
	try {
		return await run();
	} catch (error) {
		if (String(error && error.message).includes("no such table")) {
			tableMissingUntil = Date.now() + CACHE_TTL_MS;
			return null;
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadPathIndex(env) {
	if (pathIndex && pathIndex.expires > Date.now()) return pathIndex.paths;
	const result = await readSafely(env, () =>
		env.DB.prepare("SELECT DISTINCT path FROM content_edits WHERE published IS NOT NULL").all()
	);
	const paths = new Set((result && result.results ? result.results : []).map((row) => row.path));
	pathIndex = { paths, expires: Date.now() + CACHE_TTL_MS };
	return paths;
}

// The address -> value map to apply to a page, or null if there is nothing
// to do. `includeDrafts` is the preview mode an admin sees: unpublished
// drafts win over published values, so you can look at a change in place
// before anyone else sees it.
export async function loadPageEdits(env, path, { includeDrafts = false } = {}) {
	const normalised = normalisePath(path);

	if (!includeDrafts) {
		const paths = await loadPathIndex(env);
		if (!paths.has(normalised)) return null;

		const cached = pageCache.get(normalised);
		if (cached && cached.expires > Date.now()) return cached.edits.size ? cached.edits : null;
	}

	const result = await readSafely(env, () =>
		env.DB.prepare("SELECT address, original, draft, published FROM content_edits WHERE path = ?").bind(normalised).all()
	);
	const rows = result && result.results ? result.results : [];

	const edits = new Map();
	for (const row of rows) {
		const value = includeDrafts && row.draft !== null && row.draft !== undefined ? row.draft : row.published;
		if (value === null || value === undefined) continue;
		edits.set(row.address, value);
	}

	if (!includeDrafts) {
		pageCache.set(normalised, { edits, expires: Date.now() + CACHE_TTL_MS });
	}
	return edits.size ? edits : null;
}

// ---------------------------------------------------------------------------
// Applying edits to a streaming HTML response
// ---------------------------------------------------------------------------

// Attaches the override handlers to an HTMLRewriter that is already being
// built up in src/index.js. Returns the same rewriter so it can be chained.
//
// Everything here is keyed off content the page already contains, so a
// stale override (one whose text has since been changed in the source file,
// or baked in by the sync script) matches nothing and is silently ignored.
export function applyContentEdits(rewriter, edits) {
	if (!edits || !edits.size) return rewriter;

	// Depth counter rather than a boolean: <svg> can nest, and a <script>
	// inside a skipped subtree would otherwise clear the flag early.
	let skipDepth = 0;
	const ordinals = new Map();
	let buffer = "";

	const nextOrdinal = (key) => {
		const seen = ordinals.get(key) || 0;
		ordinals.set(key, seen + 1);
		return seen;
	};

	for (const tag of SKIPPED_ELEMENTS) {
		rewriter.on(tag, {
			element(el) {
				skipDepth++;
				// Void or self-closing elements never get an end tag, and asking
				// for one throws. None of the skipped tags are void, but an
				// `<svg/>` in the source would be, so this stays defensive.
				try {
					el.onEndTag(() => {
						skipDepth--;
					});
				} catch {
					skipDepth--;
				}
			},
		});
	}

	rewriter.on("*", {
		text(chunk) {
			if (skipDepth > 0) return;

			buffer += chunk.text;
			if (!chunk.lastInTextNode) {
				// A text node essentially always arrives in more than one chunk
				// (workerd emits a trailing empty chunk to mark the end, and
				// splits again around character references). Everything has to be
				// held back until the node is complete, because the address
				// depends on the whole node's text rather than on whichever
				// fragment happened to arrive first.
				chunk.remove();
				return;
			}

			const raw = buffer;
			buffer = "";

			// Chunks were removed above, so this handler is now responsible for
			// emitting the node -- returning early here would delete the text
			// from the page. `html: true` is what makes the restore exact:
			// `chunk.text` is the *raw* source, entities and all, and re-emitting
			// it in escaping mode would turn `&amp;` into `&amp;amp;`.
			const emit = (html) => chunk.replace(html, { html: true });

			// The browser reads this text from the DOM, where entities are
			// already decoded, so decode here too or nothing containing an
			// apostrophe or an ampersand would ever match.
			const normalised = normaliseText(decodeEntities(raw));
			if (!normalised) {
				// Pure whitespace between tags. It takes no ordinal (the browser
				// walk skips it too) and needs no rewriting.
				emit(raw);
				return;
			}

			const address = `t:${hashValue(normalised)}:${nextOrdinal(`t|${normalised}`)}`;
			const replacement = edits.get(address);
			if (replacement === undefined) {
				emit(raw);
				return;
			}

			// Keep the node's surrounding whitespace so the page's source
			// formatting survives -- without this an edited paragraph collapses
			// onto one line, and every later diff of the file is noise.
			const leading = raw.match(/^\s*/)[0];
			const trailing = raw.match(/\s*$/)[0];
			// Escaped by hand, because the exact-restore requirement above forces
			// `html: true`. This is what stops a stored edit becoming injected
			// markup.
			emit(`${leading}${escapeHtmlText(replacement)}${trailing}`);
		},
	});

	for (const [tag, attrs] of Object.entries(EDITABLE_ATTRS)) {
		rewriter.on(tag, {
			element(el) {
				for (const attr of attrs) {
					const current = el.getAttribute(attr);
					if (current === null) continue;
					// Attribute values arrive raw as well -- an href written
					// `?a=1&amp;b=2` comes back with the entity intact, while the
					// browser reports the decoded `?a=1&b=2`. Decode so both sides
					// hash the same string.
					const normalised = normaliseText(decodeEntities(current));
					const key = `${tag}|${attr}|${normalised}`;
					const address = `a:${tag}:${attr}:${hashValue(normalised)}:${nextOrdinal(key)}`;
					const replacement = edits.get(address);
					// setAttribute escapes quotes but leaves `&` alone, so a value
					// containing something like `&copy;` would be re-decoded by the
					// browser. Escaping the ampersand keeps it literal.
					if (replacement !== undefined) el.setAttribute(attr, replacement.replace(/&/g, "&amp;"));
				}
			},
		});
	}

	const title = edits.get(META_TITLE_ADDRESS);
	if (title !== undefined) {
		rewriter.on("title", {
			element(el) {
				el.setInnerContent(title);
			},
		});
	}

	const description = edits.get(META_DESCRIPTION_ADDRESS);
	if (description !== undefined) {
		rewriter.on('meta[name="description"]', {
			element(el) {
				el.setAttribute("content", description);
			},
		});
		// Keep the social-preview tags in step. Leaving them behind is the
		// classic way an edited description silently fails to show up when the
		// page is shared to Facebook or a group chat.
		rewriter.on('meta[property="og:description"], meta[name="twitter:description"]', {
			element(el) {
				el.setAttribute("content", description);
			},
		});
	}

	if (title !== undefined) {
		rewriter.on('meta[property="og:title"], meta[name="twitter:title"]', {
			element(el) {
				el.setAttribute("content", title);
			},
		});
	}

	return rewriter;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Splits an address back into its parts, or null if it isn't one we issued.
// Everything arriving from the browser goes through here before it is
// allowed anywhere near the database.
export function parseAddress(address) {
	if (typeof address !== "string" || address.length > 200) return null;
	if (address === META_TITLE_ADDRESS) return { kind: "meta", field: "title" };
	if (address === META_DESCRIPTION_ADDRESS) return { kind: "meta", field: "description" };

	// "t:<hash>:<ordinal>" is three parts; "a:<tag>:<attr>:<hash>:<ordinal>"
	// is five. Both end in the ordinal, which is always digits.
	const parts = address.split(":");
	if (parts[0] === "t" && parts.length === 3 && /^\d+$/.test(parts[2])) {
		return { kind: "text" };
	}
	if (parts[0] === "a" && parts.length === 5 && /^\d+$/.test(parts[4])) {
		const [, tag, attr] = parts;
		const allowed = EDITABLE_ATTRS[tag];
		if (!allowed || !allowed.includes(attr)) return null;
		return { kind: "attr", tag, attr };
	}
	return null;
}

// Returns { value } for something safe to store, or { error } explaining why
// not in words the editor can show the user directly.
export function validateValue(parsed, rawValue) {
	if (typeof rawValue !== "string") return { error: "Missing value." };

	// Strip control characters (a stray one pasted in from Word breaks the
	// page text in ways that are invisible in the editor) but keep tab,
	// newline and carriage return, which are legitimate inside a paragraph.
	const value = rawValue.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

	if (parsed.kind === "text") {
		if (!value) return { error: "Text cannot be empty. Use Revert to restore the original wording." };
		if (value.length > MAX_TEXT_LENGTH) return { error: `Text is too long (limit ${MAX_TEXT_LENGTH} characters).` };
		return { value };
	}

	if (parsed.kind === "meta") {
		if (!value) return { error: "This cannot be empty." };
		if (value.length > 500) return { error: "This is too long (limit 500 characters)." };
		return { value };
	}

	if (value.length > MAX_ATTR_LENGTH) return { error: `Value is too long (limit ${MAX_ATTR_LENGTH} characters).` };
	if (parsed.attr === "href") {
		if (!isSafeHref(value)) return { error: "Links must be a page on this site, or start with https://, mailto: or tel:." };
		return { value };
	}
	if (parsed.attr === "src") {
		if (!isSafeImageSrc(value)) return { error: "Images must be a file already on this site, starting with /assets/." };
		return { value };
	}
	// alt text: empty is meaningful (it marks an image as decorative).
	return { value };
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "Cache-Control": "no-store" },
	});
}

async function readJsonBody(request) {
	try {
		const body = await request.json();
		return body && typeof body === "object" ? body : null;
	} catch {
		return null;
	}
}

// Every route below has already been gated on an admin session by
// src/index.js -- `session` is the verified one, never anything the client
// claimed. Editing site copy is deliberately admin-only rather than
// staff-wide: the chat dashboard is a day-to-day tool, this rewrites the
// public website.
export async function handleContentApi(request, url, env, session) {
	const route = url.pathname.slice("/api/content/".length);

	if (route === "edits" && request.method === "GET") {
		const path = normalisePath(url.searchParams.get("path") || "/");
		await ensureTable(env);
		const result = await env.DB.prepare(
			"SELECT address, kind, original, draft, published, updated_by, updated_at, published_at FROM content_edits WHERE path = ? ORDER BY updated_at DESC"
		)
			.bind(path)
			.all();
		return json({ path, edits: result.results || [] });
	}

	if (route === "save" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);

		const path = normalisePath(body.path || "/");
		const parsed = parseAddress(body.address);
		if (!parsed) return json({ error: "Unrecognised edit target." }, 400);

		const checked = validateValue(parsed, body.value);
		if (checked.error) return json({ error: checked.error }, 400);

		const original = typeof body.original === "string" ? body.original.slice(0, MAX_TEXT_LENGTH) : "";
		if (!original && parsed.kind !== "meta") return json({ error: "Unrecognised edit target." }, 400);

		await ensureTable(env);
		// The original is written once and never overwritten on later saves:
		// it records what the HTML file actually says, which is what the sync
		// script searches for. Overwriting it with a previous draft would
		// break that link the second time you edited the same sentence.
		await env.DB.prepare(
			`INSERT INTO content_edits (path, address, kind, original, draft, published, updated_by, updated_at, published_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
			 ON CONFLICT (path, address) DO UPDATE SET
			   draft = excluded.draft,
			   updated_by = excluded.updated_by,
			   updated_at = excluded.updated_at`
		)
			.bind(path, body.address, parsed.kind, original, checked.value, session.username, Date.now())
			.run();

		invalidateCaches();
		return json({ ok: true, path, address: body.address, value: checked.value });
	}

	if (route === "publish" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);
		const path = normalisePath(body.path || "/");

		await ensureTable(env);
		// Only rows that actually carry a draft are touched, so publishing
		// twice is a no-op rather than something that re-stamps every row.
		const result = await env.DB.prepare(
			`UPDATE content_edits
			 SET published = draft, draft = NULL, published_at = ?, updated_by = ?
			 WHERE path = ? AND draft IS NOT NULL`
		)
			.bind(Date.now(), session.username, path)
			.run();

		invalidateCaches();
		return json({ ok: true, path, published: (result.meta && result.meta.changes) || 0 });
	}

	if (route === "discard" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);
		const path = normalisePath(body.path || "/");

		await ensureTable(env);
		await env.DB.prepare("UPDATE content_edits SET draft = NULL WHERE path = ? AND draft IS NOT NULL").bind(path).run();
		// A row with neither a draft nor a published value is just noise.
		await env.DB.prepare("DELETE FROM content_edits WHERE path = ? AND draft IS NULL AND published IS NULL").bind(path).run();

		invalidateCaches();
		return json({ ok: true, path });
	}

	if (route === "revert" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);
		const path = normalisePath(body.path || "/");
		if (typeof body.address !== "string") return json({ error: "Invalid request." }, 400);

		await ensureTable(env);
		// Deleting the row is what "restore the original wording" means: with
		// no override, the page falls straight back through to the HTML file.
		await env.DB.prepare("DELETE FROM content_edits WHERE path = ? AND address = ?").bind(path, body.address).run();

		invalidateCaches();
		return json({ ok: true, path, address: body.address });
	}

	if (route === "pages" && request.method === "GET") {
		await ensureTable(env);
		const result = await env.DB.prepare(
			`SELECT path,
			        SUM(CASE WHEN draft IS NOT NULL THEN 1 ELSE 0 END) AS drafts,
			        SUM(CASE WHEN published IS NOT NULL THEN 1 ELSE 0 END) AS published,
			        MAX(updated_at) AS updated_at
			 FROM content_edits
			 GROUP BY path
			 ORDER BY updated_at DESC`
		).all();
		return json({ pages: result.results || [] });
	}

	if (route === "export" && request.method === "GET") {
		await ensureTable(env);
		const result = await env.DB.prepare(
			"SELECT path, address, kind, original, published, updated_by, published_at FROM content_edits WHERE published IS NOT NULL ORDER BY path, address"
		).all();
		return json({ exportedAt: Date.now(), edits: result.results || [] });
	}

	// Called by scripts/sync-content-edits.js once it has written the edits
	// into the HTML files and the change is committed. Dropping the rows is
	// tidiness rather than correctness -- a baked-in edit no longer matches
	// anything -- but leaving them would slowly turn the override table into
	// a graveyard that makes the editor's change list unreadable.
	if (route === "mark-synced" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body || !Array.isArray(body.entries)) return json({ error: "Invalid request." }, 400);
		const cleared = await clearSyncedEdits(env, body.entries);
		return json({ ok: true, cleared });
	}

	return json({ error: "Not found." }, 404);
}

// Clearing overrides after they have been baked into the HTML files. The
// sync script reports exactly which addresses it wrote, and only those are
// dropped -- anything it could not match stays put so the site keeps showing
// the edit until the mismatch is sorted out.
export async function clearSyncedEdits(env, entries) {
	if (!Array.isArray(entries) || !entries.length) return 0;
	await ensureTable(env);
	const statements = entries
		.filter((entry) => entry && typeof entry.path === "string" && typeof entry.address === "string")
		.map((entry) =>
			env.DB.prepare("DELETE FROM content_edits WHERE path = ? AND address = ? AND published IS NOT NULL").bind(
				normalisePath(entry.path),
				entry.address
			)
		);
	if (!statements.length) return 0;
	await env.DB.batch(statements);
	invalidateCaches();
	return statements.length;
}
