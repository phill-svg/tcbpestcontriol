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
//
// Every check that reads a newer summary field is gated on the field being
// present. The two collectors -- summarisePage below for the live DOM, and
// extractPageSummary in src/seo-scan.js for the whole-site scan -- grew these
// fields at different times, and a check that treated "not collected" as
// "missing from the page" would invent problems on every older caller. Absent
// means unmeasured, and unmeasured stays quiet.

// Google truncates around 580 pixels, which is roughly 55-60 characters for
// this site's title case. Under 30 is usually a page that has not had its
// title written properly rather than a deliberately short one.
export const TITLE_MIN = 30;
export const TITLE_MAX = 62;

// The truncation is really by width, not by count -- 62 characters of "ill"
// and 62 of "WWW" are different sentences to a search result. The character
// limits above stay, because they are what the editor's counters and the
// suggestion engine work in; the pixel estimate exists to catch the title
// that is inside the count but outside the pixels. Measured against all 134
// live titles, nothing trips it today -- which is the point: it only speaks
// when a title is genuinely unusual.
export const TITLE_MAX_PX = 580;

// Descriptions are shown at about 155-160 characters on desktop and less on
// mobile. Under 70 is a wasted opportunity rather than an error.
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 165;

// Below this the body text is thin enough that Google has little to rank the
// page on. The thinnest real page on this site is /thank-you at 165 words --
// a conversion page, and rightly terse -- so the line sits under it.
export const BODY_WORDS_MIN = 150;

// The site's own canonical home. A canonical tag pointing anywhere else is a
// page telling Google its real address is somewhere it is not.
const SITE_HOST = /(^|\.)tcbpestcontrolcanberra\.com\.au$/i;

// Rough per-character widths for the ~20px font Google draws titles in.
// Not typography, and does not need to be: the estimate is used with headroom,
// and being ten pixels out never changes the advice.
function characterWidth(ch) {
	if ("iljI.,'|!:;".includes(ch)) return 5;
	if ("ftr()[]\"-".includes(ch)) return 7;
	if (ch === " ") return 6;
	if ("mw".includes(ch)) return 15;
	if ("MW".includes(ch)) return 17;
	if (ch >= "A" && ch <= "Z") return 13.5;
	if (ch >= "0" && ch <= "9") return 11;
	if (ch === "&") return 13;
	return 10;
}

export function titleWidth(text) {
	let width = 0;
	for (const ch of String(text || "")) width += characterWidth(ch);
	return Math.round(width);
}

// The longest prefix that fits the width, for the preview.
function cutToWidth(text, maxWidth) {
	let width = 0;
	let at = 0;
	for (const ch of String(text || "")) {
		const next = width + characterWidth(ch);
		if (next > maxWidth) break;
		width = next;
		at += ch.length;
	}
	return text.slice(0, at);
}

// "Click here" tells Google nothing about the destination, and tells
// somebody using a screen reader even less. The list is exact phrases rather
// than substrings, so "Read more about termite barriers" is left alone.
const VAGUE_LINK =
	/^(click here|here|read more|more|learn more|find out more|more info|more information|see more|see all|view|view all|view more|get started|details|continue|continue reading|link|this|go)$/i;

// Alt text that names a category instead of the picture. As useless to a
// screen reader as a filename, and just as common.
const GENERIC_ALT = new Set(["image", "photo", "picture", "pic", "img", "icon", "logo", "graphic", "banner", "screenshot", "untitled"]);

const sameWording = (a, b) =>
	String(a || "").replace(/\s+/g, " ").trim().toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().toLowerCase();

// Which structured-data blocks parse, and whether the business block carries
// what Google's local results want. Takes the raw text of each
// <script type="application/ld+json"> block; shared by both collectors so the
// browser and the scanner cannot drift into different opinions.
//
// The org completeness answer (`orgMissing`) is reported by the whole-site
// scan rather than per page -- the block is one shared template across all
// 134 pages, and 134 copies of "missing an address" is one fact shouted 134
// times.
const ORG_TYPES = new Set(["LocalBusiness", "ProfessionalService", "HomeAndConstructionBusiness", "PestControl"]);
const ORG_FIELDS = ["name", "telephone", "address"];

export function analyseSchema(blocks) {
	const result = { schemaBlocks: 0, schemaBroken: 0, orgMissing: null };
	for (const block of blocks || []) {
		result.schemaBlocks++;
		let parsed;
		try {
			parsed = JSON.parse(block);
		} catch {
			result.schemaBroken++;
			continue;
		}
		// A block can be one thing, a list of things, or a @graph of things.
		const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed["@graph"]) ? parsed["@graph"] : [parsed];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
			if (!types.some((type) => ORG_TYPES.has(type))) continue;
			result.orgMissing = ORG_FIELDS.filter((field) => !item[field]);
		}
	}
	return result;
}

// `page` is { title, description, h1Count, images, links, hasCanonical },
// where images is [{ src, hasAlt, altText }] and links is [{ href, text }].
// Newer collectors add: canonicalHref, robots, ogTitle, ogDescription,
// hasOgImage, wordCount, schemaBlocks, schemaBroken, and the page's own
// path/origin -- all optional, and each check that needs one skips when it
// was not collected.
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

	// A noindex is the loudest thing a page can say to Google, so it comes
	// before any opinion about wording. Right on a private page; on anything
	// meant to be found it makes every other finding irrelevant.
	if (typeof page.robots === "string" && /noindex/i.test(page.robots)) {
		findings.push({
			level: "problem",
			message: "This page tells Google not to index it at all.",
			detail: `robots: ${page.robots}`,
			fix: "The robots tag says “noindex”. Deliberate for a private page like the staff dashboard; on any page meant to be found, it is invisibility, whatever the title says. If this page should be in Google, that line has to come out of the page's code.",
		});
	}

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
	} else if (titleWidth(title) > TITLE_MAX_PX) {
		// Inside the character count but outside the pixels -- capitals and
		// wide letters take more room than the count suggests, and Google
		// trims by width.
		findings.push({
			level: "worth a look",
			message: `The title fits ${title.length} characters but measures wide — Google trims by width, and this one is likely to be cut off.`,
			detail: title,
			fix: "Capital letters and wide ones like “w” take more room than the count suggests. Trim a few characters from the middle, and check the preview above.",
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
			fix: "There is room for another clause — same-week availability, a written report, family-safe products, whichever is true of this job. Worth knowing Google rewrites descriptions about half the time anyway, so spend real effort where the search panel shows clicks being missed.",
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
	// filename or a category word as alt text is always a mistake.
	const uselessAlt = images.filter((image) => {
		if (!image.hasAlt) return false;
		const alt = String(image.altText || "").trim();
		return /\.(webp|jpe?g|png|svg|avif|gif)$/i.test(alt) || GENERIC_ALT.has(alt.toLowerCase());
	});
	if (uselessAlt.length) {
		findings.push({
			level: "worth a look",
			message: `${uselessAlt.length} image ${uselessAlt.length === 1 ? "description is" : "descriptions are"} just a filename or a word like "photo". Describe what the picture shows.`,
			detail: uselessAlt.map((image) => image.altText).slice(0, 3).join(", "),
			fix: "Replace it with a sentence about the picture. Somebody using a screen reader hears this read out.",
		});
	}

	const links = page.links || [];

	// A link with no text at all is the worst version of a vague one: a screen
	// reader reads out the raw address, and Google learns nothing about the
	// destination. `text` from both collectors already includes the link's
	// aria-label and the alt text of any image inside it, so what is flagged
	// here is genuinely nameless.
	const namelessLinks = links.filter((link) => !String(link.text || "").trim());
	if (namelessLinks.length) {
		findings.push({
			level: "problem",
			message: `${namelessLinks.length} ${namelessLinks.length === 1 ? "link has" : "links have"} no text at all — a screen reader reads out the raw address instead.`,
			detail: namelessLinks.map((link) => link.href).slice(0, 3).join(", "),
			fix: "Put words inside the link. If it wraps a picture, describe the picture — that description becomes the link's name.",
		});
	}

	const vagueLinks = links.filter((link) => VAGUE_LINK.test(String(link.text || "").trim()));
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
	} else if (typeof page.canonicalHref === "string" && page.canonicalHref && page.path) {
		// Having the tag is the easy half. One pointing at the wrong address
		// is worse than none: it is the page telling Google, in writing, that
		// the real page is somewhere else.
		findings.push(...checkCanonical(page.canonicalHref, page.path, page.origin));
	}

	// The social tags. When a title is edited and published here, the serving
	// layer rewrites og:title and twitter:title to match -- so drift can only
	// come from the file itself being edited by hand. Real, and worth catching:
	// the first run of this check found eight pages sharing an old title.
	if (page.ogTitle !== undefined && page.ogTitle !== null && title && !sameWording(page.ogTitle, title)) {
		findings.push({
			level: "worth a look",
			message: "The title shown when this page is shared is out of step with the page title.",
			detail: `Shared as: ${page.ogTitle}`,
			fix: "The og:title line in the page's code still says the old wording. Editing the title here and publishing brings it back into step automatically; otherwise it needs changing in the code.",
		});
	}
	if (
		page.ogDescription !== undefined &&
		page.ogDescription !== null &&
		description &&
		!sameWording(page.ogDescription, description)
	) {
		findings.push({
			level: "worth a look",
			message: "The description shown when this page is shared is out of step with the page description.",
			detail: `Shared as: ${page.ogDescription}`,
			fix: "The og:description line in the page's code still says the old wording. Editing the description here and publishing brings it back into step automatically; otherwise it needs changing in the code.",
		});
	}
	if (page.hasOgImage === false) {
		findings.push({
			level: "worth a look",
			message: "No picture is set for when this page is shared to Facebook or a group chat.",
			fix: "An og:image line in the page's code names the picture a share shows. Without one the share is plain text, which gets fewer clicks. Worth passing to whoever maintains the site.",
		});
	}

	// Structured data. Every page here carries it, so a block that no longer
	// parses is a regression, not a style point -- Google silently ignores
	// broken JSON-LD, ratings stars and all.
	if (typeof page.schemaBroken === "number" && page.schemaBroken > 0) {
		findings.push({
			level: "problem",
			message: `${page.schemaBroken} structured-data ${page.schemaBroken === 1 ? "block" : "blocks"} on this page ${page.schemaBroken === 1 ? "does" : "do"} not parse, so Google ignores ${page.schemaBroken === 1 ? "it" : "them"} completely.`,
			fix: "Structured data is the code block that gives Google the business details and star ratings. A stray comma is enough to break one. Worth passing to whoever maintains the site.",
		});
	} else if (typeof page.schemaBlocks === "number" && page.schemaBlocks === 0) {
		findings.push({
			level: "worth a look",
			message: "This page carries no structured data, while the rest of the site does.",
			fix: "Structured data is how the business details and review stars reach Google. Every other page here includes it, so a page without it is probably missing the shared block. Worth passing to whoever maintains the site.",
		});
	}

	if (typeof page.wordCount === "number" && page.wordCount < BODY_WORDS_MIN) {
		findings.push({
			level: "worth a look",
			message: `The page has only ${page.wordCount} words of body text — thin for Google to rank on.`,
			fix: "Fine for a page that exists to do a job, like a thank-you page. For a page meant to be found, a couple of honest paragraphs about the service and the suburb give Google something to work with.",
		});
	}

	const order = { problem: 0, "worth a look": 1, good: 2 };
	return findings.sort((a, b) => order[a.level] - order[b.level]);
}

// The canonical tag, checked against the page it sits on. Presence is handled
// by the caller; this is about where it points.
function checkCanonical(href, path, origin) {
	const normalise = (value) => String(value || "").replace(/\/+$/, "") || "/";
	let canonical;
	try {
		canonical = new URL(href, origin || "https://www.tcbpestcontrolcanberra.com.au");
	} catch {
		return [
			{
				level: "problem",
				message: "The canonical tag is not a valid address.",
				detail: href,
				fix: "The canonical line in the page's code should hold this page's full https address. Worth passing to whoever maintains the site.",
			},
		];
	}

	let originHost = "";
	try {
		originHost = new URL(origin || "").host;
	} catch {
		// No origin to compare against; the canonical domain check still runs.
	}

	// Pages here canonicalise to the production domain even when served from a
	// preview, so the production host is always acceptable; the serving host
	// covers local and staging setups.
	if (SITE_HOST.test(canonical.hostname) && canonical.protocol !== "https:") {
		return [
			{
				level: "problem",
				message: "The canonical tag points at the insecure http:// version of the site.",
				detail: href,
				fix: "It should say https://. As written it tells Google the real page is the one visitors get redirected away from.",
			},
		];
	}
	if (!SITE_HOST.test(canonical.hostname) && canonical.host !== originHost) {
		return [
			{
				level: "problem",
				message: "The canonical tag points at a different site.",
				detail: href,
				fix: "It tells Google another domain owns this content, which hands the ranking away. It should hold this page's own address.",
			},
		];
	}
	if (normalise(canonical.pathname) !== normalise(path)) {
		return [
			{
				level: "problem",
				message: `The canonical tag points at ${normalise(canonical.pathname)} instead of this page.`,
				detail: href,
				fix: "Google treats the canonical as the real address and may drop this page in favour of that one. Usually a copy-paste from another page's code. Worth passing to whoever maintains the site.",
			},
		];
	}
	return [];
}

// How the page is likely to appear in a result, so length limits mean
// something concrete rather than being a number to trust.
//
// The title is trimmed by estimated width rather than by count, because that
// is how Google trims it -- see TITLE_MAX_PX. Descriptions stay character
// based; nothing about their display is stable enough to measure in pixels.
export function googlePreview(page, origin = "https://www.tcbpestcontrolcanberra.com.au", path = "/") {
	const title = String(page.title || "").trim();
	const description = String(page.description || "").trim();
	const titleTruncated = titleWidth(title) > TITLE_MAX_PX || title.length > TITLE_MAX;
	return {
		title: titleTruncated ? `${cutToWidth(title, TITLE_MAX_PX - characterWidth("…")).trimEnd()}…` : title,
		url: `${origin.replace(/^https?:\/\//, "")}${path === "/" ? "" : path}`,
		description:
			description.length > DESCRIPTION_MAX
				? `${description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
				: description,
		titleTruncated,
		descriptionTruncated: description.length > DESCRIPTION_MAX,
	};
}

// Gathers what checkSeo needs from a live document. Kept apart from the
// checks themselves so those stay testable without a browser.
//
// The link text collected here is the link's accessible name, not just its
// inner text: aria-label and the alt of any image inside count, or an icon
// link with a perfectly good label would be flagged as nameless.
export function summarisePage(doc, ignoreSelector) {
	const visible = (element) => !ignoreSelector || !element.closest(ignoreSelector);
	const attribute = (selector, name) => {
		const element = doc.querySelector(selector);
		return element ? element.getAttribute(name) : null;
	};

	const schema = analyseSchema(
		[...doc.querySelectorAll('script[type="application/ld+json"]')].map((block) => block.textContent || "")
	);

	const h1s = [...doc.querySelectorAll("h1")].filter(visible);

	return {
		title: doc.title,
		description: attribute('meta[name="description"]', "content") || "",
		h1Count: h1s.length,
		h1: h1s.length ? h1s[0].textContent.replace(/\s+/g, " ").trim() : "",
		images: [...doc.querySelectorAll("img")]
			.filter(visible)
			.map((image) => ({ src: image.getAttribute("src"), hasAlt: image.hasAttribute("alt"), altText: image.getAttribute("alt") })),
		links: [...doc.querySelectorAll("a[href]")]
			.filter(visible)
			.map((link) => ({
				href: link.getAttribute("href"),
				text: [
					link.textContent,
					link.getAttribute("aria-label") || "",
					...[...link.querySelectorAll("img")].map((image) => image.getAttribute("alt") || ""),
				].join(" "),
			})),
		hasCanonical: !!doc.querySelector('link[rel="canonical"]'),
		canonicalHref: attribute('link[rel="canonical"]', "href"),
		robots: attribute('meta[name="robots"]', "content"),
		ogTitle: attribute('meta[property="og:title"]', "content"),
		ogDescription: attribute('meta[property="og:description"]', "content"),
		hasOgImage: !!doc.querySelector('meta[property="og:image"]'),
		wordCount: countWords(
			[...doc.querySelectorAll("p, h2, li")]
				.filter(visible)
				.map((element) => element.textContent)
				.join(" ")
		),
		...schema,
	};
}

export function countWords(text) {
	return String(text || "").split(/\s+/).filter(Boolean).length;
}
