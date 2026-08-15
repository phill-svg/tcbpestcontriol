// Reading a static file out of the assets binding.
//
// `html_handling` is "none" in wrangler.jsonc, so nothing maps /spider-control
// to /spider-control/index.html automatically -- this does it, and everything
// that serves a page goes through here.
//
// It lives in its own module rather than inside src/index.js because index.js
// imports `cloudflare:workers` and so cannot be loaded by a Node test at all.
// That mattered: the two-argument shape below has a trap in it, the trap went
// off in production, and there was nowhere to pin it.

// Fetches whatever `url` points at. `request` supplies the method and headers;
// `url` decides what is asked for.
//
// Those two being separate arguments is the whole point, and was also the bug.
// For ordinary page traffic they agree, so passing `request` straight through
// looked equivalent -- but the SEO link check calls this as "does
// /assets/documents/whatever.pdf exist?" while `request` is the POST to
// /api/seo/links. Every PDF on the site came back 404 and got reported as a
// broken link, because what was being fetched was the API endpoint. The
// directory branch happened to build its URL properly, which is why only
// paths with a dot in them were affected.
export async function fetchAsset(request, url, env) {
	const lastSegment = url.pathname.split("/").pop();
	const looksLikeDirectory = url.pathname === "/" || !lastSegment.includes(".");

	if (looksLikeDirectory) {
		const indexPath = url.pathname === "/" ? "/index.html" : `${url.pathname}/index.html`;
		const indexResponse = await env.ASSETS.fetch(new Request(new URL(indexPath, url), request));
		if (indexResponse.status !== 404) {
			return indexResponse;
		}
	}

	return env.ASSETS.fetch(new Request(url, request));
}
