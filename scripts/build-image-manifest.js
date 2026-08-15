// Regenerates assets/images/manifest.json -- the list the visual editor's
// image picker reads.
//
// Cloudflare's static assets have no runtime "list the directory" API, so the
// Worker genuinely cannot discover what images exist. Generating the list at
// author time is the whole trick, and it is the same small build step already
// used by scripts/build-search-index.js and scripts/build-css.js.
//
// Run this after adding or removing images, then commit the manifest:
//   node scripts/build-image-manifest.js

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.join(__dirname, "..", "assets", "images");
const outFile = path.join(imagesDir, "manifest.json");

// Raster and vector formats the site actually uses. Anything else in the
// folder (a stray .psd, a README) stays out of the picker.
const EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png", ".svg", ".avif", ".gif"]);

const present = new Set(readdirSync(imagesDir));

// An .avif that sits next to a .webp of the same name is not a picture in its
// own right -- it is the compressed alternate scripts/build-avif.js generated,
// which the Worker swaps in by itself. Listing it would show every photograph
// in the picker twice, and picking that entry would hard-code the AVIF into the
// page for browsers that cannot read it. A standalone .avif is still a real
// choice and stays.
const isGeneratedAvif = (name) =>
	path.extname(name).toLowerCase() === ".avif" && present.has(`${name.slice(0, -".avif".length)}.webp`);

const images = readdirSync(imagesDir)
	.filter((name) => EXTENSIONS.has(path.extname(name).toLowerCase()))
	.filter((name) => !isGeneratedAvif(name))
	.filter((name) => statSync(path.join(imagesDir, name)).isFile())
	.sort()
	.map((name) => ({
		path: `/assets/images/${name}`,
		bytes: statSync(path.join(imagesDir, name)).size,
	}));

writeFileSync(outFile, `${JSON.stringify({ images }, null, "\t")}\n`);
console.log(`Wrote ${path.relative(path.join(__dirname, ".."), outFile)} with ${images.length} images.`);
