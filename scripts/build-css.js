// Rebuilds assets/css/style.css from the source files in assets/css/src/.
//
// The site has no build step for deploys -- every page links the single
// compiled assets/css/style.css directly, and that doesn't change. This
// script just lets you *edit* CSS in smaller, purpose-named files instead
// of one 3000+ line file, then regenerate the single file that actually
// ships. Run it after editing anything in assets/css/src/, then bump the
// ?v= cache-busting version as usual (see the comment at the top of
// assets/css/src/00-base.css) before committing.
//
// Same idea as scripts/build-search-index.js -- a small author-time
// generation step, not a runtime build pipeline.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "assets", "css", "src");
const outFile = path.join(__dirname, "..", "assets", "css", "style.css");

// Order matters: later files can rely on custom properties, resets, and
// shared classes (.btn, .form, .field, ...) defined in earlier ones.
const files = [
	"00-base.css", // fonts, :root variables, resets, .btn
	"01-header-hero.css", // site header/nav, homepage hero
	"02-home-sections.css", // homepage content blocks (services, pests, why us, approach, CTA)
	"03-footer.css",
	"04-page-components.css", // reusable inner-page pieces (simple hero, trust bar, grid-card system, accreditation)
	"05-forms.css", // contact form, and the shared .form/.field used by chat + staff dashboard forms too
	"06-content.css", // prose/legal pages, blog listing + article body
	"07-search.css", // site search overlay
	"08-chat-widget.css", // customer-facing live chat bubble/panel
	"09-staff-dashboard.css", // /staff-chat admin dashboard
	"10-pricing.css", // /pricing page
];

const missing = files.filter((f) => !readdirSync(srcDir).includes(f));
if (missing.length) {
	console.error("Missing expected source file(s):", missing.join(", "));
	process.exit(1);
}

const combined = files.map((f) => readFileSync(path.join(srcDir, f), "utf8").replace(/\n+$/, "")).join("\n\n") + "\n";

writeFileSync(outFile, combined);
console.log(`Built assets/css/style.css from ${files.length} files in assets/css/src/`);
