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

// Every image on the site is a .webp, and every page asks for it by that name.
// scripts/build-avif.js writes an .avif alongside each one -- same picture,
// roughly 30% fewer bytes -- and this hands that copy to browsers that say they
// can read it.
//
// Doing it here rather than with <picture> markup is what keeps it cheap: the
// swap covers all 53 images across all 138 pages without touching a single HTML
// file, and the visual editor keeps seeing the plain <img src="...webp"> it
// knows how to rewrite.
//
// Returns null when this isn't a request the swap applies to, and the caller
// falls through to the ordinary asset path.
export async function fetchNegotiatedImage(request, url, env) {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	if (!url.pathname.startsWith("/assets/images/") || !url.pathname.endsWith(".webp")) return null;

	// Vary goes on both branches, not just the AVIF one. Without it a cache that
	// stored the AVIF reply under this .webp URL would go on to hand those bytes
	// to a browser that cannot decode them, and the image would simply not
	// appear. With it, each Accept header gets its own cache entry.
	const accept = request.headers.get("Accept") || "";
	if (accept.includes("image/avif")) {
		const avifUrl = new URL(url);
		avifUrl.pathname = `${url.pathname.slice(0, -".webp".length)}.avif`;
		const avif = await env.ASSETS.fetch(new Request(avifUrl, request));
		// A missing .avif is not an error -- an image added since the last
		// build:avif run simply stays webp until someone regenerates.
		if (avif.status === 200) return withVaryOnAccept(avif);
	}

	return withVaryOnAccept(await env.ASSETS.fetch(new Request(url, request)));
}

function withVaryOnAccept(response) {
	const headers = new Headers(response.headers);
	headers.set("Vary", "Accept");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
