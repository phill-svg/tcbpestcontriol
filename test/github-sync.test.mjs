// The "Sync to code" button pushes a commit to GitHub from inside the Worker.
// Nothing here talks to GitHub for real -- fetch is stubbed -- but the shape
// of the conversation matters: a wrong tree or a forced ref update would
// rewrite the repository's history, which is not the sort of thing to find
// out about in production.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isConfigured, commitFiles, readFile, decodeBase64Utf8, SETUP_MESSAGE } from "../src/github-sync.js";

const ENV = { GITHUB_TOKEN: "test-token", GITHUB_REPO: "owner/repo" };

// Records every call, and answers each endpoint with the minimum GitHub
// would return.
function stubGitHub({ failRefUpdate = false } = {}) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const path = new URL(url).pathname;
		const method = options.method || "GET";
		calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });

		const reply = (body, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

		if (method === "GET" && path.endsWith("/git/ref/heads/main")) return reply({ object: { sha: "headsha" } });
		if (method === "GET" && path.includes("/git/commits/")) return reply({ tree: { sha: "basetree" } });
		if (method === "POST" && path.endsWith("/git/blobs")) return reply({ sha: `blob${calls.length}` });
		if (method === "POST" && path.endsWith("/git/trees")) return reply({ sha: "newtree" });
		if (method === "POST" && path.endsWith("/git/commits")) return reply({ sha: "newcommit" });
		if (method === "PATCH" && path.includes("/git/refs/heads/main")) {
			return failRefUpdate ? reply({ message: "Update is not a fast forward" }, 422) : reply({ ok: true });
		}
		if (method === "GET" && path.includes("/contents/")) {
			return reply({ content: Buffer.from("<h1>Héllo — world</h1>", "utf8").toString("base64"), sha: "filesha" });
		}
		return reply({ message: "unexpected" }, 500);
	};
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
	};
}

test("isConfigured needs both the token and the repo", () => {
	assert.equal(isConfigured({}), false);
	assert.equal(isConfigured({ GITHUB_TOKEN: "x" }), false);
	assert.equal(isConfigured({ GITHUB_REPO: "o/r" }), false);
	assert.equal(isConfigured(ENV), true);
});

test("the setup message tells a non-developer what to actually do", () => {
	// This string is shown verbatim in the editor when the token is missing,
	// so it has to name the secret and where it goes.
	assert.match(SETUP_MESSAGE, /GITHUB_TOKEN/);
	assert.match(SETUP_MESSAGE, /GITHUB_REPO/);
	assert.match(SETUP_MESSAGE, /Contents/i);
});

test("commitFiles builds one commit from blobs, tree, commit, ref", async () => {
	const github = stubGitHub();
	try {
		const result = await commitFiles(ENV, "main", [
			{ path: "index.html", content: "<h1>one</h1>" },
			{ path: "about/index.html", content: "<h1>two</h1>" },
		], "Sync published copy edits");

		const sequence = github.calls.map((c) => `${c.method} ${c.path.replace("/repos/owner/repo", "")}`);
		assert.deepEqual(sequence, [
			"GET /git/ref/heads/main",
			"GET /git/commits/headsha",
			"POST /git/blobs",
			"POST /git/blobs",
			"POST /git/trees",
			"POST /git/commits",
			"PATCH /git/refs/heads/main",
		], "two files must still produce a single commit");

		const tree = github.calls.find((c) => c.path.endsWith("/git/trees"));
		assert.equal(tree.body.base_tree, "basetree", "must build on the current tree, not replace it");
		assert.deepEqual(
			tree.body.tree.map((entry) => entry.path),
			["index.html", "about/index.html"]
		);
		assert.ok(tree.body.tree.every((entry) => entry.mode === "100644" && entry.type === "blob"));

		const commit = github.calls.find((c) => c.path.endsWith("/git/commits") && c.method === "POST");
		assert.deepEqual(commit.body.parents, ["headsha"], "must descend from the current head");

		const ref = github.calls.find((c) => c.method === "PATCH");
		assert.equal(ref.body.force, false, "never force-push over whatever arrived in the meantime");

		assert.equal(result.sha, "newcommit");
		assert.match(result.url, /github\.com\/owner\/repo\/commit\/newcommit/);
	} finally {
		github.restore();
	}
});

test("a rejected ref update surfaces as an error rather than passing silently", async () => {
	// This is the case where someone pushed while the sync was being built.
	// Reporting it is the whole point of not forcing the update.
	const github = stubGitHub({ failRefUpdate: true });
	try {
		await assert.rejects(
			() => commitFiles(ENV, "main", [{ path: "index.html", content: "x" }], "msg"),
			/failed \(422\)/
		);
	} finally {
		github.restore();
	}
});

test("the token is sent as a bearer credential and never in the URL", async () => {
	const github = stubGitHub();
	try {
		await commitFiles(ENV, "main", [{ path: "index.html", content: "x" }], "msg");
		for (const call of github.calls) {
			assert.equal(call.headers.Authorization, "Bearer test-token");
			assert.doesNotMatch(call.path, /test-token/, "a token in a URL ends up in logs and referrers");
		}
	} finally {
		github.restore();
	}
});

test("file contents round-trip through base64 without mangling non-ASCII", async () => {
	// The site's copy is full of en dashes and curly quotes; reading a blob as
	// a binary string instead of decoding UTF-8 would corrupt every one.
	const github = stubGitHub();
	try {
		const file = await readFile(ENV, "index.html", "main");
		assert.equal(decodeBase64Utf8(file.content), "<h1>Héllo — world</h1>");
	} finally {
		github.restore();
	}
});

test("a page path with characters needing escaping is encoded once", async () => {
	const github = stubGitHub();
	try {
		await readFile(ENV, "locations-pest-control-o'connor/index.html", "main");
		const call = github.calls[0];
		assert.ok(call.path.includes("locations-pest-control-o"), call.path);
		assert.doesNotMatch(call.path, /%25/, "must not double-encode");
	} finally {
		github.restore();
	}
});
