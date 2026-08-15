// Temporary harness for test/address-parity.test.mjs -- exposes the real
// applyContentEdits() over HTTP so the test can run it inside real workerd.
// Not deployed; removed once the test has served its purpose.
import { applyContentEdits } from "../../src/content-edits.js";

export default {
	async fetch(request) {
		if (request.method !== "POST") return new Response("post {html, edits} here", { status: 405 });
		const { html, edits } = await request.json();
		const rewritten = applyContentEdits(new HTMLRewriter(), new Map(Object.entries(edits))).transform(
			new Response(html, { headers: { "content-type": "text/html" } })
		);
		return new Response(await rewritten.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
	},
};
