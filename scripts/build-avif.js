// Writes an .avif copy of every .webp in assets/images/.
//
// The site's pages only ever reference the .webp. The Worker (see
// fetchNegotiatedImage in src/assets.js) hands the .avif to browsers whose
// Accept header says they can read it, and the .webp to everyone else -- so
// these files are picked up without a single change to the HTML.
//
// Same author-time generation step as scripts/build-css.js and
// scripts/build-image-manifest.js: run it after adding or replacing an image,
// then commit what it writes.
//
//   npm run build:avif
//
// sharp is a devDependency, so this needs `npm install` first. Nothing at
// deploy time or runtime needs it -- the .avif files are committed.
//
// Missing an .avif is harmless: the Worker checks for it and falls back to the
// .webp, so a newly added image is simply a little heavier until this is rerun.

import { readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.join(__dirname, "..", "assets", "images");

// Quality 58 is where AVIF lands at roughly the same visual quality as the
// WebP files it is replacing, while still coming in ~30% smaller. Going lower
// saves more but starts showing on the large hero photographs, which are the
// ones most worth getting right -- one of them is the LCP element on every
// page that has a hero.
const QUALITY = 58;

// Effort 4 rather than sharp's slowest setting: it encodes in about a third of
// the time for roughly 1% more bytes, which is the difference between this
// being a coffee-length step after adding an image and an hour-long one.
const EFFORT = 4;

// A file whose .avif is newer than its .webp is already up to date. Pass
// --force to re-encode everything, e.g. after changing QUALITY above.
const force = process.argv.includes("--force");

const sources = readdirSync(imagesDir)
	.filter((name) => name.toLowerCase().endsWith(".webp"))
	.filter((name) => statSync(path.join(imagesDir, name)).isFile())
	.sort();

let written = 0;
let skipped = 0;
let webpBytes = 0;
let avifBytes = 0;
let kept = 0;

for (const name of sources) {
	const webpPath = path.join(imagesDir, name);
	const avifPath = path.join(imagesDir, `${name.slice(0, -".webp".length)}.avif`);

	const webpSize = statSync(webpPath).size;
	webpBytes += webpSize;

	if (!force && existsSync(avifPath) && statSync(avifPath).mtimeMs >= statSync(webpPath).mtimeMs) {
		avifBytes += statSync(avifPath).size;
		skipped += 1;
		continue;
	}

	const encoded = await sharp(webpPath).avif({ quality: QUALITY, effort: EFFORT }).toBuffer();

	// AVIF is not always the winner -- small flat images (badges, the logo) can
	// come out heavier than the WebP they replace. Writing those anyway would
	// make the site slower for exactly the browsers with the best format
	// support, so leave them out and let the Worker's fallback serve the WebP.
	if (encoded.length >= webpSize) {
		avifBytes += webpSize;
		kept += 1;
		console.log(`keep webp  ${name} (avif would be ${encoded.length} vs ${webpSize})`);
		continue;
	}

	writeFileSync(avifPath, encoded);
	avifBytes += encoded.length;
	written += 1;
	console.log(`${name} ${webpSize} -> ${encoded.length} (${Math.round((1 - encoded.length / webpSize) * 100)}% smaller)`);
}

const saved = webpBytes - avifBytes;
console.log(
	`\n${written} written, ${skipped} already current, ${kept} left as webp. ` +
		`${Math.round(webpBytes / 1024)} KiB of webp -> ${Math.round(avifBytes / 1024)} KiB served ` +
		`(${Math.round(saved / 1024)} KiB, ${Math.round((saved / webpBytes) * 100)}% smaller) for browsers that accept AVIF.`
);
