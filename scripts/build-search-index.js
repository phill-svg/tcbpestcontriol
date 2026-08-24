// Regenerates assets/search-index.json from every page's <title> and meta
// description. Run this after adding, removing, or retitling a page:
//
//   node scripts/build-search-index.js
//
// The site has no other build step (plain static HTML served by the
// Worker), so this stays a manual, rerun-when-needed script rather than
// something wired into a deploy pipeline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", ".well-known", "assets", "src", "scripts", "node_modules"]);
const BRAND_SUFFIX = " | TCB Pest Control Canberra";

function categorize(urlPath) {
	const seg = urlPath.split("/").filter(Boolean)[0] || "";
	if (seg === "" ) return "Home";
	if (seg.startsWith("locations-pest-control") || seg === "locations") return "Location";
	if (seg.startsWith("blog-") || seg === "blog") return "Blog";
	if (["about", "contact", "faq", "privacy", "terms", "resources", "preparation", "pre-purchase-inspection", "servicem8-setup-training", "thank-you", "pricing"].includes(seg)) return "Page";
	return "Service";
}

function decodeEntities(str) {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function extract(html) {
	const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
	// The quote character is captured and backreferenced (\1) rather than
	// just excluded from the value, so a description containing an
	// apostrophe (e.g. "TCB's...", "O'Connor") doesn't get truncated at
	// the first one when the attribute itself is double-quoted.
	const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=(["'])([^>]*?)\1/i)
		|| html.match(/<meta[^>]*content=(["'])([^>]*?)\1[^>]*name=["']description["']/i);

	let title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
	if (title.endsWith(BRAND_SUFFIX)) title = title.slice(0, -BRAND_SUFFIX.length);

	const description = descMatch ? decodeEntities(descMatch[2].trim()) : "";
	return { title, description };
}

function walk(dir, urlPath, results) {
	const indexFile = path.join(dir, "index.html");
	if (fs.existsSync(indexFile)) {
		const html = fs.readFileSync(indexFile, "utf8");
		const { title, description } = extract(html);
		if (title) {
			results.push({
				url: urlPath === "" ? "/" : urlPath,
				title,
				description,
				category: categorize(urlPath),
			});
		}
	}

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (dir === ROOT && SKIP_DIRS.has(entry.name)) continue;
		walk(path.join(dir, entry.name), `${urlPath}/${entry.name}`, results);
	}
}

const results = [];
walk(ROOT, "", results);
results.sort((a, b) => a.url.localeCompare(b.url));

const outPath = path.join(ROOT, "assets", "search-index.json");
fs.writeFileSync(outPath, JSON.stringify(results));
console.log(`Wrote ${results.length} pages to assets/search-index.json`);
