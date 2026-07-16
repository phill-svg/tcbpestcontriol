export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// Canonicalise the bare apex domain to www.
		// Both hostnames are bound as Worker Custom Domains, so Cloudflare
		// Page Rules never get a chance to run for them -- this has to
		// happen here, before assets are served.
		if (url.hostname === "tcbpestcontrolcanberra.com.au") {
			url.hostname = "www.tcbpestcontrolcanberra.com.au";
			return Response.redirect(url.toString(), 301);
		}

		// Enforce the no-trailing-slash URL convention ourselves.
		// html_handling is "none" below because Cloudflare's own
		// trailing-slash/index.html canonicalisation redirects the root
		// path "/" to itself forever -- it has no shorter form to drop
		// the slash to. Handling this in the Worker lets us exempt "/".
		if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			return Response.redirect(url.toString(), 301);
		}

		const response = await fetchAsset(request, url, env);

		// Force every served HTML page's canonical tag to self-reference the
		// exact URL it was actually served at. A past URL-structure migration
		// left canonical tags on ~114 pages pointing at a different (often
		// redirecting) URL. Fixing this at the edge, once, keeps every page
		// correct automatically instead of hand-editing each HTML file.
		const contentType = response.headers.get("content-type") || "";
		if (response.status === 200 && contentType.includes("text/html")) {
			const canonicalUrl = `${url.origin}${url.pathname}`;
			return new HTMLRewriter()
				.on('link[rel="canonical"]', {
					element(el) {
						el.setAttribute("href", canonicalUrl);
					},
				})
				.transform(response);
		}

		return response;
	},
};

// html_handling is "none", so in principle the assets binding should only
// serve exact matches. In practice, calling env.ASSETS.fetch() directly on a
// bare directory-style path (e.g. "/residential") can still trigger the
// binding's own internal trailing-slash canonicalisation, returning a 301 to
// "/residential/" instead of a 404. Since our top-level handler above strips
// trailing slashes, that redirect immediately bounces back here and loops
// forever between the two forms.
//
// To avoid ever calling the binding on an ambiguous bare-directory path, we
// resolve directory-style URLs (no file extension in the last segment) to
// their index.html directly, first. Only paths that already look like a
// literal file (have an extension) or don't match any index.html fall back
// to an exact-match lookup.
async function fetchAsset(request, url, env) {
	const lastSegment = url.pathname.split("/").pop();
	const looksLikeDirectory = url.pathname === "/" || !lastSegment.includes(".");

	if (looksLikeDirectory) {
		const indexPath = url.pathname === "/" ? "/index.html" : `${url.pathname}/index.html`;
		const indexResponse = await env.ASSETS.fetch(new Request(new URL(indexPath, url), request));
		if (indexResponse.status !== 404) {
			return indexResponse;
		}

		// A handful of pages (about, faq, privacy, resources, terms) were
		// never migrated to the directory/index.html structure the rest of
		// the site uses -- they only exist as a flat "<name>.html" file.
		// Fall back to that before giving up, so their clean URL (which is
		// what's in the sitemap and linked throughout the site) resolves.
		const htmlPath = `${url.pathname}.html`;
		const htmlResponse = await env.ASSETS.fetch(new Request(new URL(htmlPath, url), request));
		if (htmlResponse.status !== 404) {
			return htmlResponse;
		}
	}

	return env.ASSETS.fetch(request);
}
