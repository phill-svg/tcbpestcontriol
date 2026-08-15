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

import { validateSuggestion, parseCandidates, buildPrompt, suggest, numbersIn, claimsIn, examplePaths } from "../src/seo-suggest.js";

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
