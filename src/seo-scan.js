// Checking every page on the site, not just the one you are looking at.
//
// The page list comes from sitemap.xml rather than from walking directories,
// because the sitemap is the list Google actually crawls. A page missing from
// it is invisible whatever its title says, and a page in it that no longer
// exists is a different problem worth seeing -- both of which a directory walk
// would quietly paper over.
//
// Scanning is batched. Reading and parsing 134 pages in one request is well
// past what a Worker should do in a single invocation, so the browser asks for
// a slice at a time and shows progress. That also means a slow scan degrades
// into a longer scan rather than a failed one.

import { checkSeo } from "../assets/js/seo-check.js";
import { normalisePath } from "../assets/js/content-address.js";
import { decodeEntities } from "./html-entities.js";
import { linkTarget } from "../assets/js/seo-site.js";

// Pulled out of the <loc> elements. Only the path is kept -- the scan asks the
// assets binding for pages, not the public internet.
export function pathsFromSitemap(xml) {
	const paths = [];
	for (const match of String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
		try {
			paths.push(normalisePath(new URL(match[1]).pathname));
		} catch {
			// A malformed <loc> is worth skipping rather than failing the scan.
		}
	}
	return [...new Set(paths)];
}

// Extracts what checkSeo needs from a page, using the same parser that serves
// it. Regex over HTML was the first instinct and the wrong one: this site
// writes `<meta content="..." name="description">` with the attributes in that
// order, and a pattern expecting the opposite reported all 134 pages as having
// no description at all. A real parser has no opinion about attribute order.
//
// Everything read here is then entity-decoded, because HTMLRewriter hands
// back the raw source. A reader sees "Termite Treatment & Inspections"; the
// file says "Termite Treatment &amp; Inspections", which is four characters
// longer. Measured raw, that title came to 63 characters and was reported as
// too long for Google -- while the browser-side check on the same page, which
// reads the decoded DOM, correctly said 59 and found nothing wrong. The
// scanner was the one that was wrong.
export async function extractPageSummary(response) {
	const summary = {
		title: "",
		description: "",
		h1Count: 0,
		images: [],
		links: [],
		hasCanonical: false,
	};

	let inTitle = false;

	const rewriter = new HTMLRewriter()
		.on("title", {
			element(element) {
				// Only the first <title>; a stray one inside an inline SVG would
				// otherwise overwrite the real one.
				inTitle = !summary.title;
				try {
					element.onEndTag(() => {
						inTitle = false;
					});
				} catch {
					inTitle = false;
				}
			},
			text(chunk) {
				if (inTitle) summary.title += chunk.text;
			},
		})
		.on('meta[name="description"]', {
			element(element) {
				if (!summary.description) summary.description = element.getAttribute("content") || "";
			},
		})
		.on('link[rel="canonical"]', {
			element() {
				summary.hasCanonical = true;
			},
		})
		.on("h1", {
			element() {
				summary.h1Count++;
			},
		})
		.on("img", {
			element(element) {
				summary.images.push({
					src: element.getAttribute("src") || "",
					hasAlt: element.hasAttribute("alt"),
					altText: element.getAttribute("alt"),
				});
			},
		})
		.on("a[href]", {
			element(element) {
				// Link text arrives as separate chunks after the element, so the
				// last-pushed entry is the one being filled.
				summary.links.push({ href: element.getAttribute("href") || "", text: "" });
			},
			text(chunk) {
				const last = summary.links[summary.links.length - 1];
				if (last) last.text += chunk.text;
			},
		});

	// The body has to be drained for the handlers to run.
	await rewriter.transform(response).text();

	// Everything measured or matched against must be what a reader sees, not
	// what the file happens to encode.
	summary.title = decodeEntities(summary.title).trim();
	summary.description = decodeEntities(summary.description);
	for (const image of summary.images) {
		if (image.altText !== null && image.altText !== undefined) image.altText = decodeEntities(image.altText);
	}
	for (const link of summary.links) {
		link.text = decodeEntities(link.text);
		// `&amp;` in a query string is the common case, and while the query is
		// dropped before a link is followed up, an href that has been decoded
		// is the one a browser would act on.
		link.href = decodeEntities(link.href);
	}
	return summary;
}

// Scans one slice of the site. `loadEdits` is optional and lets published
// title/description overrides be taken into account -- without it the scan
// would report the wording in the files rather than the wording visitors see.
// `extract` defaults to the real HTMLRewriter-based reader and is injectable
// so the batching -- which pages get visited, what happens when one fails,
// whether overrides are applied -- can be tested without a Worker runtime.
//
// Returns `results` (per-page findings, healthy pages omitted) and `pages`
// (what each page said, for the cross-page checks in assets/js/seo-site.js).
// Duplicate titles and unlinked pages cannot be seen a page at a time, so the
// raw material has to come back with the findings rather than instead of them.
export async function scanBatch({ paths, offset, limit, fetchPage, loadEdits, extract = extractPageSummary, origin }) {
	const slice = paths.slice(offset, offset + limit);
	const results = [];
	const pages = [];

	for (const path of slice) {
		let summary;
		try {
			const response = await fetchPage(path);
			if (!response || response.status !== 200) {
				results.push({
					path,
					findings: [
						{
							level: "problem",
							message: `This page is in the sitemap but does not load (${response ? response.status : "no response"}).`,
						},
					],
				});
				continue;
			}
			summary = await extract(response);
		} catch (error) {
			results.push({ path, findings: [{ level: "problem", message: `Could not read this page: ${error.message}` }] });
			continue;
		}

		if (loadEdits) {
			// What a visitor sees, not what the file says.
			const edits = await loadEdits(path);
			if (edits) {
				const title = edits.get("m:title");
				const description = edits.get("m:description");
				if (title !== undefined) summary.title = title;
				if (description !== undefined) summary.description = description;
			}
		}

		pages.push({
			path,
			title: summary.title,
			description: summary.description,
			// Deduplicated per page: a header, a footer and a body paragraph
			// all linking to /contact is one relationship, not three.
			targets: [
				...new Set(
					(summary.links || []).map((link) => linkTarget(link.href, path, origin)).filter((target) => target !== null)
				),
			],
		});

		const findings = checkSeo(summary).filter((finding) => finding.level !== "good");
		if (findings.length) results.push({ path, findings });
	}

	return { results, pages, scanned: slice.length, done: offset + slice.length >= paths.length };
}
