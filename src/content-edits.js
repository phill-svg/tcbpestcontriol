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
	sanitiseStyle,
} from "../assets/js/content-address.js";
import { decodeEntities, escapeHtmlText, escapeStyleAttribute } from "./html-entities.js";
import { MINIMUM_ENDING } from "../assets/js/seo-site.js";
import { bakeEdits, pathToFile } from "./bake-edits.js";
import { missingConfig, setupMessage, readFile, commitFiles, decodeBase64Utf8 } from "./github-sync.js";
import { applyStructure } from "./page-structure.js";

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
  synced_at    INTEGER,
  PRIMARY KEY (path, address)
)`;

// Added after the table shipped, so existing deployments need it bolted on.
const TABLE_COLUMNS = [["synced_at", "INTEGER"]];

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
	// CREATE TABLE IF NOT EXISTS does nothing for a table that already exists,
	// so columns added later have to be bolted on separately. Duplicates throw
	// and are ignored -- there is no "ADD COLUMN IF NOT EXISTS" in SQLite.
	for (const [column, type] of TABLE_COLUMNS) {
		try {
			await env.DB.prepare(`ALTER TABLE content_edits ADD COLUMN ${column} ${type}`).run();
		} catch (error) {
			if (!String(error && error.message).includes("duplicate column")) throw error;
		}
	}
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

			// One ordinal serves both namespaces: a run can carry a wording
			// change and a styling change at once without the two colliding.
			const ordinal = nextOrdinal(`t|${normalised}`);
			const hash = hashValue(normalised);
			const replacement = edits.get(`t:${hash}:${ordinal}`);
			const style = edits.get(`s:${hash}:${ordinal}`);

			if (replacement === undefined && !style) {
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
			// markup. When there is no wording change the original bytes are kept
			// verbatim, entities and all.
			const core =
				replacement === undefined
					? raw.slice(leading.length, raw.length - trailing.length)
					: escapeHtmlText(replacement);

			// Styling wraps the run rather than setting an attribute on its
			// parent: HTMLRewriter has already emitted the opening tag by the
			// time the text arrives, and a <span> also confines the styling to
			// this run rather than to everything else the element contains.
			const body = style ? `<span style="${escapeStyleAttribute(style)}">${core}</span>` : core;
			emit(`${leading}${body}${trailing}`);
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
	if (parts[0] === "s" && parts.length === 3 && /^\d+$/.test(parts[2])) {
		return { kind: "style" };
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
		// An empty value is a deletion, not a mistake: the override is stored
		// and the words simply stop being rendered. It is fully reversible --
		// the original is still in the HTML file and in the `original` column,
		// so Revert brings it straight back -- which is why this needs no
		// confirmation step of its own.
		if (value.length > MAX_TEXT_LENGTH) return { error: `Text is too long (limit ${MAX_TEXT_LENGTH} characters).` };
		return { value };
	}

	if (parsed.kind === "style") {
		// Rebuilt from the allowlist rather than accepted as written, so what
		// gets stored is always a strict subset of the permitted properties --
		// see sanitiseStyle in content-address.js. An empty result means every
		// declaration was rejected, or the styling was cleared; both are stored
		// as "" and render as no <span> at all.
		return { value: sanitiseStyle(value) };
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
			"SELECT address, kind, original, draft, published, updated_by, updated_at, published_at, synced_at FROM content_edits WHERE path = ? ORDER BY updated_at DESC"
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
			"SELECT path, address, kind, original, published, updated_by, published_at FROM content_edits WHERE published IS NOT NULL AND kind != 'style' ORDER BY path, address"
		).all();
		return json({ exportedAt: Date.now(), edits: result.results || [] });
	}

	// One-click "Sync to code": bakes every published edit into the HTML files
	// on GitHub and pushes a single commit. See src/github-sync.js for why the
	// Worker does this itself rather than handing it to a scheduled job.
	if (route === "sync" && request.method === "POST") {
		const missing = missingConfig(env);
		if (missing.length) return json({ error: setupMessage(missing), missing }, 501);
		await ensureTable(env);

		const result = await env.DB.prepare(
			"SELECT path, address, original, published FROM content_edits WHERE published IS NOT NULL AND synced_at IS NULL AND kind != 'style' ORDER BY path, address"
		).all();
		const rows = result.results || [];
		if (!rows.length) return json({ ok: true, files: 0, edits: 0, message: "Everything is already in the code." });

		const branch = env.GITHUB_BRANCH || "main";
		const byPath = new Map();
		for (const row of rows) {
			if (!byPath.has(row.path)) byPath.set(row.path, []);
			byPath.get(row.path).push(row);
		}

		const files = [];
		const problems = [];
		const synced = [];

		for (const [pagePath, edits] of byPath) {
			const filePath = pathToFile(pagePath);
			let file;
			try {
				file = await readFile(env, filePath, branch);
			} catch (error) {
				problems.push(`${pagePath}: ${error.message}`);
				continue;
			}

			const html = decodeBase64Utf8(file.content);
			const { html: updated, applied, missing } = bakeEdits(html, new Map(edits.map((e) => [e.address, e.published])));

			for (const address of missing) {
				const edit = edits.find((candidate) => candidate.address === address);
				// Left unsynced on purpose, so the override keeps serving the live
				// site and the mismatch stays visible instead of being swallowed.
				problems.push(`${pagePath}: could not find ${JSON.stringify(edit ? edit.original : address)} in the file`);
			}
			if (updated !== html) files.push({ path: filePath, content: updated });
			for (const address of applied) synced.push({ path: pagePath, address });
		}

		if (!files.length) {
			// "Nothing needed changing" is only true when nothing went wrong.
			// If every file failed to read -- a token without Contents access
			// reads as a 403 on all of them -- that message would report a
			// success that never happened, which is the worst possible answer.
			if (problems.length) {
				return json(
					{
						ok: false,
						files: 0,
						edits: 0,
						problems,
						message: `Nothing could be written. ${problems[0]}`,
					},
					409
				);
			}
			return json({ ok: true, files: 0, edits: 0, problems, message: "Nothing needed changing in the code." });
		}

		let commit;
		try {
			commit = await commitFiles(
				env,
				branch,
				files,
				`Sync published copy edits\n\n${synced.length} ${synced.length === 1 ? "edit" : "edits"} across ${files.length} ${
					files.length === 1 ? "file" : "files"
				}, from the visual editor.`
			);
		} catch (error) {
			console.error("Content sync commit failed:", error && (error.stack || error.message));
			return json({ error: `Could not push the commit: ${error.message}` }, 502);
		}

		// Marked, never deleted -- and this is the ordering that matters. The
		// commit only reaches visitors once Cloudflare finishes redeploying,
		// which takes a minute or two. Deleting the overrides now would leave a
		// window where the files are not live yet and the overrides are already
		// gone, so the site would briefly serve the *old* wording. Marked rows
		// carry on applying, become inert the moment the deploy lands (their
		// original text is no longer in the file, so they match nothing), and
		// are harmless from then on.
		await markEditsSynced(env, synced);

		return json({ ok: true, files: files.length, edits: synced.length, commit, problems });
	}

	// Moving, adding and removing whole blocks on one page.
	//
	// Unlike every other route here, this does not write to content_edits at
	// all -- it writes the HTML file in the repository. Structure is position,
	// and an override is addressed by hashing words, so there is nothing an
	// overlay could store that would describe "this paragraph now comes
	// third". The file is the only place that fact can live.
	//
	// The cost is the deploy: the commit lands at once but visitors see it a
	// minute or two later, when Cloudflare finishes rebuilding. That is why
	// the editor batches a whole rearrangement into one call rather than
	// sending each drag.
	if (route === "structure" && request.method === "POST") {
		const missing = missingConfig(env);
		if (missing.length) return json({ error: setupMessage(missing), missing }, 501);

		const body = await readJsonBody(request);
		const path = typeof body?.path === "string" && body.path.startsWith("/") ? normalisePath(body.path) : null;
		const ops = Array.isArray(body?.ops) ? body.ops : null;
		if (!path || !ops || !ops.length) return json({ error: "Expected a path and something to do." }, 400);

		await ensureTable(env);

		// Unpublished wording changes on this page are a draft of a document
		// this is about to rewrite. Which of the two wins would depend on the
		// order somebody happened to press the buttons in, so neither does:
		// finish the wording first.
		const pendingDraft = await env.DB.prepare("SELECT 1 AS found FROM content_edits WHERE path = ? AND draft IS NOT NULL LIMIT 1")
			.bind(path)
			.first();
		if (pendingDraft) {
			return json({ error: "There are unpublished wording changes on this page. Publish or revert them first." }, 409);
		}

		const branch = env.GITHUB_BRANCH || "main";
		const filePath = pathToFile(path);
		let file;
		try {
			file = await readFile(env, filePath, branch);
		} catch (error) {
			return json({ error: `Could not read ${filePath}: ${error.message}` }, 502);
		}
		const source = decodeBase64Utf8(file.content);

		// Published overrides are baked in first, before a single block moves.
		//
		// The order is the whole point. An override is addressed by the hash of
		// its words plus how many identical copies of those words come before
		// it on the page -- so moving blocks around can change which copy an
		// override lands on, and the addressing has no way to notice. Baking
		// first resolves every override against the document it was written
		// for; after that they are text in the file and structure cannot
		// retarget them.
		const pending = await env.DB.prepare(
			"SELECT address, original, published FROM content_edits WHERE path = ? AND published IS NOT NULL AND synced_at IS NULL AND kind != 'style' ORDER BY address"
		)
			.bind(path)
			.all();
		const rows = pending.results || [];

		let html = source;
		const synced = [];
		if (rows.length) {
			const baked = bakeEdits(html, new Map(rows.map((row) => [row.address, row.published])));
			// An override that cannot be found is one that would still be
			// applying as an overlay after this commit -- against a page whose
			// blocks have moved. That is exactly the case where it could land on
			// the wrong copy of a repeated sentence, so nothing is written.
			if (baked.missing.length) {
				const first = rows.find((row) => row.address === baked.missing[0]);
				return json(
					{
						error: `A published wording change on this page no longer matches the file (${JSON.stringify(
							first ? first.original : baked.missing[0]
						)}). Sync to code first, or revert it.`,
					},
					409
				);
			}
			html = baked.html;
			for (const address of baked.applied) synced.push({ path, address });
		}

		const result = applyStructure(html, ops);
		if (result.error) return json({ error: result.error }, 400);
		if (result.html === source) return json({ ok: true, changed: false, message: "That would not change anything." });

		let commit;
		try {
			commit = await commitFiles(env, branch, [{ path: filePath, content: result.html }], structureMessage(path, ops));
		} catch (error) {
			console.error("Structure commit failed:", error && (error.stack || error.message));
			return json({ error: `Could not push the commit: ${error.message}` }, 502);
		}

		// Same reasoning as the sync route: marked, never deleted, because the
		// commit is not live until the deploy lands and the overrides have to
		// keep serving until then.
		if (synced.length) await markEditsSynced(env, synced);

		return json({ ok: true, changed: true, commit, applied: result.applied, edits: synced.length });
	}

	// Called by scripts/sync-content-edits.js once it has written the edits
	// into the HTML files and the change is committed. Dropping the rows is
	// tidiness rather than correctness -- a baked-in edit no longer matches
	// anything -- but leaving them would slowly turn the override table into
	// a graveyard that makes the editor's change list unreadable.
	if (route === "mark-synced" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body || !Array.isArray(body.entries)) return json({ error: "Invalid request." }, 400);
		const cleared = await markEditsSynced(env, body.entries);
		return json({ ok: true, cleared });
	}

	// Putting a new picture into assets/images/ from the editor.
	//
	// Until now the image picker could only offer pictures somebody had already
	// committed by hand, which meant a copy change anybody could make and an
	// image change only a developer could. There is nowhere else for the file
	// to go: there is no R2 bucket and no KV namespace on this Worker, and the
	// ASSETS binding is read-only by design. The repository is the only
	// writable file store this thing has, so an upload is a commit.
	//
	// It is two files in one commit, not one. assets/images/manifest.json is a
	// committed build artefact -- scripts/build-image-manifest.js writes it,
	// and the picker fetches it as a plain static file, because Cloudflare's
	// static assets have no "list the directory" API. An image committed
	// without its manifest entry is invisible to the very picker the upload
	// exists to feed. Re-emitted in exactly the build script's format (tab
	// indent, trailing newline, sorted by path) so that the next local
	// `npm run build:images` produces no diff -- otherwise every upload leaves
	// a landmine for whoever next runs the build.
	//
	// Same deploy lag as the sync and structure routes above: the commit lands
	// immediately, but Cloudflare has to rebuild before the file is actually
	// served, which takes a minute or two. Until then the picker will list the
	// new path and the image itself will 404. That is why the response says so
	// in words rather than leaving the editor to look broken.
	if (route === "upload-image" && request.method === "POST") {
		// JSON only, and the header is checked rather than trusted to have been
		// what the browser sent. A cross-site application/json POST is
		// preflighted, so the browser asks permission before it ever reaches
		// here; multipart/form-data and text/plain are "simple" requests that
		// are not, and request.json() will happily parse a text/plain body that
		// was shaped to look like JSON. Refusing anything but application/json
		// is what makes the CSRF argument actually true.
		if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) {
			return json({ error: "Send this as application/json." }, 415);
		}

		const missing = missingConfig(env);
		if (missing.length) return json({ error: setupMessage(missing), missing }, 501);

		const body = await readJsonBody(request);
		if (!body || typeof body.name !== "string" || typeof body.base64 !== "string") {
			return json({ error: "Expected a name and a base64 image." }, 400);
		}

		const slug = slugifyImageName(body.name);
		if (!IMAGE_SLUG.test(slug)) {
			return json({ error: "Name the picture with letters, numbers and dashes -- 61 characters at most." }, 400);
		}

		// Four base64 characters carry three bytes, so the encoded length is an
		// upper bound on the decoded one. Checking it first means a 40 MB paste
		// is refused without first being expanded into a binary string in an
		// isolate with a hard memory limit.
		const encoded = body.base64.replace(/\s+/g, "");
		if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
			return json({ error: "That picture is too big. Keep it under 2 MB." }, 413);
		}

		let binary;
		try {
			binary = atob(encoded);
		} catch {
			// atob throws on anything that is not base64. Left uncaught this
			// would be a 500, which reads as "the server is broken" when the
			// truth is "that was not a file".
			return json({ error: "That file could not be read." }, 400);
		}
		if (binary.length > MAX_IMAGE_BYTES) {
			return json({ error: "That picture is too big. Keep it under 2 MB." }, 413);
		}

		// The trust boundary. The name came from the client and the bytes came
		// from the client, so nothing said so far establishes what this file
		// is; only the file's own header does. A RIFF/WEBP container is what
		// src/assets.js can serve and negotiate, and anything else committed
		// under a .webp name would be served with the wrong content type to
		// every visitor until somebody noticed.
		if (binary.slice(0, 4) !== "RIFF" || binary.slice(8, 12) !== "WEBP") {
			return json({ error: "Only WebP images can be uploaded. Convert the picture to .webp first." }, 400);
		}

		const branch = env.GITHUB_BRANCH || "main";
		let manifest;
		try {
			manifest = JSON.parse(decodeBase64Utf8((await readFile(env, IMAGE_MANIFEST_FILE, branch)).content));
		} catch (error) {
			// Deliberately not falling back to an empty list. Writing a fresh
			// manifest containing only the new picture would delete every
			// existing image from the picker in the same commit, which is a far
			// worse outcome than a failed upload.
			return json({ error: `Could not read the image list: ${error.message}` }, 502);
		}
		if (!manifest || !Array.isArray(manifest.images)) {
			return json({ error: "The image list in the repository is not in the expected format." }, 502);
		}

		const taken = new Set(manifest.images.map((image) => image && image.path));
		let sitePath = `/assets/images/${slug}.webp`;
		if (taken.has(sitePath)) {
			// Never overwrite. Two people uploading "logo" a month apart are not
			// asking to replace each other's picture, and the older one is
			// probably already referenced from a page. The suffix is derived
			// from the bytes rather than random, following the existing
			// tcb-pest-control-logo-03284.webp naming, so re-uploading the very
			// same file twice converges on one name instead of littering.
			sitePath = `/assets/images/${slug}-${contentSuffix(encoded)}.webp`;
			// Same name and same bytes: this file is already committed. Report
			// where it lives rather than spending a deploy on a no-op commit.
			if (taken.has(sitePath)) {
				return json({ ok: true, path: sitePath, existing: true, message: "That picture is already on the site." });
			}
		}

		manifest.images.push({ path: sitePath, bytes: binary.length });
		// Byte-for-byte the build script's output: it sorts filenames under a
		// constant directory prefix, which is the same order as sorting the
		// paths, and writes tab-indented JSON with a trailing newline.
		manifest.images.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

		let commit;
		try {
			commit = await commitFiles(
				env,
				branch,
				[
					// base64, not content: the bytes are already encoded and
					// encodeBase64Utf8 would run them through TextEncoder and
					// destroy them. See the note on commitFiles.
					{ path: sitePath.slice(1), base64: encoded },
					{ path: IMAGE_MANIFEST_FILE, content: `${JSON.stringify(manifest, null, "\t")}\n` },
				],
				`Add ${sitePath} from the visual editor`
			);
		} catch (error) {
			console.error("Image upload commit failed:", error && (error.stack || error.message));
			return json({ error: `Could not push the commit: ${error.message}` }, 502);
		}

		return json({
			ok: true,
			path: sitePath,
			commit,
			message: "Uploaded. The picture goes live once Cloudflare finishes deploying, usually a minute or two.",
		});
	}

	return json({ error: "Not found." }, 404);
}

// The picker's list, and the only thing that makes an uploaded image findable.
const IMAGE_MANIFEST_FILE = "assets/images/manifest.json";

// 2 MB decoded. Generous for a WebP -- the largest picture on the site today
// is under 90 KB -- and small enough that the whole thing comfortably fits in
// a Worker isolate alongside its base64, which is a third larger again.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Long enough for a descriptive name, short enough that the URL stays
// readable. Must start alphanumeric so no path can begin with a dash.
const IMAGE_SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

function slugifyImageName(name) {
	// The trailing extension goes first. A file input hands over "My Photo.webp"
	// and slugging that whole string gives "my-photo-webp", which would then be
	// committed as my-photo-webp.webp and sit in the picker under that name for
	// good. Callers that send a bare name lose nothing: a name genuinely ending
	// in something like ".2" is not a name worth protecting.
	return name
		.replace(/\.[a-z0-9]{1,5}$/i, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Five digits, matching the names already in assets/images/. Derived from the
// content so it is stable: the same file always lands on the same name.
function contentSuffix(encoded) {
	return String(parseInt(hashValue(encoded).slice(0, 7), 36) % 100000).padStart(5, "0");
}

// Fixing a stale social tag with one click, by publishing the page's own
// current wording as an override.
//
// The og:title and twitter:title lines in a file drift when the <title> is
// edited by hand and the social pair is forgotten -- the first run of the
// drift check found eight pages doing exactly that. The machinery to fix it
// already exists twice over: serving a published title override rewrites the
// social tags to match (applyContentEdits above), and "Sync to code" bakes
// the same rewrite into the HTML file. So the entire fix is publishing an
// override equal to what the page already says. Not a single character a
// visitor reads changes; the stale social tags snap into step, first served
// and then, on the next sync, in the file itself.
//
// Published directly, skipping the draft stage, because there is no
// editorial decision in it to review -- the value is, by construction, the
// wording the page already has.
//
// `fetchPage` and `extract` are injected so this stays testable in Node;
// the Worker wires in the assets binding and the HTMLRewriter extractor.
export async function handleSeoSocialFix(request, env, session, { fetchPage, extract }) {
	const body = await readJsonBody(request);
	if (!body) return json({ error: "Invalid request." }, 400);
	const path = normalisePath(body.path || "/");
	const field = body.field === "title" || body.field === "description" ? body.field : null;
	if (!field) return json({ error: "Expected field to be title or description." }, 400);
	const address = field === "title" ? META_TITLE_ADDRESS : META_DESCRIPTION_ADDRESS;

	const response = await fetchPage(path);
	if (!response || response.status !== 200) {
		return json({ error: `Could not read ${path} (${response ? response.status : "no response"}).` }, 502);
	}
	const summary = await extract(response);
	const value = String(field === "title" ? summary.title : summary.description || "").trim();
	if (!value) return json({ error: `The page has no ${field} to bring the social tags into step with.` }, 409);

	await ensureTable(env);
	// An existing override already keeps the social tags in step every time
	// the page is served -- there is nothing stale left to fix, and quietly
	// replacing somebody's edit with the file's wording would be a downgrade
	// dressed up as a repair.
	const existing = await env.DB.prepare("SELECT draft, published FROM content_edits WHERE path = ? AND address = ?")
		.bind(path, address)
		.first();
	if (existing && (existing.draft !== null || existing.published !== null)) {
		return json({ ok: true, path, field, already: "an override for this page already keeps them in step" });
	}

	// Nothing to do is a real answer: the button can be pressed on a page
	// whose tags were fixed some other way since the scan ran.
	const social = field === "title" ? summary.ogTitle : summary.ogDescription;
	const same = (a, b) => String(a || "").replace(/\s+/g, " ").trim().toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().toLowerCase();
	if (social === null || social === undefined || same(social, value)) {
		return json({ ok: true, path, field, already: "the social tags already match" });
	}

	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO content_edits (path, address, kind, original, draft, published, updated_by, updated_at, published_at)
		 VALUES (?, ?, 'meta', ?, NULL, ?, ?, ?, ?)
		 ON CONFLICT (path, address) DO UPDATE SET
		   published = excluded.published,
		   draft = NULL,
		   updated_by = excluded.updated_by,
		   updated_at = excluded.updated_at,
		   published_at = excluded.published_at`
	)
		.bind(path, address, value, value, session.username, now, now)
		.run();

	invalidateCaches();
	return json({ ok: true, path, field, value });
}

// Replacing the shared ending on every title that repeats its last word.
//
// The one bulk edit in this panel, and the only one that changes pages the
// person pressing the button is not looking at. Three things follow from that.
//
// It runs in preview first: the browser asks for the list, shows it, and only
// a second press writes anything. It re-reads every page rather than trusting
// the list the scan produced, because a scan is a snapshot and titles can have
// changed since. And it skips any page carrying a title somebody set by hand
// -- overwriting a deliberate edit with a mechanical one is a downgrade, and
// the whole point of the rule is that it only removes a repeated word.
export async function handleSeoTitleEndings(request, env, session, { paths, fetchPage, extract }) {
	const body = await readJsonBody(request);
	if (!body) return json({ error: "Invalid request." }, 400);
	const ending = String(body.ending || "").trim();
	const replacement = String(body.replacement || "").trim();
	if (!ending || !replacement) return json({ error: "Expected an ending and a replacement." }, 400);
	if (replacement.length >= ending.length) return json({ error: "The replacement has to be shorter than the ending." }, 400);
	// The same floor the check applies, enforced again here rather than
	// trusted from the browser. The panel is one caller; a stale tab holding
	// last week's finding is another, and this endpoint rewrites titles across
	// the whole site, so "the client already checked" is not good enough.
	if (
		ending.toLowerCase().startsWith(MINIMUM_ENDING.toLowerCase()) &&
		replacement.length < MINIMUM_ENDING.length
	) {
		return json({ error: `The ending has to keep at least “${MINIMUM_ENDING}” — that is the name of the business.` }, 400);
	}

	// Which words come off, and therefore which titles are eligible at all.
	const removed = ending
		.slice(replacement.length)
		.toLowerCase()
		.match(/[a-z0-9]+/g);
	if (!removed || !removed.length) return json({ error: "That replacement removes nothing." }, 400);

	await ensureTable(env);
	const edited = new Set();
	const { results: overrides } = await env.DB.prepare(
		"SELECT path FROM content_edits WHERE address = ? AND (draft IS NOT NULL OR published IS NOT NULL)"
	)
		.bind(META_TITLE_ADDRESS)
		.all();
	for (const row of overrides || []) edited.add(row.path);

	const changes = [];
	let skipped = 0;
	for (const path of paths) {
		if (edited.has(path)) {
			skipped++;
			continue;
		}
		let summary;
		try {
			const response = await fetchPage(path);
			if (!response || response.status !== 200) continue;
			summary = await extract(response);
		} catch {
			continue;
		}
		const title = String(summary.title || "").trim();
		const at = title.lastIndexOf("|");
		if (at < 0 || title.slice(at + 1).trim() !== ending) continue;
		const head = title.slice(0, at).trim();
		if (!removed.some((word) => head.toLowerCase().includes(word))) continue;
		changes.push({ path, from: title, to: `${head} | ${replacement}` });
	}

	if (body.preview) return json({ ok: true, preview: true, changes, skipped });

	const now = Date.now();
	for (const change of changes) {
		await env.DB.prepare(
			`INSERT INTO content_edits (path, address, kind, original, draft, published, updated_by, updated_at, published_at)
			 VALUES (?, ?, 'meta', ?, NULL, ?, ?, ?, ?)
			 ON CONFLICT (path, address) DO UPDATE SET
			   published = excluded.published,
			   draft = NULL,
			   updated_by = excluded.updated_by,
			   updated_at = excluded.updated_at,
			   published_at = excluded.published_at`
		)
			.bind(change.path, META_TITLE_ADDRESS, change.from, change.to, session.username, now, now)
			.run();
	}

	invalidateCaches();
	return json({ ok: true, changed: changes.length, skipped, changes });
}

// Records that an edit's wording now lives in the HTML file as well.
//
// Deliberately a flag rather than a delete. A synced override carries on
// applying, which is what covers the gap between the commit landing and the
// deploy going out; once the file is live it matches nothing and costs a map
// lookup. Only addresses that were actually written are marked -- anything
// the bake could not match stays unsynced, so the site keeps showing it and
// the mismatch stays visible.

// A commit message that says what happened, so the repository history reads
// as a record of edits rather than a wall of "update page".
function structureMessage(path, ops) {
	const counts = { move: 0, insert: 0, delete: 0 };
	for (const op of ops) if (counts[op && op.op] !== undefined) counts[op.op]++;
	const parts = [];
	if (counts.move) parts.push(`moved ${counts.move} ${counts.move === 1 ? "block" : "blocks"}`);
	if (counts.insert) parts.push(`added ${counts.insert}`);
	if (counts.delete) parts.push(`removed ${counts.delete}`);
	const summary = parts.join(", ") || "changed the layout";
	return `Rearrange ${path}

${summary.charAt(0).toUpperCase()}${summary.slice(1)}, from the visual editor.`;
}

export async function markEditsSynced(env, entries) {
	if (!Array.isArray(entries) || !entries.length) return 0;
	await ensureTable(env);
	const now = Date.now();
	const statements = entries
		.filter((entry) => entry && typeof entry.path === "string" && typeof entry.address === "string")
		.map((entry) =>
			env.DB.prepare("UPDATE content_edits SET synced_at = ? WHERE path = ? AND address = ? AND published IS NOT NULL").bind(
				now,
				normalisePath(entry.path),
				entry.address
			)
		);
	if (!statements.length) return 0;
	await env.DB.batch(statements);
	invalidateCaches();
	return statements.length;
}
