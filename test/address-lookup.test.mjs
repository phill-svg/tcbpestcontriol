// Unit tests for the booking form's address lookup: turning Google's
// addressComponents into street/suburb/postcode, and putting the three
// fields back together into the one line ServiceM8 and the emails get.
// Run with:  node --test test/address-lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAddressComponents, stateForPostcode } from "../src/address-lookup.js";
import { composeAddress, validateBookingFields } from "../src/booking.js";

const comp = (type, longText, shortText = longText) => ({ types: [type], longText, shortText });

test("parses a plain Canberra house address", () => {
	const got = parseAddressComponents([
		comp("street_number", "12"),
		comp("route", "Smith Street", "Smith St"),
		comp("locality", "Kambah"),
		comp("administrative_area_level_1", "Australian Capital Territory", "ACT"),
		comp("postal_code", "2902"),
	]);
	assert.deepEqual(got, { street: "12 Smith Street", suburb: "Kambah", state: "ACT", postcode: "2902" });
});

test("puts a unit number in front of the street number", () => {
	const got = parseAddressComponents([
		comp("subpremise", "4"),
		comp("street_number", "20"),
		comp("route", "Lonsdale Street"),
		comp("locality", "Braddon"),
		comp("administrative_area_level_1", "Australian Capital Territory", "ACT"),
		comp("postal_code", "2612"),
	]);
	assert.equal(got.street, "4/20 Lonsdale Street");
});

test("a street with no number still gives the street name", () => {
	const got = parseAddressComponents([comp("route", "Monaro Highway"), comp("locality", "Hume")]);
	assert.deepEqual(got, { street: "Monaro Highway", suburb: "Hume", state: "", postcode: "" });
});

test("NSW suburbs keep their own state", () => {
	const got = parseAddressComponents([
		comp("street_number", "3"),
		comp("route", "Crawford Street"),
		comp("locality", "Queanbeyan"),
		comp("administrative_area_level_1", "New South Wales", "NSW"),
		comp("postal_code", "2620"),
	]);
	assert.equal(got.state, "NSW");
	assert.equal(got.suburb, "Queanbeyan");
});

test("empty or missing components give empty fields, not a crash", () => {
	assert.deepEqual(parseAddressComponents(undefined), { street: "", suburb: "", state: "", postcode: "" });
});

test("works out ACT or NSW from the postcode", () => {
	assert.equal(stateForPostcode("2600"), "ACT");
	assert.equal(stateForPostcode("2618"), "ACT");
	assert.equal(stateForPostcode("2902"), "ACT");
	assert.equal(stateForPostcode("2914"), "ACT");
	assert.equal(stateForPostcode("2620"), "NSW");
	assert.equal(stateForPostcode("2619"), "NSW");
	assert.equal(stateForPostcode("2621"), "NSW");
});

test("joins street, suburb and postcode into one line with the state", () => {
	assert.equal(composeAddress({ address: "12 Smith Street", suburb: "Kambah", postcode: "2902" }), "12 Smith Street, Kambah ACT 2902");
	assert.equal(composeAddress({ address: "3 Crawford Street", suburb: "Queanbeyan", postcode: "2620" }), "3 Crawford Street, Queanbeyan NSW 2620");
});

test("an old-style single address line passes through unchanged", () => {
	assert.equal(composeAddress({ address: "12 Smith St, Kambah" }), "12 Smith St, Kambah");
});

const base = { name: "Sam", email: "sam@example.com", phone: "0412345678", address: "12 Smith Street", service: "general-pest", message: "" };

test("booking needs a suburb when the form sends suburb and postcode", () => {
	const errors = validateBookingFields({ ...base, suburb: "", postcode: "2902" });
	assert.ok(errors.includes("Please enter the suburb."));
});

test("booking postcode must be four digits", () => {
	const errors = validateBookingFields({ ...base, suburb: "Kambah", postcode: "29" });
	assert.ok(errors.includes("Please enter a 4-digit postcode."));
});

test("a full address passes validation", () => {
	assert.deepEqual(validateBookingFields({ ...base, suburb: "Kambah", postcode: "2902" }), []);
});

test("callers that never send suburb/postcode still validate as before", () => {
	assert.deepEqual(validateBookingFields(base), []);
});
