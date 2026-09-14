// POST /api/content/menu -- the header menu, written into every page at once.
//
// This route commits to main and touches every page on the site, so the tests
// are about what it refuses and what ends up in the commit. Nothing talks to
// GitHub, D1 or Cloudflare for real: all three are stubbed, and the stubs
// record every request so the number of calls to GitHub can be pinned too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { handleContentApi } from "../src/content-edits.js";

const SESSION = { username: "phill", isAdmin: true };
const ENV_BASE = { GITHUB_TOKEN: "test-token", GITHUB_REPO: "owner/repo" };

// A page shaped like the real ones: both menus, and a mobile button that is
// not the usual one.
const page = (words, button = "Get a Quote") =>
	[
		"<header>",
		'<nav class="main-nav">',
		'<a href="/residential">Residential</a>',
		'<a href="/blog">Blog</a>',
		"</nav>",
		'<nav class="mobile-nav">',
		'<a href="/residential">Residential</a>',
		'<a href="/blog">Blog</a>',
		'<a href="tel:0261059771">02 6105 9771</a>',
		`<a class="btn btn-primary" href="/book">${button}</a>`,
		"</nav>",
		"</header>",
		`<main><p>${words}</p></main>`,
	].join("\n");

const FILES = {
	"about/index.html": page("About us."),
	"ant-control/index.html": page("Ants.", "Book Today"),
	"404.html": page("Not found."),
	// Kept out of the deployed assets on purpose, so it has to be read from GitHub.
	"_blog-template.html": page("{{INTRO}}"),
	"staff-chat/index.html": "<html><body>No menu here.</body></html>",
};
const TEMPLATES = new Set(["_blog-template.html"]);

const flat = (pairs) => ({ items: pairs.map(([label, href]) => ({ label, href, children: [] })) });
const CURRENT = flat([["Residential", "/residential"], ["Blog", "/blog"]]);
const WITH_DROPDOWN = {
	items: [
		{ label: "Residential", href: "/residential", children: [{ label: "Ant Control", href: "/ant-control" }] },
		{ label: "Blog", href: "/blog", children: [] },
	],
};

const blobSha = (text) => {
	const bytes = Buffer.from(text, "utf8");
	return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
};

function stubDb({ draftOn = null, overrides = [] } = {}) {
	return {
		prepare(sql) {
			const query = { bind: () => query };
			query.run = async () => ({});
			query.first = async () => (/draft IS NOT NULL/.test(sql) && draftOn ? { path: draftOn } : null);
			query.all = async () => ({ results: /synced_at IS NULL/.test(sql) ? overrides : [] });
			return query;
		},
		batch: async () => [],
	};
}

// `deployed` overrides what the assets binding serves for a path, to simulate
// a deploy that has not caught up with the branch.
function stubAssets(deployed = {}) {
	return {
		fetch: async (request) => {
			const path = new URL(request.url).pathname.slice(1);
			if (TEMPLATES.has(path) || !(path in FILES)) return new Response("not found", { status: 404 });
			return new Response(path in deployed ? deployed[path] : FILES[path], { status: 200 });
		},
	};
}

function stubGitHub({ headAtCommitTime = "headsha" } = {}) {
	const calls = [];
	let tree = null;
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const path = new URL(url).pathname;
		const method = options.method || "GET";
		const body = options.body ? JSON.parse(options.body) : null;
		calls.push(`${method} ${path}`);
		const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

		// The first ref read is the one readTree makes; later ones are commitFiles.
		if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
			const refReads = calls.filter((call) => call.endsWith("/git/ref/heads/main")).length;
			return reply({ object: { sha: refReads === 1 ? "headsha" : headAtCommitTime } });
		}
		if (method === "GET" && path.includes("/git/commits/")) return reply({ tree: { sha: "basetree" } });
		if (method === "GET" && path.includes("/git/trees/")) {
			return reply({ truncated: false, tree: Object.entries(FILES).map(([p, text]) => ({ path: p, type: "blob", sha: blobSha(text) })) });
		}
		if (method === "GET" && path.includes("/contents/")) {
			const file = decodeURIComponent(path.split("/contents/")[1]);
			return reply({ content: Buffer.from(FILES[file], "utf8").toString("base64") });
		}
		if (method === "POST" && path.endsWith("/git/trees")) {
			tree = body;
			return reply({ sha: "newtree" });
		}
		if (method === "POST" && path.endsWith("/git/commits")) return reply({ sha: "newcommit" });
		if (method === "PATCH") return reply({ ok: true });
		return reply({ message: `unexpected ${method} ${path}` }, 500);
	};
	return { calls, tree: () => tree, restore: () => (globalThis.fetch = original) };
}

async function saveMenu(body, { db = stubDb(), assets = stubAssets(), github: githubOptions } = {}) {
	const github = stubGitHub(githubOptions);
	try {
		const response = await handleContentApi(
			new Request("https://site.test/api/content/menu", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			new URL("https://site.test/api/content/menu"),
			{ ...ENV_BASE, DB: db, ASSETS: assets },
			SESSION
		);
		return { status: response.status, body: await response.json(), calls: github.calls, tree: github.tree() };
	} finally {
		github.restore();
	}
}

const committed = (tree, path) => (tree.tree.find((entry) => entry.path === path) || {}).content;

test("a menu change is one commit holding every page, both kinds of template and menu.json", async () => {
	const { status, body, tree } = await saveMenu({ menu: WITH_DROPDOWN });
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.changed, true);

	const paths = tree.tree.map((entry) => entry.path).sort();
	assert.deepEqual(paths, ["404.html", "_blog-template.html", "about/index.html", "ant-control/index.html", "assets/menu.json"]);
	// The page with no menu is left alone rather than refused.
	assert.ok(!paths.includes("staff-chat/index.html"));

	assert.ok(committed(tree, "about/index.html").includes('<div class="nav-item has-menu">'));
	assert.deepEqual(JSON.parse(committed(tree, "assets/menu.json")).items[0].children, [{ label: "Ant Control", href: "/ant-control" }]);
});

test("each page keeps its own mobile button", async () => {
	const { tree } = await saveMenu({ menu: WITH_DROPDOWN });
	assert.ok(committed(tree, "ant-control/index.html").includes('href="/book">Book Today</a>'));
	assert.ok(committed(tree, "about/index.html").includes('href="/book">Get a Quote</a>'));
});

test("the whole save stays well inside a free-plan Worker's 50 requests to the internet", async () => {
	// Pages are read from the Worker's own assets and written inline in one
	// tree, so the number of GitHub calls does not grow with the number of
	// pages. One blob upload per page would put 139 pages at nearly 290.
	const { calls, tree } = await saveMenu({ menu: WITH_DROPDOWN });
	assert.ok(calls.length <= 10, `${calls.length} GitHub calls: ${calls.join(", ")}`);
	assert.ok(!calls.some((call) => call.endsWith("/git/blobs")), "text files should go inline, not as blobs");
	assert.ok(tree.tree.every((entry) => typeof entry.content === "string"));
});

test("a deployed page that does not match the branch stops the save", async () => {
	// The deploy of a recent commit has not landed yet. Writing this copy back
	// would undo that commit on this page.
	const { status, body, tree } = await saveMenu(
		{ menu: WITH_DROPDOWN },
		{ assets: stubAssets({ "about/index.html": page("An older version of this page.") }) }
	);
	assert.equal(status, 409);
	assert.match(body.error, /still rebuilding/);
	assert.deepEqual(body.stale, ["about/index.html"]);
	assert.equal(tree, null, "nothing may be written");
});

test("a push that lands while the save is being built stops it", async () => {
	// The pages were checked against one commit; writing them on top of a
	// newer one would silently undo whatever that newer commit changed.
	const { status, body, tree } = await saveMenu({ menu: WITH_DROPDOWN }, { github: { headAtCommitTime: "someone-else-pushed" } });
	assert.equal(status, 409, JSON.stringify(body));
	assert.match(body.error, /changed while this was being prepared/);
	assert.equal(tree, null);
});

test("an override on words the menu change would renumber stops the save, and says which", async () => {
	// Adding "Ant Control" to the menu puts two more copies of those words
	// ahead of any on the page, so a style override on them would move.
	const db = stubDb({ overrides: [{ path: "/about", kind: "style", original: "Ant Control" }] });
	const { status, body, tree } = await saveMenu({ menu: WITH_DROPDOWN }, { db });
	assert.equal(status, 409);
	assert.match(body.error, /"Ant Control" on \/about/);
	assert.deepEqual(body.conflicts, [{ path: "/about", text: "Ant Control" }]);
	assert.equal(tree, null);
});

test("an override on a link address the change renumbers stops it too", async () => {
	const db = stubDb({ overrides: [{ path: "/about", kind: "attr", original: "/ant-control" }] });
	const { status, body } = await saveMenu({ menu: WITH_DROPDOWN }, { db });
	assert.equal(status, 409);
	assert.deepEqual(body.conflicts, [{ path: "/about", text: "/ant-control" }]);
});

test("reordering the menu renumbers nothing, so an override does not block it", async () => {
	// No copy of any text moves past another copy of itself.
	const db = stubDb({ overrides: [{ path: "/about", kind: "style", original: "Blog" }] });
	const reversed = { items: [...CURRENT.items].reverse() };
	const { status, body } = await saveMenu({ menu: reversed }, { db });
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.changed, true);
});

test("an override on another page does not block this change", async () => {
	const db = stubDb({ overrides: [{ path: "/somewhere-else", kind: "style", original: "Ant Control" }] });
	const { status } = await saveMenu({ menu: WITH_DROPDOWN }, { db });
	assert.equal(status, 200);
});

test("a dry run does every check and writes nothing", async () => {
	const { status, body, tree } = await saveMenu({ menu: WITH_DROPDOWN, dryRun: true });
	assert.equal(status, 200);
	assert.equal(body.dryRun, true);
	assert.equal(body.files, 4);
	assert.equal(tree, null);
});

test("saving the menu that is already there makes no commit", async () => {
	const { status, body, tree } = await saveMenu({ menu: CURRENT });
	assert.equal(status, 200);
	assert.equal(body.changed, false);
	assert.equal(tree, null);
});

test("unpublished wording changes anywhere block a menu change", async () => {
	const { status, body, calls } = await saveMenu({ menu: WITH_DROPDOWN }, { db: stubDb({ draftOn: "/pricing" }) });
	assert.equal(status, 409);
	assert.match(body.error, /\/pricing/);
	assert.equal(calls.length, 0, "refused before GitHub is touched");
});

test("a menu that is not valid is refused before anything is read", async () => {
	const { status, body, calls } = await saveMenu({ menu: flat([["Bad", "javascript:alert(1)"]]) });
	assert.equal(status, 400);
	assert.match(body.error, /does not point at an address/);
	assert.equal(calls.length, 0);
});
