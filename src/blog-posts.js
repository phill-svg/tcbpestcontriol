// Creating blog posts from the editor.
//
// BLOG-GUIDE.md describes seven manual steps: copy _blog-template.html into a
// new folder, fill in about twenty placeholders, paste a card into
// blog/index.html, add a <url> to sitemap.xml, add an <item> to feed.xml,
// rebuild the search index, commit. Every one of those is mechanical, and
// every one is a chance to forget something -- a post that never appears in
// search, or a feed entry with last month's date.
//
// This does the lot in one commit. The guide stays accurate for anyone
// writing a post by hand; this is the same recipe, executed.
//
// Posts are created as drafts: the file is committed so it can be read at its
// real URL, but nothing links to it and it carries a noindex until published.
// Publishing is what adds it to the blog index, the sitemap, the feed and the
// search index -- so a half-written post cannot reach a reader or Google.

import { readFile, commitFiles } from "./github-sync.js";

// Matches BLOG-GUIDE.md: existing posts are all folders named blog-<slug>.
//
// The trimming is done by splitting rather than with /^-+|-+$/, which CodeQL
// flags as able to backtrack on a long run of dashes. In practice it could not
// -- the preceding replace collapses every run to a single dash, so `-+` never
// has more than one to chew on, and 80,000 characters of punctuation slugged
// in about a millisecond. But that safety lived on a different line from the
// pattern it protected, so a later edit could have removed it without anything
// looking wrong. Splitting on the separator has no backtracking to reason
// about at all, and does the trimming and de-duplication in one pass.
export function slugify(title) {
	const slug = String(title || "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.split("-")
		.filter(Boolean)
		.join("-")
		.slice(0, 80);
	// Slicing can leave a trailing dash if the cut lands on one.
	const trimmed = slug.endsWith("-") ? slug.slice(0, slug.lastIndexOf("-")) : slug;
	return trimmed ? `blog-${trimmed}` : "";
}

// ~220 words a minute is the figure the guide uses. Rounded up, never zero:
// "0 min read" looks broken.
export function readTime(text) {
	const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.round(words / 220));
}

export function escapeHtml(value) {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Dates are formatted for Sydney, which is what every existing post and feed
// item uses. Doing this by hand rather than with toLocaleString keeps the
// output identical regardless of where the Worker happens to be running.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDates(isoDate) {
	const [year, month, day] = String(isoDate).split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return {
		iso: isoDate,
		long: `${MONTHS_LONG[month - 1]} ${day}, ${year}`,
		short: `${MONTHS[month - 1]} ${day}, ${year}`,
		// The existing feed uses +1100. Keeping it fixed rather than computing
		// daylight saving matters less than staying consistent with what is
		// already there -- readers see the date, not the offset.
		rfc822: `${DAYS[date.getUTCDay()]}, ${String(day).padStart(2, "0")} ${MONTHS[month - 1]} ${year} 00:00:00 +1100`,
	};
}

const SITE = "https://www.tcbpestcontrolcanberra.com.au";

// The template ships with exactly three section placeholders. Posts want a
// variable number, so the whole run is replaced in one go rather than filled
// slot by slot.
const SECTION_BLOCK = /<h2 class="display">\{\{SECTION_1_HEADING\}\}<\/h2>[\s\S]*?<p>\{\{SECTION_3_PARAGRAPH\}\}<\/p>/;

export function renderSections(sections) {
	return sections
		.filter((section) => section && (section.heading || section.paragraph))
		.map(
			(section) =>
				`<h2 class="display">${escapeHtml(section.heading)}</h2>\n<p>${escapeHtml(section.paragraph)}</p>`
		)
		.join("\n\n");
}

// The template carries a dozen authoring notes -- "EDIT: page title", "DO NOT
// EDIT. Identical on every page", the list of placeholders at the top. Every
// published post on the site has them stripped out, and one of them contains a
// literal {{PLACEHOLDER}} that would otherwise trip the completeness check.
//
// Matched on the ==== rule the guidance comments all use, which the analytics
// comments (Google Tag Manager's markers, the deferred-loading note) do not --
// those are functional and must survive.
// Every comment is matched, then judged on its contents. An earlier version
// tried to express "a comment containing ====" as a single pattern and
// quietly swallowed the whole <head>, because the leading part could run past
// one comment's end into the next. Matching the comments first and deciding
// afterwards cannot do that.
const ANY_COMMENT = /<!--[\s\S]*?-->\n?/g;
const IS_GUIDANCE = /={4}|BLOG-GUIDE/;

export function stripGuidanceComments(html) {
	return html.replace(ANY_COMMENT, (comment) => (IS_GUIDANCE.test(comment) ? "" : comment));
}

// Fills the template. `post` is already validated by the caller.
export function renderPost(template, post, { draft = true } = {}) {
	const dates = formatDates(post.date);
	const url = `${SITE}/${post.slug}`;

	let html = stripGuidanceComments(template).replace(SECTION_BLOCK, renderSections(post.sections));

	const values = {
		PAGE_TITLE: post.title,
		META_DESCRIPTION: post.description,
		CANONICAL_URL: url,
		OG_IMAGE_URL: `${SITE}${post.heroSrc}`,
		DATE_ISO: dates.iso,
		DATE_LONG: dates.long,
		CATEGORY: post.category,
		READ_TIME: String(post.readTime),
		HERO_IMAGE_SRC: post.heroSrc,
		HERO_IMAGE_ALT: post.heroAlt,
		INTRO_PARAGRAPH: post.intro,
		PEST_TOPIC: post.pestTopic,
		PEST: post.pestTopic,
		RELATED_SERVICE_URL: post.relatedServiceUrl,
		RELATED_SERVICE_NAME: post.relatedServiceName,
	};

	for (const [key, value] of Object.entries(values)) {
		html = html.split(`{{${key}}}`).join(escapeHtml(value));
	}

	// The two "continue reading" cards point at the newest existing posts.
	for (const [index, related] of (post.related || []).entries()) {
		const n = index + 1;
		html = html
			.split(`{{RELATED_POST_${n}_URL}}`).join(escapeHtml(related.url))
			.split(`{{RELATED_POST_${n}_TITLE}}`).join(escapeHtml(related.title))
			.split(`{{RELATED_POST_${n}_META}}`).join(escapeHtml(related.meta))
			.split(`{{RELATED_POST_${n}_IMG_SRC}}`).join(escapeHtml(related.image))
			.split(`{{RELATED_POST_${n}_IMG_ALT}}`).join(escapeHtml(related.imageAlt))
			.split(`{{RELATED_POST_${n}_CATEGORY}}`).join(escapeHtml(related.category));
	}

	// A draft is reachable at its URL so it can be read and edited in place,
	// but must not be indexed while it is still being written.
	if (draft) {
		html = html.replace("</head>", `<meta name="robots" content="noindex"/>\n</head>`);
	}

	return html;
}

// Anything the template still has a placeholder for was not covered above,
// which would ship "{{RELATED_POST_1_TITLE}}" to a reader. Better to refuse.
export function findUnfilledPlaceholders(html) {
	return [...new Set((html.match(/\{\{[A-Z_0-9]+\}\}/g) || []))];
}

// ---------------------------------------------------------------------------
// Registering a published post
// ---------------------------------------------------------------------------

export function blogCardHtml(post) {
	const dates = formatDates(post.date);
	return (
		`<a class="blog-card" href="/${post.slug}"><div class="blog-media"><img alt="${escapeHtml(post.heroAlt)}" ` +
		`loading="lazy" src="${escapeHtml(post.heroSrc)}" width="1376" height="768"/></div><div class="blog-tag">` +
		`<svg aria-hidden="true" class="icon-line icon" height="24" viewbox="0 0 24 24" width="24">` +
		`<use href="/assets/icons.svg?v=1#tag"></use></svg><span>${escapeHtml(post.category)}</span></div>` +
		`<h3>${escapeHtml(post.title)}</h3><p>${escapeHtml(post.description)}</p><div class="card-foot">` +
		`<div class="meta">${dates.short} · ${post.readTime} min read</div><div class="read">Read` +
		`<svg aria-hidden="true" class="icon-line icon" height="12" viewbox="0 0 24 24" width="12">` +
		`<use href="/assets/icons.svg?v=1#arrow-right"></use></svg></div></div></a>`
	);
}

// Newest first, as the guide specifies: the card goes in as the first child of
// the grid.
export function insertBlogCard(indexHtml, card) {
	const marker = indexHtml.match(/<div class="blog-grid cols-3">/);
	if (!marker) return null;
	const at = marker.index + marker[0].length;
	return `${indexHtml.slice(0, at)}${card}${indexHtml.slice(at)}`;
}

export function insertSitemapUrl(xml, slug, isoDate) {
	if (xml.includes(`<loc>${SITE}/${slug}</loc>`)) return xml;
	const entry = `<url><loc>${SITE}/${slug}</loc><lastmod>${isoDate}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>\n`;
	const close = xml.lastIndexOf("</urlset>");
	if (close === -1) return null;
	return `${xml.slice(0, close)}${entry}${xml.slice(close)}`;
}

export function insertFeedItem(xml, post) {
	if (xml.includes(`<guid>${SITE}/${post.slug}</guid>`)) return xml;
	const dates = formatDates(post.date);
	const item =
		`<item>\n<title>${escapeHtml(post.title)}</title>\n<link>${SITE}/${post.slug}</link>\n` +
		`<guid>${SITE}/${post.slug}</guid>\n<description>${escapeHtml(post.description)}</description>\n` +
		`<pubDate>${dates.rfc822}</pubDate>\n</item>\n`;
	// Newest first, so it goes ahead of the existing items.
	const first = xml.indexOf("<item>");
	if (first === -1) return null;
	return `${xml.slice(0, first)}${item}${xml.slice(first)}`;
}

// The search index is generated by scripts/build-search-index.js, which is a
// Node script and cannot run here. Appending the one new entry produces the
// same result for this post; a full rebuild still happens whenever that script
// is next run.
export function insertSearchEntry(json, post) {
	let entries;
	try {
		entries = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(entries)) return null;
	const url = `/${post.slug}`;
	if (entries.some((entry) => entry && entry.url === url)) return json;
	entries.push({ url, title: post.title, description: post.description, category: "Blog" });
	return `${JSON.stringify(entries)}\n`;
}

// Removes the noindex a draft was created with.
export function removeDraftNoindex(html) {
	return html.replace(/\n?<meta name="robots" content="noindex"\/>/, "");
}

// ---------------------------------------------------------------------------
// Reading what already exists
// ---------------------------------------------------------------------------

// The newest two posts on the blog index, used for the "continue reading"
// cards so a new post never links to nothing.
export function readRecentPosts(blogIndexHtml, limit = 2) {
	const posts = [];
	const cardPattern = /<a class="blog-card" href="\/([^"]+)"[\s\S]*?<img alt="([^"]*)"[^>]*src="([^"]*)"[\s\S]*?<span>([^<]*)<\/span><\/div><h3>([^<]*)<\/h3>[\s\S]*?<div class="meta">([^<]*)<\/div>/g;
	let match;
	while ((match = cardPattern.exec(blogIndexHtml)) !== null && posts.length < limit) {
		posts.push({
			url: `/${match[1]}`,
			imageAlt: match[2],
			image: match[3],
			category: match[4],
			title: match[5],
			meta: match[6],
		});
	}
	return posts;
}

export async function loadTemplate(env, branch) {
	const file = await readFile(env, "_blog-template.html", branch);
	const { decodeBase64Utf8 } = await import("./github-sync.js");
	return decodeBase64Utf8(file.content);
}

export { commitFiles };
