// Phrases Google already shows a page for, that the page never actually says.
//
// This is the closest thing here to an answer to "what would rank better",
// and it is worth being precise about why it is not a prediction. Nothing in
// this editor can forecast a ranking, and any tool that claims to is guessing
// with a confident face. What this does instead is measure a gap that has
// already been observed: Google has decided, 340 times this month, that this
// page is a plausible answer for "white ants canberra" -- and the page does
// not contain the words "white ant" anywhere in its title, description or
// heading. That mismatch is a fact about two things that exist, not a model
// of the future, and closing it is about as reliable as advice here gets.
//
// It only became possible once Search Console was connected. Before that
// there was no record of what Google shows the site for, so this module would
// have had nothing to read.

// Words that carry no subject matter. Kept short on purpose: an aggressive
// list starts eating real search terms, and "pest" or "cost" or "near" are
// all things somebody genuinely typed.
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"me",
	"my",
	// "pest control near me" cannot be answered by putting the word "near"
	// in a title -- Google resolves those from where the searcher is, not
	// from the page's wording. Left in, it produces advice that is not merely
	// useless but slightly deranged.
	"near",
	"nearby",
	"of",
	"on",
	"or",
	"our",
	"that",
	"the",
	"to",
	"we",
	"what",
	"with",
	"you",
	"your",
]);

// The business's own name. Somebody searching for you by name finds you
// whatever the title says, so those queries are not gaps -- they are the one
// case where the ranking is already settled.
const BRAND = ["tcb"];

// Below this, a phrase is too rare for the difference to be measurable.
export const MIN_IMPRESSIONS = 20;
// Above position 3 there is room to climb; past 20, a wording change alone
// is not usually what is standing in the way.
export const BEST_POSITION = 3;
export const WORST_POSITION = 20;
// Two pages within this of each other are not really ahead or behind. Google
// shuffles by more than that week to week, and "beating it by 0.2" is not a
// fact worth building an instruction on.
export const LEVEL_MARGIN = 2;

// Crude singularisation, deliberately. "ants" and "ant", "termites" and
// "termite", "cockroaches" and "cockroach" have to match or every plural
// search looks like a gap. A real stemmer would be worse here: it would also
// fold words this is meant to keep apart.
export function stem(word) {
	const lower = word.toLowerCase();
	// "es" only comes off where it was added to a word that could not simply
	// take an "s" -- cockroaches, boxes, ashes. Taking it off everything turns
	// "termites" into "termit", which then matches nothing.
	if (lower.length > 4 && /(ch|sh|s|x|z)es$/.test(lower)) return lower.slice(0, -2);
	if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
	return lower;
}

export function contentWords(text) {
	return (String(text || "").toLowerCase().match(/[a-z']+/g) || [])
		.filter((word) => !STOPWORDS.has(word))
		.map(stem);
}

export function isBrandQuery(query) {
	const words = new Set(contentWords(query));
	return BRAND.some((brand) => words.has(stem(brand)));
}

// Which of a search phrase's words the page never says. `where` is whatever
// a visitor and Google both see first: the title, the description, the main
// heading. Body text is deliberately excluded -- a phrase buried in the
// eleventh paragraph is not what the page is presenting itself as being about.
export function missingWords(query, page) {
	const said = new Set(contentWords([page.title, page.description, page.h1].filter(Boolean).join(" ")));
	return [...new Set(contentWords(query))].filter((word) => !said.has(word));
}

// Whether some other page on the site is the better answer for this search,
// and how it is doing. `rankings` maps a search phrase to every page of this
// site that Google shows for it.
//
// This is the question the first version of this module forgot to ask, and
// forgetting it made the advice actively harmful. The homepage was shown 165
// times for "bird control canberra", never says "bird", and the obvious
// conclusion -- work "bird" into the homepage -- would have set the homepage
// competing against /bird-control, which is the exact problem the duplicate
// title check elsewhere warns about. A gap is only an instruction to change
// *this* page once you know no better page exists.
// Words every path on this site contains, and which therefore say nothing
// about what a page is for. Without these removed, /locations-pest-control-
// tuggeranong looks related to every pest search ever made.
const GENERIC = new Set(["pest", "control", "canberra", "location", "locations", "act", "treatment", "service", "services"]);

export function distinctiveWords(text) {
	return contentWords(String(text || "").replace(/[-/]/g, " ")).filter((word) => !GENERIC.has(word));
}

// Is this page plausibly *about* the search, or does it merely happen to turn
// up for it?
//
// This is the check whose absence produced the worst line the panel has
// printed: "/locations-pest-control-tuggeranong is the page that should own
// borer control". Tuggeranong ranked at 20.0 for it, so the code called it
// the rightful owner. It is a suburb page. Ranking next is not the same as
// being the right answer, and a page is only the right answer for a search
// when it is actually on that subject.
export function isAbout(query, path) {
	const wanted = distinctiveWords(query);
	if (!wanted.length) return false;
	const has = new Set(distinctiveWords(path));
	return wanted.some((word) => has.has(word));
}

// The page on this site that is genuinely about this search, if there is one.
export function betterPageFor(query, path, rankings) {
	const rows = (rankings && rankings[query]) || [];
	const related = rows
		.filter((row) => row.path && row.path !== path && isAbout(query, row.path))
		.sort((a, b) => (a.position || 999) - (b.position || 999));
	return related[0] || null;
}

// `queries` are this page's rows from Search Console. `rankings` is optional
// and, when present, is what stops a gap being read as "put these words on
// this page" when another page is the one that should have them.
//
// Returned worst-gap-first, where "worst" weighs how often Google shows the
// page against how far down it puts it. A phrase shown 2,000 times at
// position 15 is a bigger miss than one shown 40 times at position 5.
export function findGaps(queries, page, { path = null, rankings = null } = {}) {
	const gaps = [];

	for (const row of queries || []) {
		const query = String(row.key || "").trim();
		if (!query || isBrandQuery(query)) continue;
		if ((row.impressions || 0) < MIN_IMPRESSIONS) continue;
		// Already winning: nothing to fix, and rewriting a title that is
		// working is how a good page gets broken.
		if (row.position && row.position <= BEST_POSITION) continue;
		if (row.position && row.position > WORST_POSITION) continue;

		const missing = missingWords(query, page);
		if (!missing.length) continue;

		const position = row.position || 0;
		const better = rankings ? betterPageFor(query, path, rankings) : null;

		// Three different situations wearing the same clothes. "Clearly ahead"
		// needs a real margin: a page beating another by 0.2 places has not
		// settled anything, and calling that "already answers it better" tells
		// somebody to leave alone a page that is not actually winning.
		let verdict = "add";
		if (better && better.position < position - LEVEL_MARGIN) verdict = "elsewhere";
		else if (better) verdict = "strengthen";

		gaps.push({
			query,
			impressions: row.impressions || 0,
			clicks: row.clicks || 0,
			position,
			missing,
			verdict,
			rival: better ? { path: better.path, position: better.position } : null,
			// Roughly "how much is being left on the table": shown often, and
			// sitting far enough down that almost nobody scrolls to it. A
			// phrase another page already answers better is worth nothing
			// here, so it sinks rather than being hidden -- it is still worth
			// knowing that Google is offering this page for it.
			weight: (row.impressions || 0) * Math.min(1, position / 10) * (verdict === "elsewhere" ? 0.05 : 1),
		});
	}

	return gaps.sort((a, b) => b.weight - a.weight).slice(0, 8);
}

// What was observed, and separately, what to actually do about it.
//
// Two fields rather than one paragraph, because they are different kinds of
// sentence and the first version blurred them into a shrug. "The work belongs
// there, not here" is not an instruction -- it does not say what work, on
// which words, or what to do afterwards. Whoever reads this has a page open
// and wants to know what to type.
export function describeGap(gap) {
	const shown = gap.impressions.toLocaleString();
	return `Google showed this page ${shown} times for “${gap.query}”, at position ${gap.position.toFixed(1)}.`;
}

export function fixForGap(gap) {
	const phrase = `“${gap.query}”`;

	if (gap.verdict === "elsewhere") {
		return (
			`Nothing to do. ${gap.rival.path} is the page for this and already does better at position ` +
			`${gap.rival.position.toFixed(1)}. Putting ${phrase} in this page's title would set your own two pages ` +
			`competing for the same result.`
		);
	}

	if (gap.verdict === "strengthen") {
		const level = Math.abs(gap.rival.position - gap.position) < LEVEL_MARGIN;
		return (
			`${gap.rival.path} is the page for this and is ${level ? `neck and neck with this one at ${gap.rival.position.toFixed(1)}` : `further back at ${gap.rival.position.toFixed(1)}`}. ` +
			`Open ${gap.rival.path}, and make sure the words ${phrase} appear in its page title, its description and its ` +
			`main heading. Then add a link to it from this page, using those words as the link text rather than “click here”.`
		);
	}

	const missing = gap.missing.map((word) => `“${word}”`).join(" and ");
	return (
		`No page on the site is about this. Either work ${missing} into this page's title and description, or — since ` +
		`${gap.impressions.toLocaleString()} people a month search it and nothing here covers it — give it a page of its own.`
	);
}
