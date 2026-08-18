// Building a service page from the template.
//
// These pages are the commercial ones -- the pest pages someone lands on when
// they are ready to book -- and they carry a ProfessionalService block, a
// Service block, a BreadcrumbList, an FAQPage, opening hours, a geo circle and
// a postal address. A generated page that gets any of that subtly wrong looks
// fine to a reader and wrong to Google, which is the worst combination
// available, so the tests below check the whole rendered page rather than the
// pieces that went into it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderServicePage, findUnfilledPlaceholders, renderFaqSection, renderFaqSchema } from "../src/service-pages.js";
import { TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX } from "../assets/js/seo-check.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(path.join(repoRoot, "_service-template.html"), "utf8");

const PAGE = {
	slug: "borer-control",
	serviceName: "Borer Control",
	serviceType: "Borer control",
	title: "Borer Control Canberra | TCB Pest Control",
	description:
		"Borer in Canberra floorboards, furniture and roof timbers — how to spot the frass, and what treatment actually involves.",
	headingLead: "Borer control,",
	headingAccent: "treated at the timber",
	heroLead: "Fine powder under the skirting board. Small round holes in a floorboard that were not there last summer.",
	heroImage: "pest-termite-macro.webp",
	heroImageSmall: "pest-termite-macro-sm.webp",
	heroImageAlt: "Close-up of timber damage",
	bannerText: "Borer works from the inside out, so by the time the exit holes show the timber has already been tunnelled.",
	sections: [
		{ eyebrow: "Species", heading: "The borers in Canberra timber.", paragraphs: ["Lyctus favours the sapwood of hardwoods."] },
		{ eyebrow: "Signs", heading: "What borer looks like.", paragraphs: ["Fine frass below skirting boards is the first sign."] },
	],
	faqs: [{ question: "How do I know if borer is still active?", answer: "Fresh frass is the clearest sign." }],
	related: [{ href: "/termite-treatment", label: "Termite Treatment" }],
};

const render = (overrides = {}, options) => renderServicePage(TEMPLATE, { ...PAGE, ...overrides }, options);

test("nothing ships with a placeholder still in it", () => {
	// The failure that would be visible to a customer: a literal
	// {{HERO_LEAD}} on a live page. Refusing is better, and the template
	// gaining a field this does not fill is exactly how it would happen.
	assert.deepEqual(findUnfilledPlaceholders(render()), []);
});

test("the page it builds is about the thing it was asked for", () => {
	const html = render();
	// The template is derived from the ant page, so its slug leaking through
	// would point the canonical, the breadcrumb and the schema at a different
	// page entirely -- and every one of those is invisible to a reader.
	assert.ok(!html.includes("ant-control"), "the template's origin must not leak");
	assert.match(html, /<title>Borer Control Canberra \| TCB Pest Control<\/title>/);
	assert.match(html, /href="https:\/\/www\.tcbpestcontrolcanberra\.com\.au\/borer-control" rel="canonical"/);
	assert.match(html, /"serviceType": "Borer control"/);
	assert.match(html, /"position": 3,\s*"name": "Borer Control"/);
});

test("every structured-data block still parses, and the set is complete", () => {
	const html = render();
	const found = [];
	for (const [, block] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
		const parsed = JSON.parse(block); // throws, and should, if a block is malformed
		found.push(parsed["@type"]);
	}
	for (const type of ["ProfessionalService", "BreadcrumbList", "FAQPage", "Service"]) {
		assert.ok(found.includes(type), `${type} is missing from the generated page`);
	}
});

test("the FAQ schema only claims answers the page actually shows", () => {
	// Structured data describing answers a reader cannot find is what Google
	// calls mismatched, and it is penalised rather than ignored.
	const faqs = [
		{ question: "Is it active?", answer: "Fresh frass is the sign." },
		{ question: "Is it structural?", answer: "It depends on the species." },
	];
	const html = render({ faqs });
	// Found by walking the blocks rather than by one regex across the file:
	// a lazy match still runs past the end of the first <script> and swallows
	// the next, which is a test bug that reads like a malformed page.
	const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(([, body]) => JSON.parse(body));
	const schema = blocks.find((block) => block["@type"] === "FAQPage");
	assert.ok(schema, "the page carries an FAQPage block");
	assert.equal(schema.mainEntity.length, 2);
	for (const faq of faqs) {
		assert.ok(html.includes(faq.question), "the question is on the page");
		assert.ok(html.includes(faq.answer), "and so is its answer");
	}
});

test("a draft is not indexable, and publishing is what makes it so", () => {
	assert.match(render({}, { draft: true }), /<meta name="robots" content="noindex"\/>/);
	assert.doesNotMatch(render({}, { draft: false }), /content="noindex"/);
});

test("the generated page passes the length rules the panel enforces", () => {
	// A generated page that the site's own SEO check would immediately flag is
	// not finished work.
	const html = render();
	const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
	const description = html.match(/<meta content="([^"]*)" name="description"\/>/)[1];
	assert.ok(title.length >= TITLE_MIN && title.length <= TITLE_MAX, `title is ${title.length}`);
	assert.ok(
		description.length >= DESCRIPTION_MIN && description.length <= DESCRIPTION_MAX,
		`description is ${description.length}`
	);
	assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, "exactly one main heading");
});

test("the FAQ is numbered after the sections it follows", () => {
	// The hand-written pages happen to have three sections, so a fixed [04]
	// looks right on them and skips a number everywhere else.
	assert.match(renderFaqSection([{ question: "Q", answer: "A" }], { after: 2 }), /\[03\] FAQ/);
	assert.match(renderFaqSection([{ question: "Q", answer: "A" }], { after: 5 }), /\[06\] FAQ/);
});

test("a page with no questions carries no empty FAQ furniture", () => {
	// An FAQPage block with an empty mainEntity is invalid structured data,
	// and an FAQ heading with nothing under it is worse than no heading.
	assert.equal(renderFaqSection([]), "");
	assert.equal(renderFaqSchema([]), "");
	const html = render({ faqs: [] });
	assert.ok(!html.includes("FAQPage"));
	assert.deepEqual(findUnfilledPlaceholders(html), []);
});

test("wording is escaped, not injected", () => {
	// Everything here is written by a model and lands in HTML. An ampersand in
	// a heading is the ordinary case; a stray tag is the one that matters.
	const html = render({
		sections: [{ eyebrow: "Signs", heading: "Frass & dust", paragraphs: ['<script>alert("x")</script>'] }],
	});
	assert.ok(!html.includes('<script>alert'), "a tag in the wording must not become a tag on the page");
	assert.match(html, /Frass &amp; dust/);
});
