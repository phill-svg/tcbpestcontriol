// The create/publish round trip, with GitHub and D1 stubbed.
//
// This writes real files into a real repository, so what matters is not just
// "did it return ok" but *which files* it wrote and what went in them. A post
// that publishes without reaching sitemap.xml is invisible to Google, and
// nothing about the response would tell you.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleBlogApi } from "../src/blog-api.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

// Files the Worker will ask GitHub for, answered from the real repository.
const FILES = {
	"_blog-template.html": read("_blog-template.html"),
	"blog/index.html": read("blog/index.html"),
	"sitemap.xml": read("sitemap.xml"),
	"feed.xml": read("feed.xml"),
	"assets/search-index.json": read("assets/search-index.json"),
};

function encode(text) {
	return Buffer.from(text, "utf8").toString("base64");
}

// A D1 stand-in holding rows in memory. Only the handful of statements this
// module issues need to work.
function stubDb() {
	const rows = [];
	return {
		rows,
		prepare(sql) {
			let bound = [];
			const statement = {
				bind(...args) {
					bound = args;
					return statement;
				},
				async run() {
					if (sql.startsWith("INSERT INTO blog_posts")) {
						rows.push({
							slug: bound[0], title: bound[1], description: bound[2], category: bound[3],
							hero_src: bound[4], hero_alt: bound[5], date_iso: bound[6], read_time: bound[7],
							status: "draft", created_by: bound[8], created_at: bound[9], published_at: null,
						});
					} else if (sql.startsWith("UPDATE blog_posts SET status = 'published'")) {
						const row = rows.find((candidate) => candidate.slug === bound[1]);
						if (row) {
							row.status = "published";
							row.published_at = bound[0];
						}
					}
					return { meta: { changes: 1 } };
				},
				async all() {
					if (sql.includes("WHERE slug = ?")) {
						return { results: rows.filter((row) => row.slug === bound[0]) };
					}
					return { results: rows };
				},
			};
			return statement;
		},
	};
}

// Records every file written, and serves reads from FILES plus anything
// already written in this run.
function stubGitHub() {
	const written = [];
	const extra = {};
	const original = globalThis.fetch;

	globalThis.fetch = async (url, options = {}) => {
		const { pathname } = new URL(url);
		const method = options.method || "GET";
		const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

		if (method === "GET" && pathname.includes("/contents/")) {
			const file = decodeURIComponent(pathname.split("/contents/")[1]);
			const content = extra[file] !== undefined ? extra[file] : FILES[file];
			if (content === undefined) return reply({ message: "Not Found" }, 404);
			return reply({ content: encode(content), sha: "filesha" });
		}
		if (method === "GET" && pathname.includes("/git/ref/")) return reply({ object: { sha: "headsha" } });
		if (method === "GET" && pathname.includes("/git/commits/")) return reply({ tree: { sha: "basetree" } });
		if (method === "POST" && pathname.endsWith("/git/blobs")) {
			const body = JSON.parse(options.body);
			const content = Buffer.from(body.content, "base64").toString("utf8");
			written.push({ content });
			return reply({ sha: `blob${written.length}` });
		}
		if (method === "POST" && pathname.endsWith("/git/trees")) {
			const body = JSON.parse(options.body);
			// Match each blob to its path, and remember it for later reads.
			body.tree.forEach((entry, index) => {
				const blob = written[written.length - body.tree.length + index];
				if (blob) {
					blob.path = entry.path;
					extra[entry.path] = blob.content;
				}
			});
			return reply({ sha: "newtree" });
		}
		if (method === "POST" && pathname.endsWith("/git/commits")) return reply({ sha: "newcommit" });
		if (method === "PATCH" && pathname.includes("/git/refs/")) return reply({ ok: true });
		return reply({ message: "unexpected" }, 500);
	};

	return {
		written,
		// The last write wins: a post's page is written twice over a create-then
		// -publish run, and the draft version is not the one being asserted on.
		fileAt: (target) => ([...written].reverse().find((file) => file.path === target) || {}).content,
		restore() {
			globalThis.fetch = original;
		},
	};
}

const SESSION = { username: "phill", isAdmin: true };

function makeEnv(db) {
	return { DB: db, GITHUB_TOKEN: "t", GITHUB_REPO: "owner/repo" };
}

function post(pathname, body) {
	return [
		new Request(`https://example.com${pathname}`, { method: "POST", body: JSON.stringify(body) }),
		new URL(`https://example.com${pathname}`),
	];
}

const DRAFT = {
	title: "Controlling Ants in Your Canberra Home This Summer",
	description: "Why ants swarm Canberra kitchens in summer, how to keep them out, and when to call a professional.",
	category: "Seasonal",
	heroSrc: "/assets/images/pest-ant-macro.webp",
	heroAlt: "Close-up of an ant on a kitchen bench",
	intro: "Every summer the same thing happens in kitchens right across Canberra, and it is rarely a coincidence.",
	sections: [{ heading: "Why they come inside", paragraph: "Heat drives colonies indoors looking for water." }],
	pestTopic: "ant control",
	relatedServiceUrl: "/ant-control",
};

test("creating a post writes one file and records a draft", async () => {
	const github = stubGitHub();
	const db = stubDb();
	try {
		const response = await handleBlogApi(...post("/api/blog/create", DRAFT), makeEnv(db), SESSION);
		const body = await response.json();

		assert.equal(response.status, 200, JSON.stringify(body));
		assert.equal(body.slug, "blog-controlling-ants-in-your-canberra-home-this-summer");
		assert.equal(github.written.length, 1, "a draft touches only its own page");
		assert.equal(github.written[0].path, `${body.slug}/index.html`);

		const html = github.written[0].content;
		assert.match(html, /<meta name="robots" content="noindex"\/>/, "a draft must not be indexable");
		assert.ok(html.includes(DRAFT.title));
		assert.deepEqual(html.match(/\{\{[A-Z_0-9]+\}\}/g), null, "no placeholder may survive");

		assert.equal(db.rows.length, 1);
		assert.equal(db.rows[0].status, "draft");
		assert.equal(db.rows[0].created_by, "phill");
	} finally {
		github.restore();
	}
});

test("publishing registers the post in every place that makes it findable", async () => {
	const github = stubGitHub();
	const db = stubDb();
	try {
		const created = await (await handleBlogApi(...post("/api/blog/create", DRAFT), makeEnv(db), SESSION)).json();
		const response = await handleBlogApi(...post("/api/blog/publish", { slug: created.slug }), makeEnv(db), SESSION);
		const body = await response.json();
		assert.equal(response.status, 200, JSON.stringify(body));

		// The whole point of the feature: five files, not one.
		const paths = github.written.map((file) => file.path);
		for (const expected of [
			`${created.slug}/index.html`,
			"blog/index.html",
			"sitemap.xml",
			"feed.xml",
			"assets/search-index.json",
		]) {
			assert.ok(paths.includes(expected), `${expected} must be updated on publish`);
		}

		assert.doesNotMatch(github.fileAt(`${created.slug}/index.html`), /noindex/, "publishing lifts the noindex");
		assert.ok(github.fileAt("blog/index.html").includes(`href="/${created.slug}"`));
		assert.ok(github.fileAt("sitemap.xml").includes(`/${created.slug}</loc>`));
		assert.ok(github.fileAt("feed.xml").includes(`/${created.slug}</guid>`));
		assert.ok(JSON.parse(github.fileAt("assets/search-index.json")).some((entry) => entry.url === `/${created.slug}`));

		assert.equal(db.rows[0].status, "published");
	} finally {
		github.restore();
	}
});

test("publishing twice does not duplicate anything", async () => {
	const github = stubGitHub();
	const db = stubDb();
	try {
		const created = await (await handleBlogApi(...post("/api/blog/create", DRAFT), makeEnv(db), SESSION)).json();
		await handleBlogApi(...post("/api/blog/publish", { slug: created.slug }), makeEnv(db), SESSION);
		const again = await (await handleBlogApi(...post("/api/blog/publish", { slug: created.slug }), makeEnv(db), SESSION)).json();
		assert.equal(again.alreadyPublished, true);
	} finally {
		github.restore();
	}
});

test("a post at an address already taken is refused", async () => {
	const github = stubGitHub();
	const db = stubDb();
	try {
		await handleBlogApi(...post("/api/blog/create", DRAFT), makeEnv(db), SESSION);
		const response = await handleBlogApi(...post("/api/blog/create", DRAFT), makeEnv(db), SESSION);
		assert.equal(response.status, 409);
		assert.match((await response.json()).error, /already a post/);
	} finally {
		github.restore();
	}
});

test("bad input is refused before anything is written", async () => {
	const cases = [
		[{ ...DRAFT, title: "Short" }, /title/i],
		[{ ...DRAFT, description: "Too short." }, /description/i],
		[{ ...DRAFT, category: "Invented" }, /categor/i],
		[{ ...DRAFT, heroSrc: "https://evil.example.com/x.png" }, /hero image/i],
		[{ ...DRAFT, heroAlt: "" }, /alt text/i],
		[{ ...DRAFT, sections: [] }, /section/i],
		[{ ...DRAFT, sections: [{ heading: "Only a heading", paragraph: "" }] }, /section/i],
		[{ ...DRAFT, relatedServiceUrl: "/not-a-service" }, /service/i],
	];

	for (const [body, expected] of cases) {
		const github = stubGitHub();
		const db = stubDb();
		try {
			const response = await handleBlogApi(...post("/api/blog/create", body), makeEnv(db), SESSION);
			assert.equal(response.status, 400, `expected a refusal for ${JSON.stringify(expected)}`);
			assert.match((await response.json()).error, expected);
			assert.equal(github.written.length, 0, "nothing may be committed for invalid input");
			assert.equal(db.rows.length, 0);
		} finally {
			github.restore();
		}
	}
});

test("without GitHub configured, creating a post explains rather than fails", async () => {
	const db = stubDb();
	const response = await handleBlogApi(...post("/api/blog/create", DRAFT), { DB: db }, SESSION);
	assert.equal(response.status, 501);
	assert.match((await response.json()).error, /GITHUB_TOKEN/);
});
