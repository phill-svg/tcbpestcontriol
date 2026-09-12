// POST /api/content/structure -- moving blocks in the file, not in an overlay.
//
// This route is the only one in the editor that writes to the repository
// instead of the database, and it does it straight to main. Nothing here talks
// to GitHub or D1 for real, but the decisions it makes before committing are
// the ones worth pinning: which requests it refuses, and what ends up in the
// commit when it does not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleContentApi } from "../src/content-edits.js";

const SESSION = { username: "phill", isAdmin: true };
const ENV_BASE = { GITHUB_TOKEN: "test-token", GITHUB_REPO: "owner/repo" };

const PAGE = ["<body><main>", "\t<p>First.</p>", "\t<p>Second.</p>", "\t<p>Third.</p>", "</main></body>"].join("\n");

// Answers the four shapes this route asks for and records the writes.
function stubDb({ hasDraft = false, published = [] } = {}) {
	const marked = [];
	const db = {
		prepare(sql) {
			const query = { sql, args: [] };
			query.bind = (...args) => {
				query.args = args;
				return query;
			};
			query.run = async () => ({});
			query.first = async () => (/draft IS NOT NULL/.test(sql) ? (hasDraft ? { found: 1 } : null) : null);
			query.all = async () => ({ results: /published IS NOT NULL/.test(sql) ? published : [] });
			return query;
		},
		batch: async (statements) => {
			marked.push(...statements);
			return [];
		},
	};
	return { db, marked };
}

function stubGitHub(fileContents) {
	const commits = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const path = new URL(url).pathname;
		const method = options.method || "GET";
		const body = options.body ? JSON.parse(options.body) : null;
		const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

		if (method === "GET" && path.includes("/contents/")) {
			return reply({ content: Buffer.from(fileContents, "utf8").toString("base64"), sha: "filesha" });
		}
		if (method === "GET" && path.endsWith("/git/ref/heads/main")) return reply({ object: { sha: "headsha" } });
		if (method === "GET" && path.includes("/git/commits/")) return reply({ tree: { sha: "basetree" } });
		if (method === "POST" && path.endsWith("/git/blobs")) {
			commits.push(Buffer.from(body.content, "base64").toString("utf8"));
			return reply({ sha: "blobsha" });
		}
		if (method === "POST" && path.endsWith("/git/trees")) return reply({ sha: "treesha" });
		if (method === "POST" && path.endsWith("/git/commits")) return reply({ sha: "commitsha", html_url: "https://github.test/c/1" });
		if (method === "PATCH") return reply({ ok: true });
		return reply({ message: `unexpected ${method} ${path}` }, 500);
	};
	return { commits, restore: () => (globalThis.fetch = original) };
}

async function callStructure(body, { db, file = PAGE, env = {} } = {}) {
	const github = stubGitHub(file);
	try {
		const response = await handleContentApi(
			new Request("https://site.test/api/content/structure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			new URL("https://site.test/api/content/structure"),
			{ ...ENV_BASE, ...env, DB: db },
			SESSION
		);
		return { status: response.status, body: await response.json(), commits: github.commits };
	} finally {
		github.restore();
	}
}

test("a move is committed as one file, with only that block moved", async () => {
	const { db } = stubDb();
	const { status, body, commits } = await callStructure({ path: "/ant-control", ops: [{ op: "move", block: 0, to: { after: 2 } }] }, { db });

	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.changed, true);
	assert.equal(commits.length, 1, "one file, one blob");
	assert.equal(commits[0], ["<body><main>", "\t<p>Second.</p>", "\t<p>Third.</p>", "\t<p>First.</p>", "</main></body>"].join("\n"));
});

test("unpublished wording changes block a rearrangement", async () => {
	// Which of the two would win depends on the order the buttons happened to
	// be pressed in, so neither does.
	const { db } = stubDb({ hasDraft: true });
	const { status, body, commits } = await callStructure({ path: "/ant-control", ops: [{ op: "delete", block: 1 }] }, { db });

	assert.equal(status, 409);
	assert.match(body.error, /unpublished wording changes/i);
	assert.equal(commits.length, 0, "nothing may be written");
});

test("published wording is baked into the file before anything moves", async () => {
	// The ordering that matters. An override is addressed by hashing its words
	// plus how many identical copies come before it; moving blocks can change
	// which copy it lands on. Resolving it first, against the document it was
	// written for, is what stops that.
	const { db, marked } = stubDb({
		published: [{ address: "t:1occxjx1wil9yj:0", original: "First.", published: "Rewritten." }],
	});
	const { status, body, commits } = await callStructure(
		{ path: "/ant-control", ops: [{ op: "move", block: 0, to: { after: 2 } }] },
		{ db }
	);

	assert.equal(status, 200, JSON.stringify(body));
	// If the address above stops matching the fixture this silently proves
	// nothing, so assert the bake actually happened.
	assert.equal(body.edits, 1, "the published override should have been baked in");
	assert.ok(commits[0].includes("<p>Rewritten.</p>"));
	assert.ok(!commits[0].includes("<p>First.</p>"));
	// Baked rows are marked synced, never deleted -- the overlay has to keep
	// serving until the deploy lands.
	assert.equal(marked.length, 1);
});

test("a published override that no longer matches the file stops the whole thing", async () => {
	// It would still be applying as an overlay after this commit, against a
	// page whose blocks have moved -- which is exactly when it can land on the
	// wrong copy of a repeated sentence.
	const { db } = stubDb({
		published: [{ address: "t:aaaaaaa:bbbbbbb:0", original: "Words that are not on the page", published: "Anything" }],
	});
	const { status, body, commits } = await callStructure({ path: "/ant-control", ops: [{ op: "delete", block: 1 }] }, { db });

	assert.equal(status, 409);
	assert.match(body.error, /no longer matches the file/);
	assert.equal(commits.length, 0);
});

test("a move that lands a block back where it already was makes no commit", async () => {
	// Block 0 dropped just before block 1 is where block 0 already is. The
	// splice is real and the result is byte-identical, so there is nothing to
	// commit -- and committing anyway would spend a deploy on an empty diff.
	const { db } = stubDb();
	const { status, body, commits } = await callStructure({ path: "/ant-control", ops: [{ op: "move", block: 0, to: { before: 1 } }] }, { db });

	assert.equal(status, 200);
	assert.equal(body.changed, false);
	assert.equal(commits.length, 0);
});

test("a malformed request is refused before GitHub is touched", async () => {
	const { db } = stubDb();
	for (const body of [{}, { path: "/ant-control" }, { path: "not-a-path", ops: [{ op: "delete", block: 0 }] }, { path: "/ant-control", ops: [] }]) {
		const result = await callStructure(body, { db });
		assert.equal(result.status, 400, JSON.stringify(body));
		assert.equal(result.commits.length, 0);
	}
});

test("without a GitHub token it says how to set one up, rather than failing", async () => {
	const { db } = stubDb();
	const { status, body } = await callStructure({ path: "/ant-control", ops: [{ op: "delete", block: 0 }] }, { db, env: { GITHUB_TOKEN: "" } });
	assert.equal(status, 501);
	assert.ok(body.missing.includes("GITHUB_TOKEN"));
});
