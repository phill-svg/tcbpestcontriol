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

import { fetchAsset } from "../src/assets.js";

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
