// Drafting a better title, and refusing to draft a dangerous one.
//
// The interesting tests here are all rejections. A suggestion that is merely
// bad costs a click to dismiss. A suggestion that invents "licensed and
// insured", "24/7 callout" or "20 years' experience" is a claim about a real
// business, on a real website, in a regulated trade -- and it arrives looking
// exactly as plausible as the good ones, in front of somebody skim-reading
// three options. That is the failure this module exists to prevent, so it is
// the failure most of these tests are about.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSuggestion, parseCandidates, buildPrompt, suggest, numbersIn, claimsIn, examplePaths, draftPage, draftServicePage } from "../src/seo-suggest.js";

const PAGE = {
	title: "Termite Treatment Canberra | TCB Pest Control",
	description: "Termite inspections and treatment across Canberra, with a written report after every visit.",
	h1: "Termite treatment in Canberra",
	body:
		"We inspect the whole property, identify the species, and treat with a chemical barrier or bait system. " +
		"Every job finishes with a written report. We cover Canberra and Queanbeyan.",
};

const SOURCE = [PAGE.title, PAGE.description, PAGE.h1, PAGE.body].join(" ");
const LIMITS = { source: SOURCE, min: 30, max: 62 };

test("a plain rewrite from the page's own words is accepted", () => {
	const verdict = validateSuggestion("Termite Inspections & Treatment Canberra | TCB Pest Control", LIMITS);
	assert.deepEqual(verdict, { ok: true });
});

test("an invented number is refused", () => {
	// "24/7", a price, a response time, a year founded -- all arrive this way,
	// and all of them are claims the model has no way of knowing.
	assert.match(validateSuggestion("24/7 Termite Treatment Canberra | TCB Pest", LIMITS).reason, /invented the number/);
	assert.match(validateSuggestion("Termite Treatment From $99 | TCB Pest Control", LIMITS).reason, /invented the number 99/);
	assert.match(validateSuggestion("Termite Control Canberra Since 1998 | TCB Pest", LIMITS).reason, /invented the number/);
});

test("a number the page already uses is allowed through", () => {
	const page = { ...PAGE, body: `${PAGE.body} Servicing Canberra since 2011.` };
	const source = [page.title, page.description, page.h1, page.body].join(" ");
	assert.deepEqual(validateSuggestion("Termite Treatment Canberra Since 2011 | TCB", { ...LIMITS, source }), { ok: true });
});

test("an invented claim is refused", () => {
	// The expensive ones. A licence claim on a pest control site is a
	// regulatory statement, not a turn of phrase.
	assert.match(validateSuggestion("Licensed Termite Treatment Canberra | TCB Pest", LIMITS).reason, /invented the claim "licensed"/);
	assert.match(validateSuggestion("Guaranteed Termite Removal Canberra | TCB", LIMITS).reason, /invented the claim/);
	assert.match(validateSuggestion("Canberra's Best Termite Treatment | TCB Pest", LIMITS).reason, /invented the claim "best"/);
	assert.match(validateSuggestion("Free Termite Inspection Canberra | TCB Pest", LIMITS).reason, /invented the claim "free"/);
	assert.match(validateSuggestion("Emergency Termite Treatment Canberra | TCB", LIMITS).reason, /invented the claim "emergency"/);
});

test("a claim the page already makes may be repeated", () => {
	// The rule is "no new claims", not "no claims". If the page says the
	// quote is free, a title may say so too.
	const page = { ...PAGE, body: `${PAGE.body} Free quote before any work starts.` };
	const source = [page.title, page.description, page.h1, page.body].join(" ");
	assert.deepEqual(validateSuggestion("Termite Treatment Canberra, Free Quote | TCB", { ...LIMITS, source }), { ok: true });
});

test("length is enforced rather than requested", () => {
	// The prompt asks for a length. Models treat that as a suggestion.
	assert.match(validateSuggestion("Termites", LIMITS).reason, /too short/);
	assert.match(validateSuggestion("Termite Treatment and Inspection Services Across the Canberra Region and Queanbeyan", LIMITS).reason, /too long/);
});

test("the current wording is not offered back", () => {
	assert.match(validateSuggestion(PAGE.title, { ...LIMITS, current: PAGE.title }).reason, /unchanged/);
	assert.match(validateSuggestion(`  ${PAGE.title.toUpperCase()}  `, { ...LIMITS, current: PAGE.title }).reason, /unchanged/);
});

test("a model answering conversationally is not treated as a title", () => {
	assert.match(validateSuggestion("Here are three options for your page title", LIMITS).reason, /not a title/);
	assert.match(validateSuggestion("Sure! Termite Treatment Canberra | TCB Pest", LIMITS).reason, /not a title/);
});

test("lists come back as plain lines whatever shape the model used", () => {
	assert.deepEqual(
		parseCandidates('1. Termite Treatment Canberra\n- Termite Inspections Canberra\n"Termite Control Canberra"\n\n  • Termite Barriers Canberra  '),
		["Termite Treatment Canberra", "Termite Inspections Canberra", "Termite Control Canberra", "Termite Barriers Canberra"]
	);
});

test("real searches are given to the model when there are any", () => {
	const withQueries = buildPrompt({
		kind: "title",
		page: PAGE,
		queries: [{ key: "termite inspection canberra" }, { key: "white ants canberra" }],
		min: 30,
		max: 62,
	});
	assert.match(withQueries[1].content, /termite inspection canberra, white ants canberra/);

	// And the section is absent rather than empty when Search Console is not
	// connected, so the model is not handed a heading with nothing under it.
	const without = buildPrompt({ kind: "title", page: PAGE, queries: [], min: 30, max: 62 });
	assert.doesNotMatch(without[1].content, /reached this page by searching/);
});

test("the model is told not to invent, as well as being checked", () => {
	// Belt and braces on purpose: the check below is what actually stops it,
	// but a prompt that invites invention wastes every generation.
	const [system] = buildPrompt({ kind: "title", page: PAGE, min: 30, max: 62 });
	assert.match(system.content, /Never invent/);
	assert.match(system.content, /Australian spelling/);
});

test("a whole run of inventions leaves nothing, and says so", async () => {
	// The button has to be able to come back empty-handed. Silently showing
	// no options reads as broken; the caller needs to know they were refused.
	const { candidates, rejected } = await suggest(null, {
		kind: "title",
		page: PAGE,
		min: 30,
		max: 62,
		run: async () => ({
			response: [
				"Licensed Termite Treatment Canberra | TCB Pest",
				"24/7 Termite Response Canberra | TCB Pest Control",
				"Canberra's Best Termite Treatment | TCB Pest Co",
			].join("\n"),
		}),
	});
	assert.deepEqual(candidates, []);
	assert.equal(rejected.length, 3);
	assert.match(rejected[0].reason, /invented/);
});

test("the good ones survive a mixed run", async () => {
	const { candidates, rejected } = await suggest(null, {
		kind: "title",
		page: PAGE,
		min: 30,
		max: 62,
		run: async () => ({
			response: [
				"Termite Inspections & Treatment Canberra | TCB Pest",
				"Guaranteed Termite Removal Canberra | TCB Pest",
				"Termite Barriers & Baits Canberra | TCB Pest Control",
			].join("\n"),
		}),
	});
	assert.deepEqual(candidates, [
		"Termite Inspections & Treatment Canberra | TCB Pest",
		"Termite Barriers & Baits Canberra | TCB Pest Control",
	]);
	assert.equal(rejected.length, 1);
});

test("the word lists behave on ordinary prose", () => {
	assert.deepEqual([...numbersIn("no digits here")], []);
	assert.deepEqual([...numbersIn("call 6255 1234 or 0400 000 000")], ["6255", "1234", "0400", "000"]);
	assert.ok(claimsIn("We are fully licensed and insured").has("licensed"));
	assert.ok(claimsIn("Termite inspections across Canberra").size === 0);
});

test("writing samples from the site are put in front of the model", () => {
	// The first version described the house style in words and produced copy
	// that could have belonged to any pest controller anywhere. This site
	// writes "Funnel-webs in the back garden. White-tails along the skirting."
	// No adjective conveys that; four samples of it do.
	const examples = [
		{ title: "Spider Control Canberra | TCB Pest Control Canberra", description: "Funnel-webs in the back garden. White-tails along the skirting." },
		{ title: "Rodent Control Canberra | TCB Pest Control Canberra", description: "Rat and mouse control for Canberra roofs, subfloors and wall cavities." },
	];

	const titlePrompt = buildPrompt({ kind: "title", page: PAGE, examples, min: 30, max: 62 })[1].content;
	assert.match(titlePrompt, /real titles from elsewhere on this site/);
	assert.match(titlePrompt, /- Spider Control Canberra \| TCB Pest Control Canberra/);
	assert.doesNotMatch(titlePrompt, /Funnel-webs/, "a title request is not shown descriptions");

	const descriptionPrompt = buildPrompt({ kind: "description", page: PAGE, examples, min: 70, max: 165 })[1].content;
	assert.match(descriptionPrompt, /Funnel-webs in the back garden/);
	assert.doesNotMatch(descriptionPrompt, /- Spider Control Canberra \|/, "and vice versa");
});

test("a steer from the owner reaches the model", () => {
	const prompt = buildPrompt({ kind: "title", page: PAGE, steer: "lead with white ants", min: 30, max: 62 })[1].content;
	assert.match(prompt, /asks specifically: lead with white ants/);
	// And an empty one adds nothing rather than an empty instruction.
	assert.doesNotMatch(buildPrompt({ kind: "title", page: PAGE, steer: "", min: 30, max: 62 })[1].content, /asks specifically/);
});

test("the same line twice is offered once", async () => {
	// Six asked for at temperature will repeat itself, and two identical
	// options out of three looks broken.
	const { candidates } = await suggest(null, {
		kind: "title",
		page: PAGE,
		min: 30,
		max: 62,
		run: async () => ({
			response: [
				"Termite Inspections & Treatment Canberra | TCB Pest",
				"Termite Inspections & Treatment Canberra | TCB Pest",
				"termite inspections & treatment canberra | tcb pest",
				"Termite Barriers & Baits Canberra | TCB Pest Control",
			].join("\n"),
		}),
	});
	assert.deepEqual(candidates, [
		"Termite Inspections & Treatment Canberra | TCB Pest",
		"Termite Barriers & Baits Canberra | TCB Pest Control",
	]);
});

test("style samples come from sibling pages where there are any", () => {
	// A location page written in the voice of a service page reads wrong, and
	// this site's sections are only distinguishable by path prefix.
	const paths = [
		"/",
		"/spider-control",
		"/termite-treatment",
		"/locations-pest-control-kambah",
		"/locations-pest-control-woden",
		"/locations-pest-control-belconnen",
		"/locations-pest-control-dickson",
		"/locations-pest-control-curtin",
	];
	const picked = examplePaths(paths, "/locations-pest-control-kambah");
	assert.ok(picked.length > 0);
	assert.ok(picked.every((p) => p.startsWith("/locations-")), "siblings preferred");
	assert.ok(!picked.includes("/locations-pest-control-kambah"), "not the page being rewritten");
	assert.ok(!picked.includes("/"), "the homepage is not a style sample for anything");

	// With no siblings it still finds something rather than sending none.
	const alone = examplePaths(paths, "/termite-treatment");
	assert.ok(alone.length > 0);
	assert.ok(!alone.includes("/termite-treatment"));
});

test("measured gaps reach the model, with the numbers that justify them", () => {
	// The one instruction in this prompt backed by evidence rather than
	// judgement. It has to arrive with its impressions and position attached,
	// because "mention white ants" and "Google showed this page 2,340 times
	// for white ants and it sits at 12" are different instructions.
	const prompt = buildPrompt({
		kind: "title",
		page: PAGE,
		gaps: [{ query: "white ants canberra", missing: ["white", "ant"], impressions: 2340, position: 12.4 }],
		min: 30,
		max: 62,
	})[1].content;

	assert.match(prompt, /already shows this page for these searches/);
	assert.match(prompt, /white ants canberra \(missing: white, ant\) — shown 2340 times, position 12/);
	// And "if they fit honestly" stays attached: a gap is a reason to
	// consider a phrase, not a licence to claim the page is about it.
	assert.match(prompt, /if they fit honestly/);

	assert.doesNotMatch(buildPrompt({ kind: "title", page: PAGE, gaps: [], min: 30, max: 62 })[1].content, /never says the words/);
});

// --- fixing one measured gap -------------------------------------------------

test("a suggestion that leaves the words out is not a fix", () => {
	// The whole point of this path is the phrase Google already shows the page
	// for. A candidate without it reads fine and fixes nothing.
	assert.match(
		validateSuggestion("Termite Treatment Canberra | TCB Pest Control", { ...LIMITS, require: ["borer"] }).reason,
		/leaves out “borer”/
	);
	assert.deepEqual(validateSuggestion("Termite & Borer Treatment Canberra | TCB", { ...LIMITS, require: ["borer"] }), { ok: true });
});

test("a required word matches its plural on the page", () => {
	// The gap reports the stem, and the wording will normally use the plural.
	assert.deepEqual(validateSuggestion("White Ants & Termites Canberra | TCB Pest", { ...LIMITS, require: ["ant"] }), { ok: true });
});

test("the title is tried first, and the heading only when nothing else fits", async () => {
	const { fixGaps, HEADING_MIN, HEADING_MAX } = await import("../src/seo-suggest.js");
	const asked = [];
	const result = await fixGaps(null, {
		gaps: [{ query: "borer control canberra", missing: ["borer"], impressions: 46 }],
		page: PAGE,
		limits: {
			title: { min: 30, max: 62 },
			description: { min: 70, max: 165 },
			heading: { min: HEADING_MIN, max: HEADING_MAX },
		},
		run: async (body) => {
			// Which field is being asked for, in order.
			const kind = /main heading/.test(body.messages[1].content)
				? "heading"
				: /page title/.test(body.messages[1].content)
					? "title"
					: "description";
			asked.push(kind);
			// The title cannot hold "borer" alongside everything it already
			// carries, and the description that does fit invents a guarantee.
			// Only the heading has room and stays honest.
			if (kind === "title") return { response: "Termite and Borer Treatment and Inspection Services Across the Whole Canberra Region" };
			if (kind === "description")
				return { response: "Guaranteed borer and termite treatment across Canberra, with a written report after every single visit." };
			// No "warranty" here — the page never claims one, and the
			// invention check would rightly throw it out.
			return { response: "Termites and borers. Inspection, treatment, written report." };
		},
	});

	assert.deepEqual(asked, ["title", "description", "heading"], "in order of weight");
	assert.equal(result.kind, "heading");
	assert.deepEqual(result.candidates.map((c) => c.text), ["Termites and borers. Inspection, treatment, written report."]);
	// And it can say why the obvious places were skipped.
	assert.deepEqual(result.attempts.map((attempt) => attempt.kind), ["title", "description"]);
});

test("a title that works stops the search there", async () => {
	const { fixGaps, HEADING_MIN, HEADING_MAX } = await import("../src/seo-suggest.js");
	let calls = 0;
	const result = await fixGaps(null, {
		gaps: [{ query: "borer control canberra", missing: ["borer"], impressions: 46 }],
		page: PAGE,
		limits: {
			title: { min: 30, max: 62 },
			description: { min: 70, max: 165 },
			heading: { min: HEADING_MIN, max: HEADING_MAX },
		},
		run: async () => {
			calls++;
			return { response: "Termite & Borer Treatment Canberra | TCB Pest" };
		},
	});
	assert.equal(calls, 1, "no point drafting a heading when the title took it");
	assert.equal(result.kind, "title");
	assert.deepEqual(result.attempts, []);
});

test("the model is told the words are compulsory, as well as being checked", () => {
	const prompt = buildPrompt({ kind: "title", page: PAGE, require: ["borer"], min: 30, max: 62 })[1].content;
	assert.match(prompt, /Every option must contain the words: borer/);
});

test("heading samples come from other pages' headings, not their titles", () => {
	const examples = [{ title: "Spider Control Canberra | TCB", description: "Funnel-webs…", h1: "Spiders. Identified, treated, kept out." }];
	const prompt = buildPrompt({ kind: "heading", page: PAGE, examples, min: 12, max: 70 })[1].content;
	assert.match(prompt, /real headings from elsewhere on this site/);
	assert.match(prompt, /Spiders\. Identified, treated, kept out\./);
	assert.doesNotMatch(prompt, /Spider Control Canberra \| TCB/);
});

test("one rewrite covers the page's gaps rather than one per search", async () => {
	// The complaint that produced this: two Fix buttons on the same page, both
	// proposing a new title, where accepting the second silently undid the
	// first. A page has one title.
	const { fixGaps, HEADING_MIN, HEADING_MAX } = await import("../src/seo-suggest.js");
	const gaps = [
		{ query: "pigeon control canberra", missing: ["pigeon"], impressions: 68 },
		{ query: "bird proofing canberra", missing: ["bird", "proofing"], impressions: 34 },
	];
	let prompt = "";
	const result = await fixGaps(null, {
		gaps,
		page: { title: "Bird Control Canberra | TCB", description: "Netting and spikes.", h1: "Bird control." },
		limits: {
			title: { min: 30, max: 62 },
			description: { min: 70, max: 165 },
			heading: { min: HEADING_MIN, max: HEADING_MAX },
		},
		run: async (body) => {
			prompt = body.messages[1].content;
			return {
				response: [
					"Pigeon Control Canberra | TCB Pest Control",
					"Pigeon Control & Bird Proofing Canberra | TCB",
				].join("\n"),
			};
		},
	});

	// Only the biggest gap's words are compulsory -- demanding every phrase at
	// once would reject everything, because they do not all fit.
	assert.match(prompt, /must contain the words: pigeon/);
	assert.match(prompt, /as many of these as still read naturally.*bird, proofing/);

	// And the one answering both searches is offered first.
	assert.deepEqual(result.candidates[0], {
		text: "Pigeon Control & Bird Proofing Canberra | TCB",
		covers: ["pigeon control canberra", "bird proofing canberra"],
	});
	assert.deepEqual(result.candidates[1].covers, ["pigeon control canberra"]);
});

test("a page with nothing to fix asks for nothing", async () => {
	const { fixGaps } = await import("../src/seo-suggest.js");
	let called = false;
	const result = await fixGaps(null, { gaps: [], page: PAGE, limits: {}, run: async () => ((called = true), {}) });
	assert.equal(result.kind, null);
	assert.equal(called, false, "no gaps, no generation, no cost");
});

// Drafting a whole page for a search nothing on the site answers.
//
// The invention rule is stricter here than anywhere else, and has to be.
// Every other suggestion rewrites a page that already exists, so that page's
// own words are the yardstick for what may be claimed. A new page has no
// words yet -- so nothing is allowed through, and the facts are added by the
// person who knows them.

const reply = (payload) => async () => ({ response: JSON.stringify(payload) });

test("a drafted page may not claim anything about the business", async () => {
	const draft = await draftPage(null, {
		query: "borer control canberra",
		run: reply({
			title: "Borer Control Canberra | TCB Pest Control",
			description:
				"Licensed borer treatment across Canberra, guaranteed for 12 months, with same-day callout available.",
			intro: "We have treated borer in Canberra homes for over 20 years.",
			sections: [
				{ heading: "Where borer turns up", paragraph: "Borer favours untreated pine in subfloors and roof timbers." },
				{ heading: "Our guarantee", paragraph: "Every borer treatment is guaranteed for 12 months." },
			],
		}),
	});

	// The description claims a licence, a guarantee, a number and same-day
	// service. None of it is checkable, so none of it survives.
	assert.equal(draft.description, null);
	assert.equal(draft.intro, "", "twenty years in business is not something a model can know");
	assert.deepEqual(
		draft.sections.map((section) => section.heading),
		["Where borer turns up"],
		"the section about the pest stays; the one making a promise does not"
	);
});

test("a clean draft comes back whole", async () => {
	const draft = await draftPage(null, {
		query: "borer control canberra",
		run: reply({
			title: "Borer Control Canberra | TCB Pest Control",
			description:
				"Borer in Canberra homes: how to spot the frass, which timbers they favour, and what treatment involves.",
			intro: "Borer beetles lay in untreated timber and the grubs do the damage on their way out.",
			sections: [{ heading: "Spotting borer", paragraph: "Fine powder below skirting boards and small round exit holes." }],
		}),
	});
	assert.match(draft.title, /Borer Control Canberra/);
	assert.ok(draft.description);
	assert.ok(draft.intro);
	assert.equal(draft.sections.length, 1);
});

test("a draft that is not JSON is refused rather than half-read", async () => {
	await assert.rejects(
		() => draftPage(null, { query: "borer control canberra", run: async () => ({ response: "Sure! Here is a page." }) }),
		/could not read/
	);
});

test("the title still has to be a usable length", async () => {
	const draft = await draftPage(null, {
		query: "borer control canberra",
		run: reply({ title: "Borer", description: "x".repeat(120), intro: "", sections: [] }),
	});
	assert.equal(draft.title, null, "five characters is not a title");
});

// The service-page draft: the same rule, over a much bigger surface.
//
// draftPage produces a title, a description and a few sections. This produces
// a whole commercial page -- hero, three sections of prose, five questions --
// and every one of those is somewhere a licence or a guarantee could be
// asserted. The rule has to hold across all of it, not just the title.

test("a drafted service page drops every claim, wherever it appears", async () => {
	const draft = await draftServicePage(null, {
		query: "borer control canberra",
		serviceName: "Borer Control",
		run: reply({
			title: "Borer Control Canberra | TCB Pest Control",
			description: "Borer in Canberra floorboards and roof timbers — how to spot the frass and what treatment involves.",
			headingLead: "Borer control,",
			headingAccent: "guaranteed for 12 months",
			heroLead: "Fine powder under the skirting board.",
			bannerText: "Our licensed technicians treat borer across Canberra.",
			sections: [
				{ eyebrow: "Species", heading: "The borers in Canberra timber.", paragraphs: ["Lyctus favours hardwood sapwood.", "We have treated borer for over 20 years."] },
				{ eyebrow: "Promise", heading: "Our guarantee.", paragraphs: ["Every treatment is guaranteed."] },
			],
			faqs: [
				{ question: "How do I know if borer is active?", answer: "Fresh frass is the clearest sign." },
				{ question: "Is it insured?", answer: "Every job is fully insured." },
			],
		}),
	});

	assert.equal(draft.headingAccent, "", "a guarantee is not a heading");
	assert.equal(draft.bannerText, "", "nor is a licence");
	// The section about the pest survives; the one promising something does not,
	// and inside the surviving section the twenty-years paragraph is gone.
	assert.deepEqual(draft.sections.map((section) => section.heading), ["The borers in Canberra timber."]);
	assert.deepEqual(draft.sections[0].paragraphs, ["Lyctus favours hardwood sapwood."]);
	assert.deepEqual(draft.faqs.map((faq) => faq.question), ["How do I know if borer is active?"]);
	// What is left is usable.
	assert.ok(draft.title && draft.description && draft.heroLead);
});

test("a clean service-page draft keeps its shape", async () => {
	const draft = await draftServicePage(null, {
		query: "borer control canberra",
		serviceName: "Borer Control",
		run: reply({
			title: "Borer Control Canberra | TCB Pest Control",
			description: "Borer in Canberra floorboards and roof timbers — how to spot the frass and what treatment involves.",
			headingLead: "Borer control,",
			headingAccent: "treated at the timber",
			heroLead: "Fine powder under the skirting board, and small round holes that were not there last summer.",
			bannerText: "Borer works from the inside out.",
			sections: [
				{ eyebrow: "Species", heading: "The borers in Canberra timber.", paragraphs: ["Lyctus favours hardwood sapwood.", "Anobium prefers older softwood."] },
			],
			faqs: [{ question: "How do I know if borer is active?", answer: "Fresh frass is the clearest sign." }],
		}),
	});
	assert.equal(draft.headingAccent, "treated at the timber");
	assert.equal(draft.sections.length, 1);
	assert.equal(draft.sections[0].paragraphs.length, 2);
	assert.equal(draft.faqs.length, 1);
});
