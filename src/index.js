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

// html_handling is "none", so the assets binding only serves exact matches
// -- it won't map a clean URL like "/residential" to "residential/index.html"
// on its own. Try the exact path first (covers "/", static files, and any
// literal extensionless file like /.well-known/api-catalog), then fall back
// to that path's index.html for directory-style URLs.
async function fetchAsset(request, url, env) {
        const directPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const directRequest = directPath === url.pathname
                        ? request
                        : new Request(new URL(directPath, url), request);
        const directResponse = await env.ASSETS.fetch(directRequest);
        if (directResponse.status !== 404) {
                        return directResponse;
        }

        const indexRequest = new Request(new URL(`${url.pathname}/index.html`, url), request);
        return env.ASSETS.fetch(indexRequest);
}
