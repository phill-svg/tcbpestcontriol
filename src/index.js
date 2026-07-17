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
				.on(".header-actions", {
					element(el) {
						el.before(SEARCH_TRIGGER_HTML, { html: true });
					},
				})
				.on("body", {
					element(el) {
						el.append(SEARCH_OVERLAY_HTML, { html: true });
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
	}

	return env.ASSETS.fetch(request);
}

// Injected into every page's header, right before the phone/CTA group, via
// HTMLRewriter -- same "fix it once at the edge" approach used above for
// canonical tags. Visible at every breakpoint (it sits outside the
// .main-nav/.header-actions containers that main.css hides on mobile), so it
// doubles as the mobile search entry point next to the hamburger button.
const SEARCH_TRIGGER_HTML = `<button type="button" class="search-trigger" data-search-open aria-label="Search the site" title="Search (press /)"><svg aria-hidden="true" class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg></button>`;

// Command-palette style overlay appended once per page, just before </body>.
// assets/js/search.js wires it up and lazy-loads assets/search-index.json
// (regenerate that with `node scripts/build-search-index.js` after adding,
// removing, or retitling a page).
const SEARCH_OVERLAY_HTML = `<div class="search-overlay" id="site-search" role="dialog" aria-modal="true" aria-label="Search the site" hidden><div class="search-backdrop" data-search-close></div><div class="search-panel"><div class="search-field"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input type="text" class="search-input" placeholder="Search services, suburbs, articles..." autocomplete="off" aria-label="Search"/><button type="button" class="search-close" data-search-close>Esc</button></div><div class="search-results"></div></div></div><script src="/assets/js/search.js"></script>`;
