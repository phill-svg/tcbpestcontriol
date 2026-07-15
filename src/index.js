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

      return env.ASSETS.fetch(request);
    },
};
