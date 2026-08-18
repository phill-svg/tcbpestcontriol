// The rules around creating a service page, without touching GitHub.
//
// validateServicePage is the gate. A service page lives at the top level --
// /borer-control, alongside /ant-control -- so a bad address there is not a
// tidy-up job, it is a page at the wrong URL on a live site, with a canonical
// tag and a sitemap entry pointing at it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateServicePage, serviceSlug, isSlug } from "../src/service-api.js";

const GOOD = {
	slug: "borer-control",
	title: "Borer Control Canberra | TCB Pest Control",
	description: "Borer in Canberra floorboards and roof timbers.",
	serviceName: "Borer Control",
	heroImage: "pest-termite-macro.webp",
	sections: [{ eyebrow: "Species", heading: "The borers.", paragraphs: ["Lyctus favours hardwood."] }],
};

test("a complete page is accepted, and keeps the address it was given", () => {
	const { errors, page } = validateServicePage(GOOD);
	assert.equal(errors, undefined);
	assert.equal(page.slug, "borer-control");
});

test("an address is derived from the service name when none is given", () => {
	const { page } = validateServicePage({ ...GOOD, slug: "" });
	assert.equal(page.slug, "borer-control");
});

test("an address that is not a web address is refused", () => {
	// These would each produce a live page at a URL nobody intended, with a
	// canonical tag agreeing with it.
	for (const slug of ["Borer Control", "borer control", "/borer-control", "borer_control", "borer--control", "-borer"]) {
		const { errors } = validateServicePage({ ...GOOD, slug });
		assert.ok(errors, `${slug} should not be accepted`);
	}
});

test("the blog namespace is not available to a service page", () => {
	// Blog posts live under blog- and are listed from a table. A service page
	// squatting there would appear in the blog index and nowhere sensible.
	const { errors } = validateServicePage({ ...GOOD, slug: "blog-borer-control" });
	assert.match(errors.join(" "), /reserved for blog posts/);
});

test("a page with nothing on it is refused", () => {
	// Every one of these ends up in the markup or the schema, and a page
	// missing any of them is not a page worth committing.
	for (const field of ["title", "description", "serviceName", "heroImage"]) {
		const { errors } = validateServicePage({ ...GOOD, [field]: "" });
		assert.ok(errors, `a page with no ${field} should be refused`);
	}
	assert.ok(validateServicePage({ ...GOOD, sections: [] }).errors, "a page with no sections is not a page");
});

test("every missing field is named at once, not one per attempt", () => {
	// Being told "the page needs a title", fixing it, and then being told it
	// needs a description is a worse experience than being told both.
	const { errors } = validateServicePage({ slug: "borer-control" });
	assert.ok(errors.length >= 4, `expected several, got ${errors.length}`);
});

test("the address is derived without the blog prefix", () => {
	// blog-posts.js's slugify prefixes every address with "blog-", because
	// that is what a blog post's address is. Borrowing it here produced
	// /blog-borer-control: a service page filed as a blog post, at an address
	// this module's own validator then refuses.
	assert.equal(serviceSlug("Borer Control"), "borer-control");
	assert.equal(serviceSlug("Borer & Timber Pests"), "borer-timber-pests");
	assert.ok(!serviceSlug("Borer Control").startsWith("blog-"));
});

test("the address check is linear, and still says the same thing", () => {
	// Replaced /^[a-z0-9]+(?:-[a-z0-9]+)*$/, which pairs two quantifiers in a
	// way that can backtrack. Not a live risk here -- about a millisecond on a
	// 40KB input, behind an admin-only endpoint -- but a linear check is free.
	// These pin that the rewrite kept the meaning.
	for (const good of ["borer-control", "borer", "a1-b2", "pre-purchase-inspections"]) {
		assert.ok(isSlug(good), `${good} should be a valid address`);
	}
	for (const bad of ["borer--control", "-borer", "borer-", "Borer", "borer control", "borer_control", "", "borer/control"]) {
		assert.ok(!isSlug(bad), `${bad} should not be a valid address`);
	}
	// A path on the site, not a paragraph.
	assert.ok(!isSlug("a".repeat(81)));
});
