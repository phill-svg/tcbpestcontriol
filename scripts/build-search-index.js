// Regenerates assets/search-index.json from every page's <title> and meta
// description. Run this after adding, removing, or retitling a page:
//
//   node scripts/build-search-index.js
//
// The site has no other build step (plain static HTML served by the
// Worker), so this stays a manual, rerun-when-needed script rather than
// something wired into a deploy pipeline.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", ".well-known", "assets", "src", "scripts", "node_modules"]);
const BRAND_SUFFIX = " | TCB Pest Control Canberra";

function categorize(urlPath) {
	const seg = urlPath.split("/").filter(Boolean)[0] || "";
	if (seg === "" ) return "Home";
	if (seg.startsWith("locations-pest-control") || seg === "locations") return "Location";
	if (seg.startsWith("blog-") || seg === "blog") return "Blog";
	if (["about", "contact", "faq", "privacy", "terms", "resources", "preparation", "pre-purchase-inspection", "servicem8-setup-training", "thank-you"].includes(seg)) return "Page";
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
	const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
		|| html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);

	let title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
	if (title.endsWith(BRAND_SUFFIX)) title = title.slice(0, -BRAND_SUFFIX.length);

	const description = descMatch ? decodeEntities(descMatch[1].trim()) : "";
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
