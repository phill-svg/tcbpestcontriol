// Gaps between what Google shows a page for and what the page says.
//
// The whole value here is that a gap is a measured fact rather than a
// prediction, so the tests are mostly about not manufacturing gaps that are
// not real: a plural is not a gap, a brand search is not a gap, and a phrase
// the page is already winning is not a gap however little it mentions it.
// Every false gap sends somebody off to rewrite a title that was fine.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findGaps, missingWords, contentWords, stem, isBrandQuery, describeGap } from "../src/seo-gaps.js";

const PAGE = {
	title: "Termite Treatment Canberra | TCB Pest Control Canberra",
	description: "Termite inspections and treatment across Canberra, with a written report after every visit.",
	h1: "Termites. Inspection, treatment, warranty.",
};

const row = (key, impressions, position, clicks = 0) => ({ key, impressions, position, clicks });

test("a phrase the page never says, that Google shows it for, is a gap", () => {
	const gaps = findGaps([row("white ants canberra", 340, 12)], PAGE);
	assert.equal(gaps.length, 1);
	assert.deepEqual(gaps[0].missing, ["white", "ant"]);
	assert.equal(gaps[0].impressions, 340);
});

test("a plural is not a gap", () => {
	// The page says "Termites"; somebody searched "termite". Reporting that
	// as missing would be both wrong and constant.
	assert.deepEqual(missingWords("termite treatment canberra", PAGE), []);
	assert.deepEqual(missingWords("termites treatment canberra", PAGE), []);
	assert.equal(stem("termites"), "termite");
	assert.equal(stem("cockroaches"), "cockroach");
	assert.equal(stem("canberra"), "canberra", "a word ending in a vowel is left alone");
	assert.equal(stem("gas"), "gas", "and a three-letter word is not butchered");
});

test("filler words are not counted as missing", () => {
	assert.deepEqual(missingWords("termite treatment in canberra for my home", PAGE), ["home"]);
	assert.deepEqual(contentWords("pest control near me"), ["pest", "control", "near"], "“me” carries no subject matter");
	assert.deepEqual(contentWords("cockroaches in the kitchen"), ["cockroach", "kitchen"]);
});

test("searching for the business by name is not a gap", () => {
	// They find you whatever the title says. Nothing to act on.
	assert.ok(isBrandQuery("tcb pest control"));
	assert.ok(isBrandQuery("TCB Canberra"));
	assert.ok(!isBrandQuery("pest control canberra"));
	assert.deepEqual(findGaps([row("tcb termite people", 500, 9)], PAGE), []);
});

test("a phrase the page is already winning is left alone", () => {
	// Rewriting a title that is working is how a good page gets broken.
	assert.deepEqual(findGaps([row("white ants canberra", 900, 2)], PAGE), []);
});

test("a phrase far out of reach is not offered as a quick win", () => {
	// At position 40 the wording is not what is standing in the way, and
	// saying otherwise wastes somebody's afternoon.
	assert.deepEqual(findGaps([row("white ants canberra", 900, 41)], PAGE), []);
});

test("a phrase almost nobody searches is not worth a rewrite", () => {
	assert.deepEqual(findGaps([row("white ants canberra", 4, 12)], PAGE), []);
});

test("bigger misses come first", () => {
	// Shown often and buried beats shown rarely and nearly there.
	const gaps = findGaps(
		[row("borer inspection canberra", 60, 5), row("white ants canberra", 2000, 15), row("roof void inspection", 100, 11)],
		PAGE
	);
	assert.deepEqual(gaps.map((gap) => gap.query), [
		"white ants canberra",
		"roof void inspection",
		"borer inspection canberra",
	]);
});

test("only the title, description and heading count as what the page says", () => {
	// A phrase buried in the eleventh paragraph is not what the page is
	// presenting itself as being about, and Google's own result shows the
	// first three.
	const buried = { ...PAGE, body: "We also treat white ants throughout Canberra." };
	assert.deepEqual(missingWords("white ants canberra", buried), ["white", "ant"]);
});

test("the explanation leads with the numbers, because they are the argument", () => {
	const [gap] = findGaps([row("white ants canberra", 2340, 12.4)], PAGE);
	const sentence = describeGap(gap);
	assert.match(sentence, /2,340 times/);
	assert.match(sentence, /position 12\.4/);
	assert.match(sentence, /“white”, “ant”/);
});

test("no searches means no gaps rather than an error", () => {
	assert.deepEqual(findGaps([], PAGE), []);
	assert.deepEqual(findGaps(undefined, PAGE), []);
});
