// Generating a blog post writes real files into the repository, so the
// string work is worth pinning hard. These run against the actual
// _blog-template.html and the actual blog/index.html, sitemap.xml and
// feed.xml -- a test against a hand-made fixture would keep passing after
// someone reshaped the real template.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	slugify,
	readTime,
	formatDates,
	renderPost,
	renderSections,
	findUnfilledPlaceholders,
	blogCardHtml,
	insertBlogCard,
	insertSitemapUrl,
	insertFeedItem,
	insertSearchEntry,
	removeDraftNoindex,
	stripGuidanceComments,
	readRecentPosts,
} from "../src/blog-posts.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const TEMPLATE = read("_blog-template.html");
const BLOG_INDEX = read("blog/index.html");

const POST = {
	slug: "blog-controlling-ants-in-summer",
	title: "Controlling Ants in Your Canberra Home This Summer",
	description: "Why ants swarm Canberra kitchens in summer, how to keep them out, and when to call a professional.",
	category: "Seasonal",
	heroSrc: "/assets/images/pest-ant-macro.webp",
	heroAlt: "Close-up of an ant on a kitchen bench",
	intro: "Every summer the same thing happens in Canberra kitchens.",
	sections: [
		{ heading: "Why they come inside", paragraph: "Heat drives colonies to look for water." },
		{ heading: "What actually works", paragraph: "Baiting the trail beats spraying the ones you can see." },
	],
	date: "2026-07-24",
	readTime: 6,
	pestTopic: "ant control",
	relatedServiceUrl: "/ant-control",
	relatedServiceName: "Ant Control",
	related: [
		{ url: "/blog-a", title: "Post A", meta: "Jul 1, 2026 · 4 min read", image: "/assets/images/a.webp", imageAlt: "A", category: "Prevention" },
		{ url: "/blog-b", title: "Post B", meta: "Jun 1, 2026 · 5 min read", image: "/assets/images/b.webp", imageAlt: "B", category: "Seasonal" },
	],
};

test("slugify follows the blog- convention the existing posts use", () => {
	assert.equal(slugify("Controlling Ants in Summer"), "blog-controlling-ants-in-summer");
	assert.equal(slugify("German vs. American Cockroaches!"), "blog-german-vs-american-cockroaches");
	assert.equal(slugify("It's a Wrap"), "blog-its-a-wrap");
	assert.equal(slugify(""), "", "an empty title cannot make a valid address");
	assert.doesNotMatch(slugify("Trailing punctuation???"), /-$/);
});

test("readTime rounds to whole minutes and never reads zero", () => {
	assert.equal(readTime("word ".repeat(220)), 1);
	assert.equal(readTime("word ".repeat(1320)), 6);
	assert.equal(readTime("three words only"), 1, "a short post is one minute, not none");
});

test("dates are rendered in every format the template and feed need", () => {
	const dates = formatDates("2026-07-24");
	assert.equal(dates.long, "July 24, 2026");
	assert.equal(dates.short, "Jul 24, 2026");
	assert.match(dates.rfc822, /^Fri, 24 Jul 2026 00:00:00 \+1100$/);
});

test("a rendered post leaves no placeholder behind", () => {
	// The failure this guards against is shipping a literal {{PAGE_TITLE}} to
	// a reader, which is exactly what happens if the template grows a field.
	const html = renderPost(TEMPLATE, POST);
	assert.deepEqual(findUnfilledPlaceholders(html), []);
});

test("authoring notes are stripped, but the analytics comments survive", () => {
	// Every published post on the site has the guidance comments removed, and
	// one of them contains a literal {{PLACEHOLDER}}. The Google Tag Manager
	// markers are functional and must not be caught by the same broom.
	const html = renderPost(TEMPLATE, POST);
	assert.doesNotMatch(html, /DO NOT EDIT/);
	assert.doesNotMatch(html, /BLOG-GUIDE/);
	assert.ok(html.includes("<!-- Google Tag Manager -->"), "tracking must still be there");
	assert.ok(html.includes("<!-- End Google Tag Manager (noscript) -->"));

	// And the page itself is untouched apart from the comments.
	assert.ok(html.includes("book-panel"), "the shared book panel must remain");
	assert.ok(html.includes("article-cta"), "the closing call to action must remain");
});

test("a rendered post carries the title, description and canonical URL", () => {
	const html = renderPost(TEMPLATE, POST);
	assert.ok(html.includes(POST.title));
	assert.ok(html.includes(POST.description));
	assert.ok(html.includes(`https://www.tcbpestcontrolcanberra.com.au/${POST.slug}`));
	assert.ok(html.includes(POST.heroSrc));
	assert.ok(html.includes("July 24, 2026"));
});

test("sections are generated to match, whatever the count", () => {
	// The template ships with exactly three; posts want any number.
	const one = renderPost(TEMPLATE, { ...POST, sections: [{ heading: "Only", paragraph: "One." }] });
	assert.equal((one.match(/<h2 class="display">/g) || []).length >= 1, true);
	assert.ok(one.includes("<h2 class=\"display\">Only</h2>"));
	assert.deepEqual(findUnfilledPlaceholders(one), [], "unused section slots must not survive");

	const five = renderPost(TEMPLATE, {
		...POST,
		sections: Array.from({ length: 5 }, (_, i) => ({ heading: `H${i}`, paragraph: `P${i}` })),
	});
	for (let i = 0; i < 5; i++) assert.ok(five.includes(`<h2 class="display">H${i}</h2>`));
});

test("post content is escaped, so an apostrophe or a bracket cannot break the page", () => {
	const html = renderPost(TEMPLATE, {
		...POST,
		title: 'Ants & "friends" <script>alert(1)</script>',
		sections: [{ heading: "A & B", paragraph: "1 < 2" }],
	});
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
	assert.ok(html.includes("Ants &amp; &quot;friends&quot;"));
	assert.ok(html.includes("<h2 class=\"display\">A &amp; B</h2>"));
});

test("a draft is noindex, and publishing removes it", () => {
	const draft = renderPost(TEMPLATE, POST, { draft: true });
	assert.match(draft, /<meta name="robots" content="noindex"\/>/);

	const live = removeDraftNoindex(draft);
	assert.doesNotMatch(live, /noindex/);
	// Nothing else may move.
	assert.equal(live, renderPost(TEMPLATE, POST, { draft: false }));
});

test("the blog card goes in first, so newest shows first", () => {
	const card = blogCardHtml(POST);
	const updated = insertBlogCard(BLOG_INDEX, card);

	assert.ok(updated, "the post grid should be findable in the real blog index");
	const gridAt = updated.indexOf('<div class="blog-grid cols-3">');
	const newCardAt = updated.indexOf(card);
	const firstExistingAt = updated.indexOf('<a class="blog-card"', newCardAt + card.length);

	assert.ok(newCardAt > gridAt, "the card goes inside the grid");
	assert.ok(firstExistingAt > newCardAt, "and ahead of the posts already there");
	assert.ok(card.includes("Jul 24, 2026 · 6 min read"));
	assert.ok(card.includes(">Seasonal<"));
});

test("sitemap and feed entries are added once and only once", () => {
	const sitemap = read("sitemap.xml");
	const once = insertSitemapUrl(sitemap, POST.slug, POST.date);
	assert.ok(once.includes(`<loc>https://www.tcbpestcontrolcanberra.com.au/${POST.slug}</loc>`));
	assert.ok(once.trimEnd().endsWith("</urlset>"));
	assert.equal(insertSitemapUrl(once, POST.slug, POST.date), once, "publishing twice must not duplicate the entry");

	const feed = read("feed.xml");
	const withItem = insertFeedItem(feed, POST);
	assert.ok(withItem.includes(`<guid>https://www.tcbpestcontrolcanberra.com.au/${POST.slug}</guid>`));
	assert.ok(withItem.indexOf(POST.title) < withItem.indexOf("<item>", withItem.indexOf("<item>") + 1), "newest first");
	assert.equal(insertFeedItem(withItem, POST), withItem);
});

test("the search index gains one valid entry", () => {
	const index = read("assets/search-index.json");
	const updated = insertSearchEntry(index, POST);
	const entries = JSON.parse(updated);

	assert.equal(entries.length, JSON.parse(index).length + 1);
	const added = entries[entries.length - 1];
	assert.deepEqual(added, { url: `/${POST.slug}`, title: POST.title, description: POST.description, category: "Blog" });
	assert.equal(insertSearchEntry(updated, POST), updated, "publishing twice must not duplicate the entry");
});

test("recent posts are read from the real blog index for the related cards", () => {
	const recent = readRecentPosts(BLOG_INDEX, 2);
	assert.equal(recent.length, 2);
	for (const post of recent) {
		assert.match(post.url, /^\/blog-/);
		assert.ok(post.title.length > 5, `expected a real title, got ${JSON.stringify(post.title)}`);
		assert.match(post.image, /^\/assets\/images\//);
		assert.ok(post.meta.includes("min read"));
	}
});

test("renderSections drops empty rows rather than emitting blank headings", () => {
	const html = renderSections([
		{ heading: "Kept", paragraph: "Yes." },
		{ heading: "", paragraph: "" },
		null,
	]);
	assert.equal((html.match(/<h2/g) || []).length, 1);
});

test("slugify stays fast however hostile the title", () => {
	// CodeQL flagged the old /^-+|-+$/ trim as able to backtrack on a long run
	// of dashes. It could not, because the replace before it collapsed runs --
	// but that reasoning lived on a different line, so the trim no longer uses
	// a quantifier at all. This pins the property locally.
	for (const evil of ["!".repeat(50000), "-".repeat(50000), "a-".repeat(25000), "-a".repeat(25000)]) {
		const started = Date.now();
		const slug = slugify(evil);
		assert.ok(Date.now() - started < 500, `slugging ${evil.length} characters must stay fast`);
		assert.doesNotMatch(slug, /--/, "runs are collapsed");
		assert.doesNotMatch(slug, /-$/, "and never left trailing");
	}
});

test("post content cannot introduce an HTML comment", () => {
	// The comment stripper runs on the template, before any post content is
	// inserted, and content is escaped on the way in. So a title containing
	// <!-- cannot produce a comment in the output -- which is the thing that
	// would matter if the stripper were a sanitiser rather than a formatter.
	const html = renderPost(TEMPLATE, {
		...POST,
		title: "Ants <!-- and --> friends",
		intro: "An intro with <!-- a comment --> inside it.",
		sections: [{ heading: "<!-- heading -->", paragraph: "<!-- paragraph -->" }],
	});

	// Only the template's own functional comments should remain.
	for (const comment of html.match(/<!--[\s\S]*?-->/g) || []) {
		assert.match(comment, /Google|Deferred/, `unexpected comment survived: ${comment.slice(0, 60)}`);
	}
	assert.ok(html.includes("&lt;!-- and --&gt;"), "the title's angle brackets are escaped");
});
