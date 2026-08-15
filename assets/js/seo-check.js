// The SEO checks the editor runs against the page you are looking at.
//
// Worth being clear about what this is for. A survey of all 134 pages found
// five issues, two of them on /staff-chat, which is an internal dashboard and
// has no business being in Google at all. The site is not in a bad state and
// this is not an audit tool.
//
// What changed is that the editor can now rewrite titles and descriptions, so
// the realistic risk is introducing a problem rather than discovering one.
// These checks run on the page in front of you, as you change it.
//
// Pure functions over a plain summary object rather than over the DOM, so the
// thresholds can be tested without a browser.

// Google truncates around 580 pixels, which is roughly 55-60 characters for
// this site's title case. Under 30 is usually a page that has not had its
// title written properly rather than a deliberately short one.
export const TITLE_MIN = 30;
export const TITLE_MAX = 62;

// Descriptions are shown at about 155-160 characters on desktop and less on
// mobile. Under 70 is a wasted opportunity rather than an error.
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 165;

// `page` is { title, description, h1Count, images, links, hasCanonical },
// where images is [{ src, hasAlt, altText }] and links is [{ href, text }].
//
// Returns findings ordered worst-first. Each carries `level` ("problem" |
// "worth a look" | "good"), a plain-English `message`, `detail` where there
// is something specific to point at, and `fix` -- what to actually do.
//
// The `fix` line matters more than the message. "The title is 80 characters"
// is a fact; it does not tell someone who has never thought about a page
// title what a good one looks like or which end to cut. Every finding that
// can be acted on says how, in terms of this site rather than in general.
export function checkSeo(page) {
	const findings = [];
	const title = String(page.title || "").trim();
	const description = String(page.description || "").trim();

	if (!title) {
		findings.push({
			level: "problem",
			message: "This page has no title. Google will invent one.",
			fix: "Write one in Page settings. The shape that works here is what you do, then where, then the business: “Spider Control Canberra | TCB Pest Control”.",
		});
	} else if (title.length > TITLE_MAX) {
		findings.push({
			level: "worth a look",
			message: `The title is ${title.length} characters — Google will cut it off around ${TITLE_MAX}.`,
			detail: title,
			fix: `Cut ${title.length - TITLE_MAX} characters from the middle rather than the front. The first few words are what someone reads, and the business name on the end is what they look for to recognise you.`,
		});
	} else if (title.length < TITLE_MIN) {
		findings.push({
			level: "worth a look",
			message: `The title is only ${title.length} characters. There is room to say more.`,
			detail: title,
			fix: "Add the suburb or city, or the specific pest. Somebody searching “termite inspection Kambah” is looking for those words in the result.",
		});
	} else {
		findings.push({ level: "good", message: `Title length is fine (${title.length} characters).` });
	}

	if (!description) {
		findings.push({
			level: "problem",
			message: "This page has no description, so Google will pick a sentence from the page itself.",
			fix: "Write one or two sentences in Page settings that would make someone pick you over the result above and below: what you treat, where, and what is different about how you do it.",
		});
	} else if (description.length > DESCRIPTION_MAX) {
		findings.push({
			level: "worth a look",
			message: `The description is ${description.length} characters — it will be cut off around ${DESCRIPTION_MAX}.`,
			detail: description,
			fix: `Put the part that would win the click in the first ${DESCRIPTION_MAX} characters. Everything after that is only read by Google.`,
		});
	} else if (description.length < DESCRIPTION_MIN) {
		findings.push({
			level: "worth a look",
			message: `The description is only ${description.length} characters. A fuller one gets more clicks.`,
			detail: description,
			fix: "There is room for another clause. Same-week availability, a written report, family-safe products — whichever is true of this job.",
		});
	} else {
		findings.push({ level: "good", message: `Description length is fine (${description.length} characters).` });
	}

	if (page.h1Count === 0) {
		findings.push({
			level: "problem",
			message: "This page has no main heading.",
			fix: "The main heading is the big line at the top of the page. Without one, Google has to guess what the page is about from the body text.",
		});
	} else if (page.h1Count > 1) {
		findings.push({
			level: "worth a look",
			message: `There are ${page.h1Count} main headings. A page should normally have one.`,
			fix: "Keep the one at the top and turn the others into sub-headings, so it is clear which is the subject of the page.",
		});
	}

	const images = page.images || [];
	const missingAlt = images.filter((image) => !image.hasAlt);
	if (missingAlt.length) {
		findings.push({
			level: "problem",
			message: `${missingAlt.length} ${missingAlt.length === 1 ? "image has" : "images have"} no description, so screen readers and Google cannot tell what they show.`,
			detail: missingAlt.map((image) => image.src).slice(0, 3).join(", "),
			fix: "Click the image in the editor and describe what it shows — “a technician spraying along a skirting board”, not “pest control”.",
		});
	}

	// An empty alt is legitimate -- it marks an image as decorative -- but a
	// filename as alt text is always a mistake.
	const filenameAlt = images.filter((image) => image.hasAlt && /\.(webp|jpe?g|png|svg|avif|gif)$/i.test(String(image.altText || "").trim()));
	if (filenameAlt.length) {
		findings.push({
			level: "worth a look",
			message: `${filenameAlt.length} image ${filenameAlt.length === 1 ? "description is" : "descriptions are"} just a filename. Describe what the picture shows.`,
			detail: filenameAlt.map((image) => image.altText).slice(0, 3).join(", "),
			fix: "Replace the filename with a sentence about the picture. Somebody using a screen reader hears this read out.",
		});
	}

	// "Click here" tells Google nothing about the destination, and tells
	// somebody using a screen reader even less.
	const vagueLinks = (page.links || []).filter((link) =>
		/^(click here|here|read more|more|link|this)$/i.test(String(link.text || "").trim())
	);
	if (vagueLinks.length) {
		findings.push({
			level: "worth a look",
			message: `${vagueLinks.length} ${vagueLinks.length === 1 ? "link says" : "links say"} something like "click here". Say where it goes instead.`,
			detail: vagueLinks.map((link) => link.href).slice(0, 3).join(", "),
			fix: "Say where it goes: “Book a termite inspection” rather than “click here”. Google reads link wording as a description of the page it points at.",
		});
	}

	if (page.hasCanonical === false) {
		findings.push({
			level: "problem",
			message: "This page has no canonical tag.",
			fix: "This one is not editable here — it is a line in the page's code that tells Google which address is the real one. Worth passing on to whoever maintains the site.",
		});
	}

	const order = { problem: 0, "worth a look": 1, good: 2 };
	return findings.sort((a, b) => order[a.level] - order[b.level]);
}

// How the page is likely to appear in a result, so length limits mean
// something concrete rather than being a number to trust.
export function googlePreview(page, origin = "https://www.tcbpestcontrolcanberra.com.au", path = "/") {
	const title = String(page.title || "").trim();
	const description = String(page.description || "").trim();
	return {
		title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
		url: `${origin.replace(/^https?:\/\//, "")}${path === "/" ? "" : path}`,
		description:
			description.length > DESCRIPTION_MAX
				? `${description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
				: description,
		titleTruncated: title.length > TITLE_MAX,
		descriptionTruncated: description.length > DESCRIPTION_MAX,
	};
}

// Gathers what checkSeo needs from a live document. Kept apart from the
// checks themselves so those stay testable without a browser.
export function summarisePage(doc, ignoreSelector) {
	const visible = (element) => !ignoreSelector || !element.closest(ignoreSelector);
	const descriptionMeta = doc.querySelector('meta[name="description"]');
	return {
		title: doc.title,
		description: descriptionMeta ? descriptionMeta.getAttribute("content") : "",
		h1Count: [...doc.querySelectorAll("h1")].filter(visible).length,
		images: [...doc.querySelectorAll("img")]
			.filter(visible)
			.map((image) => ({ src: image.getAttribute("src"), hasAlt: image.hasAttribute("alt"), altText: image.getAttribute("alt") })),
		links: [...doc.querySelectorAll("a[href]")]
			.filter(visible)
			.map((link) => ({ href: link.getAttribute("href"), text: link.textContent })),
		hasCanonical: !!doc.querySelector('link[rel="canonical"]'),
	};
}
