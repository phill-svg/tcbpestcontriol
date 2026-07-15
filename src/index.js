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

            const response = await env.ASSETS.fetch(request);

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
