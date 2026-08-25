// Building a service page — the pest pages under "Pests We Treat".
//
// Kept apart from src/service-api.js on purpose, the same way src/blog-posts.js
// is kept apart from src/blog-api.js: this module is pure string work with no
// I/O, which is what makes the generated markup straightforward to test.
//
// The template is _service-template.html, derived mechanically from
// ant-control/index.html rather than written by hand. That matters. A service
// page on this site is 484 lines carrying a ProfessionalService block, a
// Service block, a BreadcrumbList, an FAQPage, opening hours, a geo circle and
// a postal address -- and a hand-copied approximation of all that would be
// subtly wrong in ways nobody would notice until Google did. Deriving it means
// the chrome is the real chrome, and only the wording is new.

import { escapeHtml, findUnfilledPlaceholders } from "./blog-posts.js";

const SITE = "https://www.tcbpestcontrolcanberra.com.au";

// The arrow that follows every link in the related-services strip.
// Points at the shared sprite, like every other icon on the site -- see
// scripts/build-icon-sprite.js. Generated pages have to match the hand-written
// ones or that script would find inline icons to convert every time it runs.
const ARROW =
	'<svg aria-hidden="true" class="icon-line icon" height="24" viewbox="0 0 24 24" width="24">' +
	'<use href="/assets/icons.svg?v=1#arrow-up-right"></use></svg>';

const pad = (n) => String(n).padStart(2, "0");

// Body sections. Prose rather than the icon-card grids the hand-written pages
// use: a card grid needs an icon chosen per card, and an icon chosen badly is
// more distracting than no icon at all. The eyebrow numbering matches the rest
// of the site so a generated page does not announce itself as generated.
export function renderSections(sections = []) {
	return sections
		.map((section, at) => {
			const soft = at % 2 === 1 ? " bg-soft" : "";
			const paragraphs = (section.paragraphs || [])
				.filter(Boolean)
				.map((text) => `<p>${escapeHtml(text)}</p>`)
				.join("");
			return (
				`<section class="section${soft}"><div class="container">` +
				`<div class="section-eyebrow mono">[${pad(at + 1)}] ${escapeHtml(section.eyebrow || "Detail")}</div>` +
				`<h2 class="section-title display">${escapeHtml(section.heading || "")}</h2>` +
				`<div class="prose">${paragraphs}</div>` +
				`</div></section>`
			);
		})
		.join("\n");
}

export function renderFaqSection(faqs = [], { heading = "The questions Canberra households ask first.", after = 3 } = {}) {
	if (!faqs.length) return "";
	const cards = faqs
		.map(
			(faq, at) =>
				`<div class="grid-card"><div class="step-num">[FAQ- ${pad(at + 1)} ]</div>` +
				`<h3 class="display">${escapeHtml(faq.question)}</h3><p>${escapeHtml(faq.answer)}</p></div>`
		)
		.join("");
	return (
		`<section class="section bg-soft"><div class="container">` +
		// Numbered after the sections it follows, not at a fixed [04] -- the
		// hand-written pages happen to have three sections and a generated one
		// may not, and an eyebrow that skips a number reads as a missing section.
		`<div class="section-eyebrow mono">[${pad(after + 1)}] FAQ</div>` +
		`<h2 class="section-title display">${escapeHtml(heading)}</h2>` +
		`<div class="grid-cards cols-3">${cards}</div></div></section>`
	);
}

// The FAQPage block. Written from the same questions the page displays, which
// is the only thing that makes it honest -- schema describing answers a reader
// cannot find on the page is what Google calls mismatched structured data.
export function renderFaqSchema(faqs = []) {
	if (!faqs.length) return "";
	const payload = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: { "@type": "Answer", text: faq.answer },
		})),
	};
	return `<script type="application/ld+json">\n${JSON.stringify(payload, null, 2)}\n</script>`;
}

export function renderRelatedLinks(related = []) {
	if (!related.length) return "";
	const links = related
		.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}${ARROW}</a>`)
		.join("");
	return (
		`<section class="section compact"><div class="container"><div class="link-strip">` +
		`<span class="section-eyebrow mono" style="margin-right:0.5rem;">[Related services]</span>` +
		`${links}</div></div></section>`
	);
}

// Everything the template needs, in one place, so a field the template gained
// and this does not fill is caught by findUnfilledPlaceholders rather than
// shipped to a reader as a literal {{PLACEHOLDER}}.
export function renderServicePage(template, page, { draft = true } = {}) {
	const values = {
		SLUG: page.slug,
		PAGE_TITLE: page.title,
		META_DESCRIPTION: page.description,
		PAGE_HEADING: `${escapeHtml(page.headingLead || page.serviceName)} <span class="accent">${escapeHtml(page.headingAccent || "in Canberra")}</span>.`,
		HERO_EYEBROW: `TCB · ${page.serviceName} Canberra`,
		HERO_LEAD: escapeHtml(page.heroLead || ""),
		HERO_IMAGE: page.heroImage,
		HERO_IMAGE_SM: page.heroImageSmall || page.heroImage,
		HERO_IMAGE_ALT: page.heroImageAlt || "",
		SERVICE_NAME: page.serviceName,
		SERVICE_TYPE: page.serviceType || page.serviceName,
		BANNER_HEADING: page.bannerHeading || `${page.serviceName} in Canberra today`,
		BANNER_TEXT: escapeHtml(page.bannerText || ""),
		CTA_HEADING: page.ctaHeading || `Book ${String(page.serviceName).toLowerCase()} today.`,
		CONTENT_SECTIONS: renderSections(page.sections),
		FAQ_SECTION: renderFaqSection(page.faqs, {
			after: (page.sections || []).length,
			...(page.faqHeading ? { heading: page.faqHeading } : {}),
		}),
		FAQ_SCHEMA: renderFaqSchema(page.faqs),
		RELATED_LINKS: renderRelatedLinks(page.related),
	};

	let html = template;
	for (const [key, value] of Object.entries(values)) {
		// Split/join rather than replace, which only takes the first match --
		// the slug alone appears six times.
		html = html.split(`{{${key}}}`).join(value === undefined || value === null ? "" : String(value));
	}

	// Reachable at its URL so it can be read and edited in place, but not
	// indexed while it is still being written.
	if (draft) html = html.replace("</head>", `<meta name="robots" content="noindex"/>\n</head>`);
	return html;
}

export { findUnfilledPlaceholders };

// The canonical URL a slug will live at, for the sitemap and the checks.
export const urlFor = (slug) => `${SITE}/${slug}`;
