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

import {
	CLAUDE_MODEL,
	isClaudeModel,
	runClaude,
	isConfigured as claudeConfigured,
	setupMessage as claudeSetupMessage,
} from "./claude-suggest.js";
import { TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX } from "../assets/js/seo-check.js";

// One model writes the copy, and it is Claude.
//
// This started on Llama 3.3, then briefly offered four Workers AI models side
// by side so the choice could be made by reading rather than by guessing --
// copy quality being the one thing here with no test behind it. That
// comparison did its job: the answer came back "Claude", and a shortlist that
// has been decided is just clutter.
//
// So the free models are gone rather than kept as options nobody will pick.
// The cost of that is spelled out below, because it is real: there is no
// longer anything to fall back to.
export const MODEL_CHOICES = [{ id: CLAUDE_MODEL, label: "Claude Opus 5", paid: true }];

// A readable name for whichever model answered.
//
// Still worth having with one model in the list. SEO_AI_MODEL can still point
// at anything, and an answer from something other than Claude has to be
// visibly from something other than Claude.
export function modelLabel(id) {
	const known = MODEL_CHOICES.find((choice) => choice.id === id);
	if (known) return known.label;
	if (isClaudeModel(id)) return "Claude";
	const tail = String(id || "").split("/").pop();
	return tail || "an unknown model";
}

// What the panel needs to say about who answered.
//
// This lives here rather than in the endpoint because src/index.js imports
// cloudflare:workers and cannot be loaded by a Node test -- the same reason
// fetchAsset was moved into src/assets.js. Written inline in the handler, the
// first version of this had a mutation survive: reporting every answer as
// though the asked-for model produced it, which is precisely the failure the
// field exists to prevent, and nothing caught it.
export function describeRun(asked, answered) {
	return {
		model: answered.model,
		label: modelLabel(answered.model),
		asked: asked === answered.model ? null : modelLabel(asked),
		fellBack: answered.fellBack || null,
	};
}

// Which model a plain "Suggest one" click uses. SEO_AI_MODEL stays as the way
// to point this somewhere else without a deploy -- the escape hatch if Claude
// is ever unavailable for longer than it is worth waiting out.
export function preferredModel(env) {
	return env.SEO_AI_MODEL || CLAUDE_MODEL;
}

// Running the model, with nothing behind it.
//
// This used to fall back to Llama on any failure, on the reasoning that a
// working button beats an error box. That reasoning was sound while the free
// models were there anyway; it is not a reason to keep four models nobody
// chose, and silently answering from a model that was deliberately removed
// would be worse than saying what went wrong.
//
// So a failure is now a failure, and it says which kind. A missing key is
// answered with the setup steps, because it is not a fault -- it means Claude
// was never switched on. Anything else comes back as itself.
export async function runModel(env, model, body) {
	if (isClaudeModel(model)) {
		if (!claudeConfigured(env)) throw new NotConfigured(claudeSetupMessage());
		return { model, ...(await runClaude(env, body)) };
	}
	// Only reachable through SEO_AI_MODEL, which is set by hand.
	return { model, result: await env.AI.run(model, body) };
}

// Distinguishable from a runtime failure by type rather than by reading the
// message, so the endpoint can answer with setup instructions instead of a
// 502 that says something went wrong.
export class NotConfigured extends Error {}

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
export function validateSuggestion(candidate, { source, min, max, current, require = [] } = {}) {
	const text = String(candidate || "").trim();
	if (!text) return { ok: false, reason: "empty" };

	// When a suggestion exists to close a specific gap, one that leaves the
	// words out is not a fix, however well it reads. Substring rather than
	// whole-word so the stemmed "ant" matches "ants" and "Ants".
	const haystack = normalise(text);
	for (const word of require) {
		if (!haystack.includes(normalise(word))) return { ok: false, reason: `leaves out “${word}”` };
	}
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

// `examples` are real title/description pairs from elsewhere on the same
// site. They matter more than any instruction in the system prompt.
//
// The first version of this described the house style in words -- "write
// plainly, like a tradesperson" -- and produced exactly the bland copy you
// would expect, because that sentence describes a thousand different websites.
// This site actually writes "Funnel-webs in the back garden. White-tails along
// the skirting." and titles everything "<Thing> <Place> | TCB Pest Control
// Canberra". No description of a voice conveys that; four samples of it do.
//
// They are read from the live site rather than kept in a constant here, so
// the style tracks whatever the site currently does instead of freezing on
// whatever it did the day this was written.
export function buildPrompt({ kind, page, queries = [], examples = [], gaps = [], steer = "", require = [], alsoWanted = [], min, max }) {
	const searched = queries
		.slice(0, 12)
		.map((entry) => entry.key)
		.filter(Boolean);

	const wanted =
		kind === "title"
			? `a page title between ${min} and ${max} characters`
			: kind === "heading"
				? `a main heading — the big line at the top of the page — between ${min} and ${max} characters`
				: `a meta description between ${min} and ${max} characters`;

	const field = kind === "title" ? "title" : kind === "heading" ? "h1" : "description";
	const sample = examples
		.map((example) => example[field])
		.filter(Boolean)
		.slice(0, 4);

	return [
		{
			role: "system",
			content:
				"You write page titles and meta descriptions for a pest control company's website in Canberra, Australia. " +
				"Use Australian spelling. Be concrete: name the pest, the suburb, the standard, the product, the thing that " +
				"is actually done. Prefer a specific detail over an adjective — never write that a service is professional, " +
				"trusted, reliable or expert. " +
				"You may only use facts that appear in the page content you are given. Never invent numbers, prices, years " +
				"in business, response times, licences, guarantees or awards. Reply with six options, one per line, and " +
				"nothing else — no numbering, no quotes, no explanation.",
		},
		{
			role: "user",
			content: [
				`Write ${wanted} for this page.`,
				...(sample.length
					? [
							"",
							`Match the voice of these, which are real ${kind === "title" ? "titles" : kind === "heading" ? "headings" : "descriptions"} from elsewhere on this site:`,
							...sample.map((text) => `- ${text}`),
					  ]
					: []),
				"",
				`Current title: ${page.title || "(none)"}`,
				`Current description: ${page.description || "(none)"}`,
				`Main heading: ${page.h1 || "(none)"}`,
				"",
				"Page content:",
				String(page.body || "").slice(0, 1800),
				...(searched.length
					? ["", "People reached this page by searching for:", searched.join(", "), "", "Work the strongest of those phrases in where it reads naturally."]
					: []),
				// The sharpest instruction available, and the only one backed
				// by evidence rather than judgement: Google is already
				// offering this page for these phrases and the page does not
				// use the words. Rewriting to close that is the one change
				// here with an observed reason behind it.
				...(gaps.length
					? [
							"",
							"Google already shows this page for these searches, but the page never says the words in brackets. Work them in if they fit honestly:",
							...gaps.slice(0, 5).map((gap) => `- ${gap.query} (missing: ${gap.missing.join(", ")}) — shown ${gap.impressions} times, position ${Math.round(gap.position)}`),
					  ]
					: []),
				...(require.length
					? ["", `Every option must contain the words: ${require.join(", ")}. An option without them is no use.`]
					: []),
				// Asked for, not demanded. Requiring every phrase at once
				// rejects everything, because they will not all fit.
				...(alsoWanted.length
					? [`Work in as many of these as still read naturally, but not at the cost of the sentence: ${alsoWanted.join(", ")}.`]
					: []),
				...(steer ? ["", `The person who owns this site asks specifically: ${String(steer).slice(0, 300)}`] : []),
			].join("\n"),
		},
	];
}

// Returns { candidates, rejected } -- rejected is kept because a run where
// everything was thrown away should say so rather than silently offering
// nothing, which reads as a broken button.
export async function suggest(env, { kind, page, queries = [], examples = [], gaps = [], steer = "", require = [], alsoWanted = [], model = CLAUDE_MODEL, min, max, run } = {}) {
	const messages = buildPrompt({ kind, page, queries, examples, gaps, steer, require, alsoWanted, min, max });
	// Six asked for rather than three. Roughly half get thrown out by the
	// checks below -- so asking for what should survive left the button
	// frequently offering one bland option, or none.
	const body = { messages, max_tokens: 700, temperature: 0.8 };
	const answered = run ? { model, result: await run(body) } : await runModel(env, model, body);
	const result = answered.result;
	const raw = typeof result === "string" ? result : result.response || "";

	// The page's own words are the yardstick, including the title and
	// description it already has -- sharpening an existing claim is fine,
	// inventing a new one is not.
	const source = [page.title, page.description, page.h1, page.body].filter(Boolean).join(" ");
	const current = kind === "title" ? page.title : page.description;

	const candidates = [];
	const rejected = [];
	const seen = new Set();
	for (const candidate of parseCandidates(raw)) {
		// Models given a temperature and asked for six will hand back the same
		// line twice. Three options where two are identical looks broken.
		const fingerprint = normalise(candidate).replace(/[^a-z0-9 ]/g, "");
		if (seen.has(fingerprint)) continue;
		seen.add(fingerprint);

		const verdict = validateSuggestion(candidate, { source, min, max, current, require });
		if (verdict.ok) candidates.push(candidate);
		else rejected.push({ text: candidate, reason: verdict.reason });
	}

	return {
		candidates: candidates.slice(0, 4),
		rejected,
		model: answered.model,
		fellBack: answered.fellBack,
		// Only the paid provider reports these. Shown per click rather than
		// totalled at the end of the month, which is the only point at which
		// the number is any use in deciding whether to click again.
		cost: answered.cost,
		servedBy: answered.servedBy,
	};
}

// Just the title and description, for gathering house-style examples. A far
// cheaper read than extractPageSummary, which also collects every image and
// link -- none of which a writing sample needs, and this runs against several
// pages per suggestion.
export async function extractMeta(response) {
	const meta = { title: "", description: "", h1: "" };
	let inTitle = false;
	let inH1 = false;

	const rewriter = new HTMLRewriter()
		.on("title", {
			element(element) {
				inTitle = !meta.title;
				try {
					element.onEndTag(() => {
						inTitle = false;
					});
				} catch {
					inTitle = false;
				}
			},
			text(chunk) {
				if (inTitle) meta.title += chunk.text;
			},
		})
		.on('meta[name="description"]', {
			element(element) {
				if (!meta.description) meta.description = element.getAttribute("content") || "";
			},
		})
		.on("h1", {
			element(element) {
				inH1 = !meta.h1;
				try {
					element.onEndTag(() => {
						inH1 = false;
					});
				} catch {
					inH1 = false;
				}
			},
			text(chunk) {
				if (inH1) meta.h1 += chunk.text;
			},
		});

	await rewriter.transform(response).text();
	meta.title = meta.title.trim();
	meta.h1 = meta.h1.replace(/\s+/g, " ").trim();
	return meta;
}

// A main heading is not length-limited the way a title is -- nothing truncates
// it -- but this site's are short and declarative ("Pest control in Kambah.",
// "Termites. Inspection, treatment, warranty."), and a heading that runs to
// three lines stops being a heading.
export const HEADING_MIN = 12;
export const HEADING_MAX = 70;

// Closing the page's gaps, trying each place the words could go in turn.
//
// One rewrite covering all of them, not one per search. A page has a single
// title, and offering a separate fix per gap produced two buttons proposing
// two different titles for the same box -- where accepting the second
// silently undid the first.
//
// Only the biggest gap's words are compulsory. Requiring every phrase at once
// would reject everything: "pigeon control canberra" and "bird proofing
// canberra" will not both fit inside 62 characters alongside the business
// name. The rest are asked for and then counted, so a candidate covering two
// searches can be offered above one covering a single search.
//
// The order of places is the order a person would try: the title carries the
// most weight and is what shows in the result, the description next, and the
// main heading last -- which is also the one with room left when a phrase
// simply will not fit in a title. Each is attempted only if the one before
// produced nothing that both uses the words and survives the invention checks.
export async function fixGaps(env, { gaps = [], page, examples = [], queries = [], limits, model = CLAUDE_MODEL, run } = {}) {
	const attempts = [];
	if (!gaps.length) return { kind: null, candidates: [], attempts };

	const [biggest, ...rest] = gaps;
	const alsoWanted = [...new Set(rest.flatMap((gap) => gap.missing))].filter((word) => !biggest.missing.includes(word));

	for (const kind of ["title", "description", "heading"]) {
		const { min, max } = limits[kind];
		const { candidates, rejected } = await suggest(env, {
			kind,
			page,
			examples,
			queries,
			require: biggest.missing,
			alsoWanted,
			model,
			min,
			max,
			run,
		});

		if (candidates.length) {
			// Best coverage first: the whole reason for doing this in one pass
			// is that one line can answer more than one search.
			const scored = candidates
				.map((text) => ({ text, covers: gaps.filter((gap) => coversGap(text, gap)).map((gap) => gap.query) }))
				.sort((a, b) => b.covers.length - a.covers.length);
			return { kind, candidates: scored, rejected, attempts };
		}
		// Kept so the panel can say why the obvious place did not work --
		// "it will not fit in the title" is a useful thing to be told.
		attempts.push({ kind, rejected });
	}

	return { kind: null, candidates: [], attempts };
}

// Drafting a whole page for a search nothing on the site answers.
//
// The other half of what fixForGap has always said in prose: "either work the
// words into this page, or -- since N people a month search it and nothing
// here covers it -- give it a page of its own." Only the first half had a
// button, so the recommendation with the most behind it was the one you had
// to act on by hand.
//
// The invention rule is stricter here than anywhere else, and has to be. Every
// other suggestion is a rewrite of a page that already exists, so the page's
// own words are the yardstick for what may be claimed. A new page has no
// words yet, which would leave nothing to check against -- so nothing is
// allowed: no numbers, no licences, no guarantees, no response times. What
// comes back is a shape and a voice with the facts left out, and the facts are
// added by the person who knows them.
export async function draftPage(env, { query, examples = [], model = CLAUDE_MODEL, run } = {}) {
	const sample = examples
		.map((example) => [example.title, example.description].filter(Boolean).join(" — "))
		.filter(Boolean)
		.slice(0, 4);

	const messages = [
		{
			role: "system",
			content:
				"You write pages for a pest control company's website in Canberra, Australia. Use Australian spelling. " +
				"Be concrete: name the pest, the suburb, the season, the thing that is actually done. Never write that a " +
				"service is professional, trusted, reliable or expert. " +
				"You may not state any fact about the business: no numbers, no prices, no years in business, no response " +
				"times, no licences, no guarantees, no awards. Write about the pest and the problem, not about the company. " +
				"Reply as JSON only: {\"title\":\"\",\"description\":\"\",\"intro\":\"\",\"sections\":[{\"heading\":\"\",\"paragraph\":\"\"}]}. " +
				"Three sections.",
		},
		{
			role: "user",
			content: [
				`People search for “${query}” and this site has no page about it. Draft one.`,
				"",
				`The title must contain the words from “${query}” and be between ${TITLE_MIN} and ${TITLE_MAX} characters.`,
				`The description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters.`,
				...(sample.length ? ["", "Match the voice of these, which are real pages from elsewhere on this site:", ...sample.map((text) => `- ${text}`)] : []),
			].join("\n"),
		},
	];

	const answered = run ? { model, result: await run({ messages, max_tokens: 2000 }) } : await runModel(env, model, { messages, max_tokens: 2000 });
	const raw = typeof answered.result === "string" ? answered.result : answered.result.response || "";

	let draft;
	try {
		// Models wrap JSON in prose and fences however firmly they are asked
		// not to. Taking the outermost braces is more reliable than insisting.
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		draft = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error("The draft came back in a shape this could not read. Worth trying again.");
	}

	// Nothing to check against but the query itself, which is the point.
	const clean = (text, { min, max } = {}) => {
		const verdict = validateSuggestion(text, { source: query, min, max });
		return verdict.ok ? String(text).trim() : null;
	};

	const sections = (Array.isArray(draft.sections) ? draft.sections : [])
		.map((section) => ({
			heading: String(section?.heading || "").trim(),
			paragraph: String(section?.paragraph || "").trim(),
		}))
		.filter((section) => section.heading && section.paragraph && !claimsIn(section.paragraph).size && !numbersIn(section.paragraph).size);

	return {
		query,
		title: clean(draft.title, { min: TITLE_MIN, max: TITLE_MAX }),
		description: clean(draft.description, { min: DESCRIPTION_MIN, max: DESCRIPTION_MAX }),
		// The intro runs longer than a description and is not length-checked,
		// but it is held to the same no-facts rule.
		intro: !claimsIn(draft.intro || "").size && !numbersIn(draft.intro || "").size ? String(draft.intro || "").trim() : "",
		sections,
		model: answered.model,
		cost: answered.cost,
	};
}

// Drafting a service page -- the commercial kind, not a blog post.
//
// A richer shape than draftPage: a hero lead, a heading split into a plain
// half and an accented half, three sections of prose, five questions with
// answers, and a closing paragraph. All of it goes through the same rule, and
// the rule is the strict one -- a page that does not exist yet has no words to
// check a claim against, so no claim is allowed. What comes back is structure
// and voice; the licences, the guarantees and the response times are added by
// whoever can stand behind them.
//
// Everything is length-checked against the same limits the panel enforces,
// because a generated page that the site's own SEO check would immediately
// flag is not finished work.
export async function draftServicePage(env, { query, serviceName, examples = [], model = CLAUDE_MODEL, run } = {}) {
	const sample = examples
		.map((example) => [example.title, example.description].filter(Boolean).join(" — "))
		.filter(Boolean)
		.slice(0, 4);

	const messages = [
		{
			role: "system",
			content:
				"You write service pages for a pest control company's website in Canberra, Australia. Use Australian " +
				"spelling. Be concrete: name the species, the timber, the room, the season, the sign someone would " +
				"actually notice. Never write that a service is professional, trusted, reliable or expert. " +
				"You may not state any fact about the business: no numbers, no prices, no years in business, no response " +
				"times, no licences, no guarantees, no warranties, no awards. Write about the pest and the problem. " +
				"Reply as JSON only, in this shape: " +
				'{"title":"","description":"","headingLead":"","headingAccent":"","heroLead":"","bannerText":"",' +
				'"sections":[{"eyebrow":"","heading":"","paragraphs":["",""]}],"faqs":[{"question":"","answer":""}]}',
		},
		{
			role: "user",
			content: [
				`People search for “${query}” and this site has no page about it. Write the service page.`,
				"",
				`The title must contain the words from “${query}” and be between ${TITLE_MIN} and ${TITLE_MAX} characters.`,
				`The description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters.`,
				`Three sections, each with a short eyebrow label of one or two words and two paragraphs. Five questions.`,
				`headingLead and headingAccent are the two halves of the main heading: "${serviceName || "Borer control"}," and a short phrase that finishes it.`,
				...(sample.length ? ["", "Match the voice of these, which are real pages from elsewhere on this site:", ...sample.map((text) => `- ${text}`)] : []),
			].join("\n"),
		},
	];

	const answered = run
		? { model, result: await run({ messages, max_tokens: 4000 }) }
		: await runModel(env, model, { messages, max_tokens: 4000 });
	const raw = typeof answered.result === "string" ? answered.result : answered.result.response || "";

	let draft;
	try {
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		draft = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error("The draft came back in a shape this could not read. Worth trying again.");
	}

	// Nothing to check a claim against but the query itself, which is the point.
	const clean = (text, { min, max } = {}) => {
		const verdict = validateSuggestion(text, { source: query, min, max });
		return verdict.ok ? String(text).trim() : null;
	};
	const plain = (text) => {
		const value = String(text || "").trim();
		if (!value) return "";
		return claimsIn(value).size || numbersIn(value).size ? "" : value;
	};

	const sections = (Array.isArray(draft.sections) ? draft.sections : [])
		.map((section) => ({
			eyebrow: plain(section?.eyebrow).slice(0, 24),
			heading: plain(section?.heading),
			paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : []).map(plain).filter(Boolean),
		}))
		.filter((section) => section.heading && section.paragraphs.length);

	const faqs = (Array.isArray(draft.faqs) ? draft.faqs : [])
		.map((faq) => ({ question: plain(faq?.question), answer: plain(faq?.answer) }))
		.filter((faq) => faq.question && faq.answer);

	return {
		query,
		title: clean(draft.title, { min: TITLE_MIN, max: TITLE_MAX }),
		description: clean(draft.description, { min: DESCRIPTION_MIN, max: DESCRIPTION_MAX }),
		headingLead: plain(draft.headingLead),
		headingAccent: plain(draft.headingAccent),
		heroLead: plain(draft.heroLead),
		bannerText: plain(draft.bannerText),
		sections,
		faqs,
		model: answered.model,
		cost: answered.cost,
	};
}

export function coversGap(text, gap) {
	const haystack = normalise(text);
	return (gap.missing || []).every((word) => haystack.includes(normalise(word)));
}

// Which pages to take writing samples from. Pages sharing a prefix are the
// closest thing this site has to a section -- all the locations- pages read
// alike, and a location page written in the voice of a service page reads
// wrong. Falls back to a spread across the site when there is no sibling.
export function examplePaths(paths, path, wanted = 4) {
	const prefix = String(path || "").split("-")[0];
	const others = paths.filter((candidate) => candidate !== path && candidate !== "/");
	const siblings = others.filter((candidate) => candidate.split("-")[0] === prefix);
	const pool = siblings.length >= wanted ? siblings : [...siblings, ...others.filter((c) => !siblings.includes(c))];
	// Evenly spaced rather than the first few, which on this site would be
	// four consecutive suburbs beginning with A.
	const step = Math.max(1, Math.floor(pool.length / wanted));
	const picked = [];
	for (let at = 0; at < pool.length && picked.length < wanted; at += step) picked.push(pool[at]);
	return picked;
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
