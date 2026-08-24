// The one-click fix for stale social tags.
//
// The fix is deliberately boring: publish an override equal to what the page
// already says, and the serving layer rewrites og:title / og:description to
// match. What has to be pinned is the boring part staying boring -- that the
// value written is the page's own wording and nothing else, that an existing
// override is never clobbered, and that a page whose tags already match gets
// a no-op rather than a pointless row.

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleSeoSocialFix } from "../src/content-edits.js";

// A minimal D1. ensureTable runs DDL through the same prepare()/run() path
// (and without bind), so only the INSERT is recorded as a write -- the DDL is
// plumbing, not behaviour under test.
function fakeDb(existingRow = null) {
	const writes = [];
	return {
		writes,
		prepare(sql) {
			let args = [];
			const statement = {
				bind(...bound) {
					args = bound;
					return statement;
				},
				first: async () => (sql.startsWith("SELECT") ? existingRow : null),
				run: async () => {
					if (sql.includes("INSERT")) writes.push({ sql, args });
					return { meta: { changes: 1 } };
				},
				all: async () => ({ results: [] }),
			};
			return statement;
		},
	};
}

const request = (body) => ({ json: async () => body });
const session = { username: "phill" };

const PAGE = {
	title: "Slater & Pill Bug Control Canberra | TCB Pest Control",
	description: "Slaters gathering under pots and along damp edges, treated at the source.",
	ogTitle: "Slater & Pill Bug Control Canberra | TCB Pest Control Canberra",
	ogDescription: "Slaters gathering under pots and along damp edges, treated at the source.",
};

const deps = (summary = PAGE, status = 200) => ({
	fetchPage: async () => ({ status }),
	extract: async () => ({ ...summary }),
});

test("a drifted og:title is fixed by publishing the page's own title", async () => {
	const db = fakeDb();
	const response = await handleSeoSocialFix(request({ path: "/slater-control", field: "title" }), { DB: db }, session, deps());
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.value, PAGE.title, "the value written is the page's wording, never the stale tag's");
	assert.equal(db.writes.length, 1);
	const write = db.writes[0];
	assert.match(write.sql, /INSERT INTO content_edits/);
	// path, address, original, published, user, updated_at, published_at
	assert.equal(write.args[0], "/slater-control");
	assert.equal(write.args[1], "m:title");
	assert.equal(write.args[2], PAGE.title, "original records the file's wording");
	assert.equal(write.args[3], PAGE.title, "published is the same wording -- no visible change");
	assert.equal(write.args[4], "phill");
});

test("tags that already match are a no-op, not a row", async () => {
	const db = fakeDb();
	const response = await handleSeoSocialFix(
		request({ path: "/slater-control", field: "title" }),
		{ DB: db },
		session,
		deps({ ...PAGE, ogTitle: PAGE.title })
	);
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.ok(body.already, "the button gets told there was nothing to do");
	assert.equal(db.writes.length, 0);
});

test("whitespace and case are not drift here either", async () => {
	// The check and the fix have to agree on what counts as out of step, or
	// the panel reports nothing and the button writes a row anyway.
	const db = fakeDb();
	const response = await handleSeoSocialFix(
		request({ path: "/slater-control", field: "title" }),
		{ DB: db },
		session,
		deps({ ...PAGE, ogTitle: `  ${PAGE.title.toUpperCase()}  ` })
	);
	assert.ok((await response.json()).already);
	assert.equal(db.writes.length, 0);
});

test("an existing override is never clobbered", async () => {
	// Somebody's published edit already keeps the tags in step; replacing it
	// with the file's wording would be a downgrade dressed as a repair.
	const db = fakeDb({ draft: null, published: "A title somebody chose on purpose" });
	const response = await handleSeoSocialFix(request({ path: "/slater-control", field: "title" }), { DB: db }, session, deps());
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.ok(body.already);
	assert.equal(db.writes.length, 0);
});

test("a drifted og:description works the same way through m:description", async () => {
	const db = fakeDb();
	await handleSeoSocialFix(
		request({ path: "/about", field: "description" }),
		{ DB: db },
		session,
		deps({ ...PAGE, ogDescription: "An old description nobody updated" })
	);
	assert.equal(db.writes.length, 1);
	assert.equal(db.writes[0].args[1], "m:description");
	assert.equal(db.writes[0].args[3], PAGE.description);
});

test("bad input and unreadable pages are refused, not guessed at", async () => {
	assert.equal((await handleSeoSocialFix(request({ path: "/a", field: "canonical" }), { DB: fakeDb() }, session, deps())).status, 400);
	assert.equal((await handleSeoSocialFix(request(null), { DB: fakeDb() }, session, deps())).status, 400);
	assert.equal(
		(await handleSeoSocialFix(request({ path: "/gone", field: "title" }), { DB: fakeDb() }, session, deps(PAGE, 404))).status,
		502
	);
	// A page with no title at all has nothing to bring the tags into step with.
	assert.equal(
		(await handleSeoSocialFix(request({ path: "/a", field: "title" }), { DB: fakeDb() }, session, deps({ ...PAGE, title: "" }))).status,
		409
	);
});
