// Creating a service page from a draft.
//
// The database side of src/service-pages.js, kept apart for the same reason
// blog-api.js is kept apart from blog-posts.js: that module is pure string
// work and this one talks to GitHub.
//
// There is deliberately no table behind this. A blog post has one because the
// composer lists posts and tracks their status; a service page has a single
// piece of state -- committed as a draft, or published -- and that state is
// already written in the file itself as a noindex tag. Keeping it in one place
// means there is nothing to fall out of step.

import { renderServicePage, findUnfilledPlaceholders } from "./service-pages.js";
import { insertSitemapUrl, removeDraftNoindex } from "./blog-posts.js";
import { missingConfig, setupMessage, readFile, commitFiles, decodeBase64Utf8 } from "./github-sync.js";

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });

async function readJsonBody(request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

// Deliberately not blog-posts.js's slugify, which prefixes every address with
// "blog-" because that is what a blog post's address is. A service page lives
// at the top level next to /ant-control, and borrowing that helper produced
// /blog-borer-control -- a service page filed as a blog post, at an address
// this module's own validator then refuses.
export function serviceSlug(name) {
	// The trimming is done by hand rather than with /^-+|-+$/, which is the
	// pattern CodeQL objected to: an alternation of two quantifiers, where the
	// trailing half has to be retried from every position in a run of hyphens.
	// Walking in from both ends does the same job in one pass and cannot
	// backtrack at all.
	const cleaned = String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	let start = 0;
	let end = cleaned.length;
	while (start < end && cleaned[start] === "-") start += 1;
	while (end > start && cleaned[end - 1] === "-") end -= 1;
	return cleaned.slice(start, end);
}

// Lower-case words joined by single hyphens, with none at either end.
//
// Written as a split rather than as /^[a-z0-9]+(?:-[a-z0-9]+)*$/, which says
// the same thing and pairs two quantifiers in a way that can backtrack. In V8
// that pattern costs about a millisecond on a 40KB input and the endpoint is
// admin-only, so it was never a live risk here -- but a linear check is free
// and there is no argument for keeping the shape.
//
// The cap is separate from the pattern on purpose: this becomes a path on the
// site, and no address anybody wants is longer than this.
const MAX_SLUG = 80;

export function isSlug(value) {
	const slug = String(value || "");
	if (!slug || slug.length > MAX_SLUG) return false;
	const parts = slug.split("-");
	// An empty part is a hyphen at an end, or two in a row.
	return parts.every((part) => part.length > 0 && !/[^a-z0-9]/.test(part));
}

// A service page lives at the top level, like /ant-control, so its address has
// to be one nothing else has claimed. Blog posts are namespaced under `blog-`
// and can be checked against a table; these have to be checked against the
// repository, which is the only record of what exists.
export function validateServicePage(body) {
	const errors = [];
	const slug = String(body.slug || "").trim() || serviceSlug(body.serviceName);
	if (!isSlug(slug)) errors.push("The web address should be lower-case words joined by hyphens.");
	if (/^blog-/.test(slug)) errors.push("That address is reserved for blog posts.");
	if (!String(body.title || "").trim()) errors.push("The page needs a title.");
	if (!String(body.description || "").trim()) errors.push("The page needs a description.");
	if (!String(body.serviceName || "").trim()) errors.push("The page needs a service name.");
	if (!String(body.heroImage || "").trim()) errors.push("The page needs a hero image.");
	// A page with no body is not a page. Three sections is what the template
	// and the rest of the site are built around, but one is enough to be real.
	if (!Array.isArray(body.sections) || !body.sections.length) errors.push("The page needs at least one section.");
	return errors.length ? { errors } : { page: { ...body, slug } };
}

export async function loadServiceTemplate(env, branch) {
	const file = await readFile(env, "_service-template.html", branch);
	return decodeBase64Utf8(file.content);
}

export async function handleServiceApi(request, url, env, session) {
	const route = url.pathname.slice("/api/service/".length);
	const branch = env.GITHUB_BRANCH || "main";

	const missing = missingConfig(env);
	if (missing.length) return json({ error: setupMessage(missing), missing }, 501);

	if (route === "create" && request.method === "POST") {
		const body = await readJsonBody(request);
		if (!body) return json({ error: "Invalid request." }, 400);

		const { errors, page } = validateServicePage(body);
		if (errors) return json({ error: errors.join(" ") }, 400);

		// Nothing may quietly replace a page that already exists. The
		// repository is the record, so it is the thing asked.
		try {
			await readFile(env, `${page.slug}/index.html`, branch);
			return json({ error: `There is already a page at /${page.slug}. Change the web address.` }, 409);
		} catch {
			// Not found is the outcome this wants.
		}

		let template;
		try {
			template = await loadServiceTemplate(env, branch);
		} catch (error) {
			return json({ error: `Could not read the page template: ${error.message}` }, 502);
		}

		const html = renderServicePage(template, page, { draft: true });
		const unfilled = findUnfilledPlaceholders(html);
		if (unfilled.length) {
			// Shipping a literal {{PLACEHOLDER}} to a reader is worse than
			// refusing, and means the template gained a field this does not know.
			return json({ error: `The page template has fields this does not fill: ${unfilled.join(", ")}.` }, 500);
		}

		let commit;
		try {
			commit = await commitFiles(
				env,
				branch,
				[{ path: `${page.slug}/index.html`, content: html }],
				`Add service page draft: ${page.title}`
			);
		} catch (error) {
			return json({ error: `Could not save the page: ${error.message}` }, 502);
		}

		// Deliberately not in the sitemap yet, and carrying a noindex. A draft
		// is reachable at its address so it can be read and edited in place,
		// and invisible to Google until somebody decides it is finished.
		return json({ ok: true, slug: page.slug, url: `/${page.slug}`, commit, draft: true });
	}

	if (route === "publish" && request.method === "POST") {
		const body = await readJsonBody(request);
		const slug = String(body?.slug || "").trim();
		if (!slug) return json({ error: "Expected a page to publish." }, 400);

		let html;
		try {
			html = decodeBase64Utf8((await readFile(env, `${slug}/index.html`, branch)).content);
		} catch {
			return json({ error: `There is no page at /${slug}.` }, 404);
		}
		if (!/content="noindex"/.test(html)) return json({ ok: true, slug, alreadyPublished: true });

		const files = [{ path: `${slug}/index.html`, content: removeDraftNoindex(html) }];

		// Into the sitemap at the same moment it becomes indexable, so the two
		// never disagree about whether the page is meant to be found.
		try {
			const sitemap = decodeBase64Utf8((await readFile(env, "sitemap.xml", branch)).content);
			const updated = insertSitemapUrl(sitemap, slug, new Date().toISOString().slice(0, 10));
			if (updated) files.push({ path: "sitemap.xml", content: updated });
		} catch (error) {
			return json({ error: `Could not update the sitemap: ${error.message}` }, 502);
		}

		try {
			const commit = await commitFiles(env, branch, files, `Publish service page: /${slug}`);
			return json({ ok: true, slug, url: `/${slug}`, commit });
		} catch (error) {
			return json({ error: `Could not publish the page: ${error.message}` }, 502);
		}
	}

	return json({ error: "Unknown request." }, 404);
}
