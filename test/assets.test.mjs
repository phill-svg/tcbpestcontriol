// Which file does the assets binding actually get asked for?
//
// This exists because of a bug that reached the site. fetchAsset takes the
// request and the URL separately, and the last line ignored the URL and
// re-fetched the request instead. For page traffic those agree, so it looked
// fine for as long as it was only ever used for page traffic. The moment the
// SEO link check used it to ask "does this PDF exist?", while the request in
// hand was a POST to /api/seo/links, it fetched the API endpoint, got a 404,
// and reported seven perfectly good PDFs as broken links on the live site.
//
// The whole point of these tests is to record what was asked for, rather than
// what came back -- a stub that answers 200 to everything would have passed
// happily through the bug.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchAsset, fetchNegotiatedImage, fetchMinifiedAsset, wantsBareNotFound, bareNotFound } from "../src/assets.js";

// Records every URL the binding is asked for. `present` is the set of paths
// that exist; anything else 404s, the way not_found_handling does.
function bindingWith(present) {
	const asked = [];
	return {
		asked,
		env: {
			ASSETS: {
				async fetch(request) {
					const path = new URL(request.url).pathname;
					asked.push({ path, method: request.method });
					return new Response(present.includes(path) ? "hello" : "not found", {
						status: present.includes(path) ? 200 : 404,
					});
				},
			},
		},
	};
}

const get = (path) => new Request(`https://www.tcbpestcontrolcanberra.com.au${path}`, { method: "GET" });

test("a page path is served from its index.html", () => {
	const { asked, env } = bindingWith(["/spider-control/index.html"]);
	const url = new URL("https://www.tcbpestcontrolcanberra.com.au/spider-control");
	return fetchAsset(get("/spider-control"), url, env).then((response) => {
		assert.equal(response.status, 200);
		assert.deepEqual(asked.map((entry) => entry.path), ["/spider-control/index.html"]);
	});
});

test("the homepage is served from /index.html", async () => {
	const { asked, env } = bindingWith(["/index.html"]);
	const response = await fetchAsset(get("/"), new URL("https://www.tcbpestcontrolcanberra.com.au/"), env);
	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), ["/index.html"]);
});

test("a file with an extension is fetched as itself", async () => {
	const { asked, env } = bindingWith(["/assets/documents/bed-bug-service-preparation-guide.pdf"]);
	const path = "/assets/documents/bed-bug-service-preparation-guide.pdf";
	const response = await fetchAsset(get(path), new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`), env);
	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [path]);
});

test("the URL decides what is fetched, not the request that happened to be in hand", async () => {
	// The exact shape of the bug: a POST to the link-check endpoint, asking
	// about a PDF. Before the fix this fetched /api/seo/links, got a 404, and
	// declared the PDF broken.
	const path = "/assets/documents/rodent-baiting-service-preparation-guide.pdf";
	const { asked, env } = bindingWith([path]);
	const apiRequest = new Request("https://www.tcbpestcontrolcanberra.com.au/api/seo/links", {
		method: "POST",
		body: JSON.stringify({ targets: [path] }),
		headers: { "content-type": "application/json" },
	});

	const response = await fetchAsset(apiRequest, new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`), env);

	assert.deepEqual(asked.map((entry) => entry.path), [path], "the PDF, not the endpoint the request came in on");
	assert.equal(response.status, 200, "and so it is found, rather than reported as a broken link");
});

test("the same holds for a page path", async () => {
	const { asked, env } = bindingWith(["/contact/index.html"]);
	const apiRequest = new Request("https://www.tcbpestcontrolcanberra.com.au/api/seo/links", { method: "POST", body: "{}" });
	await fetchAsset(apiRequest, new URL("https://www.tcbpestcontrolcanberra.com.au/contact"), env);
	assert.deepEqual(asked.map((entry) => entry.path), ["/contact/index.html"]);
});

test("a genuinely missing file still comes back as missing", async () => {
	// The check has to keep working. If everything answered 200 the report
	// would be silently empty, which reads exactly like a clean site.
	const { env } = bindingWith([]);
	const path = "/assets/documents/never-existed.pdf";
	const response = await fetchAsset(get(path), new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`), env);
	assert.equal(response.status, 404);
});

test("a missing page falls back from index.html to the path itself", async () => {
	// Some pages are flat files rather than folders, and the 404 page itself
	// is served this way.
	const { asked, env } = bindingWith(["/404.html"]);
	const response = await fetchAsset(get("/404.html"), new URL("https://www.tcbpestcontrolcanberra.com.au/404.html"), env);
	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), ["/404.html"]);

	const missing = bindingWith([]);
	await fetchAsset(get("/nope"), new URL("https://www.tcbpestcontrolcanberra.com.au/nope"), missing.env);
	assert.deepEqual(
		missing.asked.map((entry) => entry.path),
		["/nope/index.html", "/nope"],
		"index.html first, then the bare path"
	);
});

// The AVIF swap. Pages only ever link the .webp; which file actually comes back
// is decided here, from the Accept header. Same principle as the tests above --
// what matters is which file the binding was asked for.
const HERO = "/assets/images/tcb-pest-control-technicians-treating-home-9300e-sm.webp";
const HERO_AVIF = "/assets/images/tcb-pest-control-technicians-treating-home-9300e-sm.avif";
const CHROME_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

const imageRequest = (path, accept) =>
	new Request(`https://www.tcbpestcontrolcanberra.com.au${path}`, {
		method: "GET",
		headers: accept ? { Accept: accept } : {},
	});

const imageUrl = (path) => new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`);

test("a browser that accepts AVIF gets the AVIF copy of a webp", async () => {
	const { asked, env } = bindingWith([HERO, HERO_AVIF]);
	const response = await fetchNegotiatedImage(imageRequest(HERO, CHROME_ACCEPT), imageUrl(HERO), env);

	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [HERO_AVIF], "the webp is never fetched");
});

test("a browser that does not accept AVIF gets the webp", async () => {
	const { asked, env } = bindingWith([HERO, HERO_AVIF]);
	const accept = "image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5";
	const response = await fetchNegotiatedImage(imageRequest(HERO, accept), imageUrl(HERO), env);

	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [HERO], "the AVIF is never offered to a browser that cannot read it");
});

test("both answers carry Vary: Accept", async () => {
	// Without this a shared cache can store the AVIF under the .webp URL and
	// then serve those bytes to a browser that cannot decode them -- the image
	// silently fails to appear. It has to be on the webp reply too, or the
	// webp is the one that gets stored unkeyed and handed to everyone.
	for (const accept of [CHROME_ACCEPT, "image/webp,*/*"]) {
		const { env } = bindingWith([HERO, HERO_AVIF]);
		const response = await fetchNegotiatedImage(imageRequest(HERO, accept), imageUrl(HERO), env);
		assert.equal(response.headers.get("Vary"), "Accept", `missing for Accept: ${accept}`);
	}
});

test("an image with no AVIF alongside it falls back to the webp", async () => {
	// build-avif.js skips images AVIF cannot beat, and an image added since the
	// last run has no AVIF at all. Neither may 404.
	const { asked, env } = bindingWith([HERO]);
	const response = await fetchNegotiatedImage(imageRequest(HERO, CHROME_ACCEPT), imageUrl(HERO), env);

	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [HERO_AVIF, HERO], "asks for the AVIF, then settles for the webp");
});

test("a missing image is still missing, rather than becoming a 200", async () => {
	const { env } = bindingWith([]);
	const path = "/assets/images/never-existed.webp";
	const response = await fetchNegotiatedImage(imageRequest(path, CHROME_ACCEPT), imageUrl(path), env);
	assert.equal(response.status, 404);
});

test("everything that is not a webp under /assets/images is left alone", async () => {
	// Returning null is what hands the request back to the ordinary asset path.
	const { env } = bindingWith(["/index.html", "/assets/css/style.css", "/assets/favicon/favicon-32x32.png"]);

	for (const path of ["/", "/assets/css/style.css", "/assets/favicon/favicon-32x32.png", "/assets/images/manifest.json"]) {
		assert.equal(await fetchNegotiatedImage(imageRequest(path, CHROME_ACCEPT), imageUrl(path), env), null, path);
	}

	const post = new Request(`https://www.tcbpestcontrolcanberra.com.au${HERO}`, {
		method: "POST",
		headers: { Accept: CHROME_ACCEPT },
	});
	assert.equal(await fetchNegotiatedImage(post, imageUrl(HERO), env), null, "and only GET/HEAD are negotiated");
});

// The minified-JS/CSS swap. A third-party audit flagged 261 issues for
// shipping the unminified script.js, search.js, chat.js and style.css to
// every one of 130+ pages. Fixing it had to cost zero changes to any of
// those pages, so this works the same way as the AVIF swap above: same URL
// in, smaller bytes out, decided by which file exists.
const SCRIPT = "/assets/js/script.js";
const SCRIPT_MIN = "/assets/js/script.min.js";
const STYLE = "/assets/css/style.css";
const STYLE_MIN = "/assets/css/style.min.css";

test("a script with a minified copy alongside it is served minified", async () => {
	const { asked, env } = bindingWith([SCRIPT, SCRIPT_MIN]);
	const response = await fetchMinifiedAsset(get(SCRIPT), imageUrl(SCRIPT), env);
	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [SCRIPT_MIN], "the unminified file is never fetched");
});

test("the stylesheet is served minified the same way", async () => {
	const { asked, env } = bindingWith([STYLE, STYLE_MIN]);
	const response = await fetchMinifiedAsset(get(STYLE), imageUrl(STYLE), env);
	assert.equal(response.status, 200);
	assert.deepEqual(asked.map((entry) => entry.path), [STYLE_MIN]);
});

test("a script with no minified copy yet falls through, not 404s", async () => {
	// build-min-assets.js has not run since the file was added, or has never
	// run at all on this checkout. Either way the page must still load.
	const { env } = bindingWith([SCRIPT]);
	assert.equal(await fetchMinifiedAsset(get(SCRIPT), imageUrl(SCRIPT), env), null);
});

test("only the allowlisted public scripts are swapped", async () => {
	// The admin editor's own scripts are deliberately never minified -- see
	// the comment at the top of build-min-assets.js -- and nothing outside
	// /assets/js or /assets/css should be touched at all.
	const editorJs = "/assets/js/editor.js";
	const { env } = bindingWith([editorJs, `${editorJs.replace(/\.js$/, ".min.js")}`, "/index.html"]);
	for (const path of [editorJs, "/index.html", "/assets/documents/guide.pdf"]) {
		assert.equal(await fetchMinifiedAsset(get(path), imageUrl(path), env), null, path);
	}

	const post = new Request(`https://www.tcbpestcontrolcanberra.com.au${SCRIPT}`, { method: "POST" });
	const { env: postEnv } = bindingWith([SCRIPT, SCRIPT_MIN]);
	assert.equal(await fetchMinifiedAsset(post, imageUrl(SCRIPT), postEnv), null, "and only GET/HEAD are negotiated");
});

// A missing *file* answers with a bare 404, not the HTML 404 page.
//
// `not_found_handling: "404-page"` is right for a mistyped page address and
// wrong for a file: an audit tool probing /.webmcp/bridge.js (the WebMCP
// agent-bridge convention, a well-known probe like /llms.txt) got 27KB of
// unminified HTML back at a .js address, and reported "unminified
// JavaScript" against all 94 crawled pages for a file this site has never
// had. The page fallback has to stay for pages, so the split is by whether
// the address names a file.

test("a missing file is a file-shaped 404, not the HTML 404 page", () => {
	for (const path of [
		"/.webmcp/bridge.js",
		"/assets/js/never-existed.js",
		"/assets/css/gone.css",
		"/assets/images/missing.webp",
		"/assets/fonts/absent.woff2",
		"/assets/documents/removed.pdf",
	]) {
		assert.equal(wantsBareNotFound(new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`)), true, path);
	}
});

test("a mistyped page address still gets the real 404 page", () => {
	// This is the half that has to keep working: somebody who types a page
	// name wrong should land somewhere useful, not on the word "Not found".
	for (const path of [
		"/",
		"/spider-control",
		"/locations-pest-control-kambah",
		"/spider-control/garden-orb-weaver-spider",
		"/blog-dangerous-spiders-canberra",
		"/mistyped-page-name",
		"/locations.pest.control",
	]) {
		assert.equal(wantsBareNotFound(new URL(`https://www.tcbpestcontrolcanberra.com.au${path}`)), false, path);
	}
});

test("a dotfile is not mistaken for a file with an extension", () => {
	// ".well-known/did.json" ends in a real extension and is a file; a bare
	// dotfile like "/.htaccess" has no extension at all, so it is left alone.
	assert.equal(wantsBareNotFound(new URL("https://www.tcbpestcontrolcanberra.com.au/.well-known/did.json")), true);
	assert.equal(wantsBareNotFound(new URL("https://www.tcbpestcontrolcanberra.com.au/.htaccess")), false);
});

test("the bare 404 is small, plain and uncached", () => {
	const response = bareNotFound();
	assert.equal(response.status, 404);
	assert.match(response.headers.get("content-type"), /text\/plain/);
	assert.match(response.headers.get("Cache-Control"), /no-store/);
});
