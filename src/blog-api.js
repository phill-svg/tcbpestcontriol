// The admin API behind "New blog post".
//
// Kept apart from src/blog-posts.js on purpose: that module is pure string
// work with no I/O, which is what makes the generated markup straightforward
// to test. This one does the database and GitHub side.

import {
	slugify,
	readTime,
	renderPost,
	findUnfilledPlaceholders,
	blogCardHtml,
	insertBlogCard,
	insertSitemapUrl,
	insertFeedItem,
	insertSearchEntry,
	removeDraftNoindex,
	readRecentPosts,
	loadTemplate,
} from "./blog-posts.js";
import { missingConfig, setupMessage, readFile, commitFiles, decodeBase64Utf8 } from "./github-sync.js";

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS blog_posts (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  hero_src     TEXT NOT NULL,
  hero_alt     TEXT NOT NULL,
  date_iso     TEXT NOT NULL,
  read_time    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft | published
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER
)`;

// Straight from BLOG-GUIDE.md. Kept here rather than derived from existing
// posts so a typo in one old post cannot introduce a fifth category.
const CATEGORIES = ["Pest Watch", "Prevention", "Seasonal", "Canberra Living"];

// Service pages a post can point its closing call-to-action at.
const SERVICES = [
	{ url: "/termite-treatment", name: "Termite Treatment" },
	{ url: "/general-pest-control", name: "General Pest Control" },
	{ url: "/spider-control", name: "Spider Control" },
	{ url: "/rodent-control", name: "Rodent Control" },
	{ url: "/cockroach-control", name: "Cockroach Control" },
	{ url: "/ant-control", name: "Ant Control" },
	{ url: "/bed-bug-treatment-canberra", name: "Bed Bug Treatment" },
	{ url: "/flea-control", name: "Flea Control" },
	{ url: "/bees", name: "Bees & Wasps" },
	{ url: "/possum-control", name: "Possum Control" },
	{ url: "/bird-control", name: "Bird Control" },
	{ url: "/commercial", name: "Commercial Pest Control" },
	{ url: "/residential", name: "Residential Pest Control" },
];

let tableReady = false;

async function ensureTable(env) {
	if (tableReady) return;
	await env.DB.prepare(TABLE_DDL).run();
	tableReady = true;
}

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

// Everything the form sends, checked before a single file is written. The
// limits are generous -- they exist so a runaway paste cannot commit a
// megabyte of markup, not to police writing.
function validate(body) {
	const errors = [];
	const title = String(body.title || "").trim();
	const description = String(body.description || "").trim();
	const intro = String(body.intro || "").trim();
	const category = String(body.category || "").trim();
	const heroSrc = String(body.heroSrc || "").trim();
	const heroAlt = String(body.heroAlt || "").trim();

	if (title.length < 8 || title.length > 120) errors.push("Give the post a title between 8 and 120 characters.");
	if (description.length < 20 || description.length > 200) {
		errors.push("The description should be 20 to 200 characters — it is what Google shows under the title.");
	}
	if (!CATEGORIES.includes(category)) errors.push("Pick one of the site's categories.");
	if (!/^\/assets\/images\/[A-Za-z0-9._-]+$/.test(heroSrc)) errors.push("Pick a hero image from the site's images.");
	if (!heroAlt) errors.push("The hero image needs alt text, for screen readers and for Google.");
	if (intro.length < 40) errors.push("Write an opening paragraph of at least 40 characters.");

	const sections = (Array.isArray(body.sections) ? body.sections : [])
		.map((section) => ({
			heading: String((section && section.heading) || "").trim(),
			paragraph: String((section && section.paragraph) || "").trim(),
		}))
		.filter((section) => section.heading || section.paragraph);

	if (!sections.length) errors.push("Add at least one section.");
	if (sections.some((section) => !section.heading || !section.paragraph)) {
		errors.push("Every section needs both a heading and a paragraph.");
	}

	const service = SERVICES.find((candidate) => candidate.url === String(body.relatedServiceUrl || ""));
	if (!service) errors.push("Pick a service page for the closing call to action.");

	if (errors.length) return { errors };

	const slug = String(body.slug || "").trim() || slugify(title);
	if (!/^blog-[a-z0-9-]+$/.test(slug)) {
		return { errors: ["The web address must look like blog-your-topic, using lowercase letters and dashes."] };
	}

	const body_text = [intro, ...sections.map((section) => `${section.heading} ${section.paragraph}`)].join(" ");

	return {
		post: {
			slug,
			title,
			description,
			category,
			heroSrc,
			heroAlt,
			intro,
			sections,
			// Supplied by the caller rather than read from the clock here, so the
			// value stored and the value rendered are always the same one.
			date: body.date,
			readTime: readTime(body_text),
			pestTopic: String(body.pestTopic || "").trim() || "pest control",
			relatedServiceUrl: service.url,
			relatedServiceName: service.name,
		},
	};
}

export async function handleBlogApi(request, url, env, session) {
	const route = url.pathname.slice("/api/blog/".length);
	const branch = env.GITHUB_BRANCH || "main";

	if (route === "options" && request.method === "GET") {
		return json({ categories: CATEGORIES, services: SERVICES });
	}

	if (route === "posts" && request.method === "GET") {
		await ensureTable(env);
		const result = await env.DB.prepare(
			"SELECT slug, title, category, date_iso, status, created_at, published_at FROM blog_posts ORDER BY created_at DESC"
		).all();
		return json({ posts: result.results || [] });
	}

	// Everything below writes to the repository.
	const missing = missingConfig(env);
	if (missing.length) return json({ error: setupMessage(missing), missing }, 501);

	if (route === "create" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);

		// The date is stamped here so a post created just before midnight does
		// not end up dated by the reader's clock.
		body.date = new Date().toISOString().slice(0, 10);
		const { errors, post } = validate(body);
		if (errors) return json({ error: errors.join(" ") }, 400);

		await ensureTable(env);
		const existing = await env.DB.prepare("SELECT slug FROM blog_posts WHERE slug = ?").bind(post.slug).all();
		if ((existing.results || []).length) {
			return json({ error: `There is already a post at /${post.slug}. Change the web address.` }, 409);
		}

		let template;
		let blogIndex;
		try {
			template = await loadTemplate(env, branch);
			blogIndex = decodeBase64Utf8((await readFile(env, "blog/index.html", branch)).content);
		} catch (error) {
			return json({ error: `Could not read the site's files: ${error.message}` }, 502);
		}

		post.related = readRecentPosts(blogIndex, 2);
		const html = renderPost(template, post, { draft: true });

		const unfilled = findUnfilledPlaceholders(html);
		if (unfilled.length) {
			// Shipping a literal {{PLACEHOLDER}} to a reader is worse than
			// refusing, and means the template gained a field this does not know.
			return json({ error: `The post template has fields this form does not fill: ${unfilled.join(", ")}.` }, 500);
		}

		let commit;
		try {
			commit = await commitFiles(
				env,
				branch,
				[{ path: `${post.slug}/index.html`, content: html }],
				`Add blog post draft: ${post.title}`
			);
		} catch (error) {
			return json({ error: `Could not save the post: ${error.message}` }, 502);
		}

		await env.DB.prepare(
			`INSERT INTO blog_posts (slug, title, description, category, hero_src, hero_alt, date_iso, read_time, status, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
		)
			.bind(post.slug, post.title, post.description, post.category, post.heroSrc, post.heroAlt, post.date, post.readTime, session.username, Date.now())
			.run();

		return json({ ok: true, slug: post.slug, url: `/${post.slug}`, commit });
	}

	if (route === "publish" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body || typeof body.slug !== "string") return json({ error: "Invalid request." }, 400);

		await ensureTable(env);
		const found = await env.DB.prepare("SELECT * FROM blog_posts WHERE slug = ?").bind(body.slug).all();
		const row = (found.results || [])[0];
		if (!row) return json({ error: "That post does not exist." }, 404);
		if (row.status === "published") return json({ ok: true, alreadyPublished: true, slug: row.slug });

		const post = {
			slug: row.slug,
			title: row.title,
			description: row.description,
			category: row.category,
			heroSrc: row.hero_src,
			heroAlt: row.hero_alt,
			date: row.date_iso,
			readTime: row.read_time,
		};

		const files = [];
		try {
			const postHtml = decodeBase64Utf8((await readFile(env, `${post.slug}/index.html`, branch)).content);
			files.push({ path: `${post.slug}/index.html`, content: removeDraftNoindex(postHtml) });

			const blogIndex = decodeBase64Utf8((await readFile(env, "blog/index.html", branch)).content);
			const withCard = insertBlogCard(blogIndex, blogCardHtml(post));
			if (!withCard) return json({ error: "Could not find the post list in blog/index.html." }, 500);
			files.push({ path: "blog/index.html", content: withCard });

			const sitemap = decodeBase64Utf8((await readFile(env, "sitemap.xml", branch)).content);
			const withUrl = insertSitemapUrl(sitemap, post.slug, post.date);
			if (!withUrl) return json({ error: "Could not update sitemap.xml." }, 500);
			files.push({ path: "sitemap.xml", content: withUrl });

			const feed = decodeBase64Utf8((await readFile(env, "feed.xml", branch)).content);
			const withItem = insertFeedItem(feed, post);
			if (!withItem) return json({ error: "Could not update feed.xml." }, 500);
			files.push({ path: "feed.xml", content: withItem });

			const index = decodeBase64Utf8((await readFile(env, "assets/search-index.json", branch)).content);
			const withEntry = insertSearchEntry(index, post);
			if (!withEntry) return json({ error: "Could not update the search index." }, 500);
			files.push({ path: "assets/search-index.json", content: withEntry });
		} catch (error) {
			return json({ error: `Could not read the site's files: ${error.message}` }, 502);
		}

		let commit;
		try {
			commit = await commitFiles(env, branch, files, `Publish blog post: ${post.title}`);
		} catch (error) {
			return json({ error: `Could not publish the post: ${error.message}` }, 502);
		}

		await env.DB.prepare("UPDATE blog_posts SET status = 'published', published_at = ? WHERE slug = ?")
			.bind(Date.now(), post.slug)
			.run();

		return json({ ok: true, slug: post.slug, url: `/${post.slug}`, files: files.length, commit });
	}

	return json({ error: "Not found." }, 404);
}
