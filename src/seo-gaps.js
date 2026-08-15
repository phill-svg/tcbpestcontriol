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
export function betterPageFor(query, path, rankings) {
	const rows = (rankings && rankings[query]) || [];
	const others = rows
		.filter((row) => row.path && row.path !== path)
		.sort((a, b) => (a.position || 999) - (b.position || 999));
	return others[0] || null;
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

		// Three different situations wearing the same clothes.
		let verdict = "add";
		if (better && better.position <= position) verdict = "elsewhere";
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

// One line a person can act on, per gap. The numbers are the argument -- the
// point is not that a phrase is missing, it is that a specific number of
// people saw this page offered for it and it does not mention it.
//
// The three verdicts lead somewhere genuinely different, and collapsing them
// into "mention this phrase" is what made the first version wrong.
export function describeGap(gap, path = "this page") {
	const shown = gap.impressions.toLocaleString();
	const missing = gap.missing.map((word) => `“${word}”`).join(", ");
	const seen = `Google showed this page ${shown} times for “${gap.query}” at position ${gap.position.toFixed(1)}`;

	if (gap.verdict === "elsewhere") {
		return (
			`${seen}, but ${gap.rival.path} already answers it better at position ${gap.rival.position.toFixed(1)}. ` +
			`Nothing to do here — adding ${missing} to this page would only set the two competing.`
		);
	}

	if (gap.verdict === "strengthen") {
		return (
			`${seen}. ${gap.rival.path} is the page that should own this and is behind at position ` +
			`${gap.rival.position.toFixed(1)} — the work belongs there, not here. Linking to it from this page helps too.`
		);
	}

	return (
		`${seen}, no other page on the site ranks for it, and this page's title, description and heading never say ` +
		`${missing}. Either work them in here, or it may deserve a page of its own.`
	);
}
