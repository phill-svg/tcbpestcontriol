// Writing a better title or description, rather than only saying the current
// one is weak.
//
// "The title is 80 characters" tells you a fact about a string. It does not
// tell you what to write instead, and the gap between those two is where the
// whole panel stops being useful -- knowing a title is poor and knowing what
// a good one looks like are different skills, and only one of them is worth
// asking a business owner to learn.
//
// So this drafts candidates from what is already on the page, and from the
// phrases people really searched to reach it when Search Console is
// connected. Everything it produces is a draft in the editor: it is reviewed
// and saved by hand, and nothing reaches the site without that.
//
// The risk is obvious and is taken seriously below. A language model asked to
// write marketing copy will cheerfully invent "24/7 emergency callout",
// "licensed and insured" or "over 20 years' experience", and a business owner
// skim-reading three plausible options is exactly who would not catch it. So
// candidates are machine-checked before anybody sees them: no number and no
// claim that is not already made on the page survives. That is a blunt rule
// and it throws away some perfectly good suggestions. It is the right trade
// -- the cost of a rejected suggestion is another click, and the cost of an
// invented licence claim on a pest control website is not.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Words that assert something a customer could act on, or complain about.
// Trade-services copy attracts all of these, and every one of them is a claim
// about the business that a model has no way of knowing.
const CLAIM_WORDS = [
	"accredited",
	"affordable",
	"approved",
	"award",
	"award-winning",
	"best",
	"cheapest",
	"certified",
	"discount",
	"emergency",
	"expert",
	"fastest",
	"free",
	"guarantee",
	"guaranteed",
	"immediate",
	"instant",
	"insured",
	"leading",
	"licence",
	"license",
	"licensed",
	"number one",
	"qualified",
	"registered",
	"same day",
	"same-day",
	"top rated",
	"top-rated",
	"trusted",
	"unbeatable",
	"warranty",
];

const normalise = (value) => String(value || "").toLowerCase().replace(/[’']/g, "'");

// Every run of digits in the text. A candidate may only use numbers the page
// already uses -- which rules out invented prices, invented years in business,
// invented response times and "24/7".
export function numbersIn(text) {
	return new Set((normalise(text).match(/\d+/g) || []));
}

export function claimsIn(text) {
	const haystack = normalise(text);
	const found = CLAIM_WORDS.filter((word) => haystack.includes(word));
	// Matching is by substring so that plurals and inflections are caught
	// without a list of every form. That means "licensed" also matches
	// "license", and "guaranteed" also matches "guarantee" -- so the shorter
	// of an overlapping pair is dropped, or the message would name a word the
	// suggestion does not contain.
	return new Set(found.filter((word) => !found.some((other) => other !== word && other.includes(word))));
}

// `source` is everything the page itself says -- its own title, description,
// heading and body text. A candidate is allowed to rearrange and sharpen what
// is there. It is not allowed to add facts.
export function validateSuggestion(candidate, { source, min, max, current } = {}) {
	const text = String(candidate || "").trim();
	if (!text) return { ok: false, reason: "empty" };
	if (max && text.length > max) return { ok: false, reason: `too long (${text.length})` };
	if (min && text.length < min) return { ok: false, reason: `too short (${text.length})` };
	if (current && normalise(text) === normalise(current)) return { ok: false, reason: "unchanged" };

	// Models like to answer with the instruction attached.
	if (/^(here|sure|option|certainly|of course)\b/i.test(text)) return { ok: false, reason: "not a title" };
	if (text.includes("\n")) return { ok: false, reason: "more than one line" };

	const allowedNumbers = numbersIn(source);
	for (const number of numbersIn(text)) {
		if (!allowedNumbers.has(number)) return { ok: false, reason: `invented the number ${number}` };
	}

	const allowedClaims = claimsIn(source);
	for (const claim of claimsIn(text)) {
		if (!allowedClaims.has(claim)) return { ok: false, reason: `invented the claim "${claim}"` };
	}

	return { ok: true };
}

// Models return numbered lists, bulleted lists, quoted strings, and sometimes
// a sentence of preamble. All of that is stripped here rather than being
// prompted away, because prompting it away works until it does not.
export function parseCandidates(raw) {
	return String(raw || "")
		.split("\n")
		.map((line) =>
			line
				.trim()
				.replace(/^[-*•]\s*/, "")
				.replace(/^\d+[.)]\s*/, "")
				.replace(/^["'“”]|["'“”]$/g, "")
				.trim()
		)
		.filter(Boolean);
}

export function buildPrompt({ kind, page, queries = [], min, max }) {
	const searched = queries
		.slice(0, 12)
		.map((entry) => entry.key)
		.filter(Boolean);

	const wanted =
		kind === "title"
			? `a page title between ${min} and ${max} characters`
			: `a meta description between ${min} and ${max} characters`;

	return [
		{
			role: "system",
			content:
				"You write page titles and meta descriptions for a pest control company's website in Canberra, Australia. " +
				"Use Australian spelling. Write plainly, the way a tradesperson would speak, with no marketing superlatives. " +
				"You may only use facts that appear in the page content you are given. Never invent numbers, prices, years " +
				"in business, response times, licences, guarantees or awards. Reply with three options, one per line, and " +
				"nothing else — no numbering, no quotes, no explanation.",
		},
		{
			role: "user",
			content: [
				`Write ${wanted} for this page.`,
				"",
				`Current title: ${page.title || "(none)"}`,
				`Current description: ${page.description || "(none)"}`,
				`Main heading: ${page.h1 || "(none)"}`,
				"",
				"Page content:",
				String(page.body || "").slice(0, 1500),
				...(searched.length
					? ["", "People reached this page by searching for:", searched.join(", "), "", "Work the strongest of those phrases in where it reads naturally."]
					: []),
			].join("\n"),
		},
	];
}

// Returns { candidates, rejected } -- rejected is kept because a run where
// everything was thrown away should say so rather than silently offering
// nothing, which reads as a broken button.
export async function suggest(env, { kind, page, queries = [], min, max, run } = {}) {
	const messages = buildPrompt({ kind, page, queries, min, max });
	const call = run || ((body) => env.AI.run(MODEL, body));
	const result = await call({ messages, max_tokens: 400, temperature: 0.7 });
	const raw = typeof result === "string" ? result : result.response || "";

	// The page's own words are the yardstick, including the title and
	// description it already has -- sharpening an existing claim is fine,
	// inventing a new one is not.
	const source = [page.title, page.description, page.h1, page.body].filter(Boolean).join(" ");
	const current = kind === "title" ? page.title : page.description;

	const candidates = [];
	const rejected = [];
	for (const candidate of parseCandidates(raw)) {
		const verdict = validateSuggestion(candidate, { source, min, max, current });
		if (verdict.ok) candidates.push(candidate);
		else rejected.push({ text: candidate, reason: verdict.reason });
	}

	return { candidates, rejected };
}

// The page's own words, for grounding. Separate from extractPageSummary in
// src/seo-scan.js on purpose: that one runs against all 134 pages during a
// scan and has no business collecting body text it will never use.
export async function extractContent(response) {
	const content = { h1: "", body: "" };
	let inH1 = false;

	const rewriter = new HTMLRewriter()
		.on("h1", {
			element(element) {
				inH1 = !content.h1;
				try {
					element.onEndTag(() => {
						inH1 = false;
					});
				} catch {
					inH1 = false;
				}
			},
			text(chunk) {
				if (inH1) content.h1 += chunk.text;
			},
		})
		.on("p, h2, li", {
			text(chunk) {
				// Capped: a prompt does not get better past a couple of
				// thousand characters, and this runs inside one invocation.
				if (content.body.length < 4000) content.body += chunk.text;
			},
		});

	await rewriter.transform(response).text();
	content.h1 = content.h1.replace(/\s+/g, " ").trim();
	content.body = content.body.replace(/\s+/g, " ").trim();
	return content;
}
