// Converts a page's rendered HTML into clean Markdown for agents that want
// plain text instead of HTML, mirroring the /:slug.md convention some
// agent-visibility templates use.
//
// Deliberately simple and mechanical -- no AI involved. Extracts <title>,
// the meta description, and the headings/paragraphs/list items found inside
// <main>, in document order. Every page on this site wraps its content in a
// single <main>...</main> between the shared header and footer, so scoping
// extraction to <main> already excludes nav/header/footer chrome without
// needing to name it explicitly.
//
// NOTE: HTMLRewriter only exists in the Workers runtime, not Node, so this
// couldn't be exercised with the same local test harness used for the rest
// of the agent-facing code in this repo -- verify with a live request after
// deploy (this is a safe, read-only GET, unlike the booking-enquiry tool).
export async function renderMarkdown(htmlResponse, pageUrl) {
	let title = "";
	let description = "";
	const blocks = [];

	function pushBlock(type) {
		blocks.push({ type, text: "" });
	}
	function appendText(type, chunk) {
		const last = blocks[blocks.length - 1];
		if (last && last.type === type) last.text += chunk;
	}

	const collector = new HTMLRewriter()
		.on("title", {
			text(t) {
				title += t.text;
			},
		})
		.on('meta[name="description"]', {
			element(el) {
				const c = el.getAttribute("content");
				if (c) description = c;
			},
		})
		.on("main h1", { element: () => pushBlock("h1"), text: (t) => appendText("h1", t.text) })
		.on("main h2", { element: () => pushBlock("h2"), text: (t) => appendText("h2", t.text) })
		.on("main h3", { element: () => pushBlock("h3"), text: (t) => appendText("h3", t.text) })
		.on("main h4", { element: () => pushBlock("h4"), text: (t) => appendText("h4", t.text) })
		.on("main p", { element: () => pushBlock("p"), text: (t) => appendText("p", t.text) })
		.on("main li", { element: () => pushBlock("li"), text: (t) => appendText("li", t.text) });

	// HTMLRewriter is a streaming transform -- handlers only fire as the body
	// is actually read, so it has to be fully consumed here even though the
	// (rewritten, discarded) HTML output itself isn't used.
	await collector.transform(htmlResponse).text();

	const cleanTitle = title.split("|")[0].trim() || pageUrl.pathname;
	const lines = [`# ${cleanTitle}`];
	if (description) lines.push("", description.trim());

	const headingHash = { h1: "##", h2: "##", h3: "###", h4: "####" };
	let inList = false;
	for (const b of blocks) {
		const text = b.text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (b.type === "li") {
			lines.push(`- ${text}`);
			inList = true;
		} else {
			if (inList) lines.push("");
			inList = false;
			if (b.type === "p") lines.push("", text);
			else lines.push("", `${headingHash[b.type]} ${text}`);
		}
	}

	lines.push("", `Source: ${pageUrl.toString()}`);

	return new Response(lines.join("\n").trim() + "\n", {
		status: 200,
		headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
	});
}
