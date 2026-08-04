// Unit tests for the pure pricing helpers in src/booking-config.js -- the
// only place a price is actually decided (server-authoritative; the front
// end only displays what these return). Run with:
//   node --test test/pricing.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { getModifierType, computePrice } from "../src/booking-config.js";

test("getModifierType returns the right follow-up type per service", () => {
	assert.equal(getModifierType("general-pest"), "bedrooms");
	assert.equal(getModifierType("ants-spiders-roaches"), "bedrooms");
	assert.equal(getModifierType("termite-inspection"), "property");
	assert.equal(getModifierType("rodents"), "none");
	assert.equal(getModifierType("wasps-bees"), "none");
});

test("getModifierType defaults to 'none' for an unknown service key", () => {
	assert.equal(getModifierType("not-a-real-service"), "none");
});

test("computePrice: flat 'none' services ignore the modifier value", () => {
	assert.deepEqual(computePrice("rodents", ""), { ok: true, amount: 289, modifierLabel: "" });
	assert.deepEqual(computePrice("wasps-bees", "anything"), { ok: true, amount: 289, modifierLabel: "" });
});

test("computePrice: bedrooms tiers resolve to the right fixed price and en-dash label", () => {
	assert.deepEqual(computePrice("general-pest", "1-3"), { ok: true, amount: 249, modifierLabel: "1–3 bedrooms" });
	assert.deepEqual(computePrice("general-pest", "4-5"), { ok: true, amount: 289, modifierLabel: "4–5 bedrooms" });
	assert.deepEqual(computePrice("general-pest", "6+"), { ok: true, amount: 349, modifierLabel: "6 or more bedrooms" });
	// Same table as general-pest, per the brief.
	assert.deepEqual(computePrice("ants-spiders-roaches", "4-5"), { ok: true, amount: 289, modifierLabel: "4–5 bedrooms" });
});

test("computePrice: termite-inspection property tiers", () => {
	assert.deepEqual(computePrice("termite-inspection", "subfloor"), { ok: true, amount: 320, modifierLabel: "With subfloor" });
	assert.deepEqual(computePrice("termite-inspection", "slab"), { ok: true, amount: 289, modifierLabel: "On a slab (no subfloor)" });
});

test("computePrice: missing or invalid modifier value fails rather than guessing", () => {
	assert.deepEqual(computePrice("general-pest", ""), { ok: false });
	assert.deepEqual(computePrice("general-pest", "not-a-tier"), { ok: false });
	assert.deepEqual(computePrice("termite-inspection", ""), { ok: false });
	assert.deepEqual(computePrice("termite-inspection", "1-3"), { ok: false }); // wrong table's value
});

test("computePrice: unknown service key fails", () => {
	assert.deepEqual(computePrice("not-a-real-service", "1-3"), { ok: false });
});
