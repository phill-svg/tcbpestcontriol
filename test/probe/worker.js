// Harness for the parity tests -- exposes the real Worker-side code over HTTP
// so the tests can run it inside real workerd rather than a stand-in.
//
//   POST /     {html, edits}  -> applyContentEdits(), for address parity
//   POST /seo  {html}         -> extractPageSummary(), for SEO parity
//
// Not deployed; it exists only so those two tests can compare workerd's
// answers against the browser's.
import { applyContentEdits } from "../../src/content-edits.js";
import { extractPageSummary } from "../../src/seo-scan.js";

export default {
	async fetch(request) {
		if (request.method !== "POST") return new Response("post {html, edits} here", { status: 405 });
		const url = new URL(request.url);

		if (url.pathname === "/seo") {
			const { html } = await request.json();
			const summary = await extractPageSummary(new Response(html, { headers: { "content-type": "text/html" } }));
			return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
		}

		const { html, edits } = await request.json();
		const rewritten = applyContentEdits(new HTMLRewriter(), new Map(Object.entries(edits))).transform(
			new Response(html, { headers: { "content-type": "text/html" } })
		);
		return new Response(await rewritten.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
	},
};
