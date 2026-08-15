// Gaps between what Google shows a page for and what the page says.
//
// The whole value here is that a gap is a measured fact rather than a
// prediction, so the tests are mostly about not manufacturing gaps that are
// not real: a plural is not a gap, a brand search is not a gap, and a phrase
// the page is already winning is not a gap however little it mentions it.
// Every false gap sends somebody off to rewrite a title that was fine.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findGaps, missingWords, contentWords, stem, isBrandQuery, describeGap, fixForGap, betterPageFor, isAbout } from "../src/seo-gaps.js";

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
	assert.deepEqual(contentWords("pest control near me"), ["pest", "control"], "neither “near” nor “me” names a subject");
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
	assert.match(fixForGap(gap), /“white” and “ant”/);
});

test("no searches means no gaps rather than an error", () => {
	assert.deepEqual(findGaps([], PAGE), []);
	assert.deepEqual(findGaps(undefined, PAGE), []);
});

// --- is this page even the right one to fix? ---------------------------------
//
// The question the first version forgot to ask, and forgetting it made the
// advice actively harmful. The homepage was shown 165 times for "bird control
// canberra" and never says "bird" -- but /bird-control exists, and working
// "bird" into the homepage would set the two competing, which is exactly what
// the duplicate-title check elsewhere is for. A gap only means "change this
// page" once nothing better answers it.

const HOME = { title: "Pest Control Canberra | TCB Pest Control", description: "Termites, rodents and general pest control across the ACT.", h1: "Pest control in Canberra." };

test("a phrase another page answers better is not a reason to change this one", () => {
	const [gap] = findGaps([row("bird control canberra", 165, 10.5)], HOME, {
		path: "/",
		rankings: { "bird control canberra": [{ path: "/", position: 10.5 }, { path: "/bird-control", position: 4.2 }] },
	});
	assert.equal(gap.verdict, "elsewhere");
	assert.equal(gap.rival.path, "/bird-control");
	assert.match(fixForGap(gap), /Nothing to do/);
	assert.match(fixForGap(gap), /already does better at position 4\.2/);
	assert.match(fixForGap(gap), /competing for the same result/);
});

test("when the specialist page is behind, the work is pointed at that page", () => {
	const [gap] = findGaps([row("bee pest control canberra", 86, 8.7)], HOME, {
		path: "/",
		rankings: { "bee pest control canberra": [{ path: "/", position: 8.7 }, { path: "/bees", position: 14.0 }] },
	});
	assert.equal(gap.verdict, "strengthen");
	// The instruction has to say which page, which words, and what next.
	assert.match(fixForGap(gap), /Open \/bees/);
	assert.match(fixForGap(gap), /page title, its description and its main heading/);
	assert.match(fixForGap(gap), /link to it from this page, using those words/);
});

test("with nothing else ranking, the words belong here or on a new page", () => {
	// "borer control canberra" — there is no borer page on this site.
	const [gap] = findGaps([row("borer control canberra", 46, 16.7)], HOME, {
		path: "/",
		rankings: { "borer control canberra": [{ path: "/", position: 16.7 }] },
	});
	assert.equal(gap.verdict, "add");
	assert.match(fixForGap(gap), /No page on the site is about this/);
	assert.match(fixForGap(gap), /give it a page of its own/);
});

test("gaps another page owns sink below the ones worth acting on", () => {
	// Still shown, because "Google offers this page for that" is worth
	// knowing -- but never above a gap that can actually be acted on here.
	const gaps = findGaps(
		[row("bird control canberra", 900, 10.5), row("borer control canberra", 46, 16.7)],
		HOME,
		{
			path: "/",
			rankings: {
				"bird control canberra": [{ path: "/bird-control", position: 3.1 }],
				"borer control canberra": [{ path: "/", position: 16.7 }],
			},
		}
	);
	assert.deepEqual(gaps.map((gap) => gap.query), ["borer control canberra", "bird control canberra"]);
});

test("with no ranking data at all it does not invent a rival", () => {
	const [gap] = findGaps([row("borer control canberra", 46, 16.7)], HOME);
	assert.equal(gap.verdict, "add");
	assert.equal(gap.rival, null);
});

test("the page itself is never its own rival", () => {
	assert.equal(betterPageFor("x", "/", { x: [{ path: "/", position: 2 }] }), null);
	assert.equal(betterPageFor("x", "/", {}), null);
});

test("“near me” is not answered by putting the word “near” in a title", () => {
	// Google resolves those from where the searcher is standing. Suggesting
	// the word be added is not merely useless, it is slightly deranged.
	assert.deepEqual(findGaps([row("pest control near me", 42, 17)], HOME), []);
	assert.deepEqual(contentWords("pest control near me"), ["pest", "control"]);
});

// --- ranking next to something is not the same as being about it -------------

test("a suburb page is not “the page that should own” borer control", () => {
	// The worst line this panel has printed. /locations-pest-control-tuggeranong
	// ranked 20.0 for "borer control canberra", so the code declared it the
	// rightful owner and told somebody to go and put borers on a suburb page.
	// It ranked next. That is all it did.
	const [gap] = findGaps([row("borer control canberra", 46, 16.7)], HOME, {
		path: "/",
		rankings: {
			"borer control canberra": [
				{ path: "/", position: 16.7 },
				{ path: "/locations-pest-control-tuggeranong", position: 20.0 },
			],
		},
	});
	assert.equal(gap.verdict, "add", "nothing on the site is about borers");
	assert.equal(gap.rival, null);
	assert.match(fixForGap(gap), /No page on the site is about this/);
});

test("relatedness is judged on the subject, not on the words every page shares", () => {
	// Every path here contains "pest" and "control", so matching on those
	// would make every page related to every search.
	assert.ok(isAbout("bird control canberra", "/bird-control"));
	assert.ok(isAbout("bee pest control canberra", "/bees"));
	assert.ok(isAbout("termite inspection canberra", "/termite-treatment"));
	assert.ok(!isAbout("borer control canberra", "/locations-pest-control-tuggeranong"));
	assert.ok(!isAbout("pest control canberra", "/bird-control"), "a generic search belongs to no specific page");
	assert.ok(!isAbout("bird control canberra", "/rodent-control"));
});

test("beating another page by a fraction is not beating it", () => {
	// /bird-control at 10.7 against this page at 10.5. Google shuffles by
	// more than that in a week, and "leave it alone, that page is winning"
	// would be advice built on noise.
	const [gap] = findGaps([row("bird control canberra", 165, 10.5)], HOME, {
		path: "/",
		rankings: { "bird control canberra": [{ path: "/", position: 10.5 }, { path: "/bird-control", position: 10.7 }] },
	});
	assert.equal(gap.verdict, "strengthen");
	assert.match(fixForGap(gap), /neck and neck/);

	// A real margin still reads as one page being ahead.
	const [clear] = findGaps([row("bird control canberra", 165, 10.5)], HOME, {
		path: "/",
		rankings: { "bird control canberra": [{ path: "/", position: 10.5 }, { path: "/bird-control", position: 4.2 }] },
	});
	assert.equal(clear.verdict, "elsewhere");
});

test("every gap says what to type, not that work exists", () => {
	// The complaint that produced this: "it isn't saying how to fix it".
	const gaps = findGaps(
		[row("bird control canberra", 165, 10.5), row("borer control canberra", 46, 16.7)],
		HOME,
		{
			path: "/",
			rankings: {
				"bird control canberra": [{ path: "/bird-control", position: 17.5 }],
				"borer control canberra": [{ path: "/", position: 16.7 }],
			},
		}
	);
	for (const gap of gaps) {
		const fix = fixForGap(gap);
		assert.ok(fix.length > 80, "a fix is a set of steps, not a shrug");
		assert.match(fix, /title|page of its own|Nothing to do/, "it names what to change");
	}
});
