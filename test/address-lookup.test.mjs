// Unit tests for the booking form's address lookup: turning an OpenStreetMap
// (Photon) result into street/suburb/postcode, and putting the three fields
// back together into the one line ServiceM8 and the emails get.
// Run with:  node --test test/address-lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePhotonFeature, stateForPostcode } from "../src/address-lookup.js";
import { composeAddress, validateBookingFields } from "../src/booking.js";

// Trimmed from real Photon (OpenStreetMap) responses for Canberra queries.
const feat = (props) => ({ type: "Feature", properties: { countrycode: "AU", ...props } });
const weetangera = feat({ osm_type: "W", osm_id: 921885371, type: "house", housenumber: "12", street: "Smith Street", district: "Weetangera", city: "Belconnen", state: "Australian Capital Territory", postcode: "2614" });
const lonsdale = feat({ osm_type: "W", osm_id: 1096468598, type: "street", name: "Lonsdale Street", district: "Braddon", city: "North Canberra", state: "Australian Capital Territory", postcode: "2612" });
const busStop = feat({ osm_type: "N", osm_id: 13011316092, osm_key: "highway", osm_value: "bus_stop", type: "house", name: "Crawford St before Campbell St", street: "Crawford Street", district: "Queanbeyan", city: "Queanbeyan", state: "New South Wales", postcode: "2620" });

test("an ACT house takes its suburb from district, not the town centre", () => {
	assert.deepEqual(parsePhotonFeature(weetangera, "12 smith st"), {
		id: "W921885371",
		text: "12 Smith Street, Weetangera ACT 2614",
		street: "12 Smith Street",
		suburb: "Weetangera",
		state: "ACT",
		postcode: "2614",
	});
});

test("a street-only match keeps the house number the customer typed", () => {
	const got = parsePhotonFeature(lonsdale, "20 Lonsdale St Braddon");
	assert.equal(got.street, "20 Lonsdale Street");
	assert.equal(got.text, "20 Lonsdale Street, Braddon ACT 2612");
});

test("unit numbers typed as 4/20 are kept too", () => {
	assert.equal(parsePhotonFeature(lonsdale, "4/20 lonsdale").street, "4/20 Lonsdale Street");
});

test("a street-only match with no typed number is just the street", () => {
	assert.equal(parsePhotonFeature(lonsdale, "lonsdale st").street, "Lonsdale Street");
});

test("Queanbeyan comes back as NSW", () => {
	const house = feat({ osm_type: "N", osm_id: 1, type: "house", housenumber: "3", street: "Crawford Street", district: "Queanbeyan", city: "Queanbeyan", state: "New South Wales", postcode: "2620" });
	const got = parsePhotonFeature(house, "3 crawford");
	assert.equal(got.state, "NSW");
	assert.equal(got.text, "3 Crawford Street, Queanbeyan NSW 2620");
});

test("a different house on the same street takes the number the customer typed", () => {
	const house94 = feat({ osm_type: "N", osm_id: 2, type: "house", housenumber: "94", street: "Crawford Street", district: "Queanbeyan", state: "New South Wales", postcode: "2620" });
	assert.equal(parsePhotonFeature(house94, "3 Crawford St Queanbeyan").text, "3 Crawford Street, Queanbeyan NSW 2620");
});

test("with no typed number, a house keeps its own number", () => {
	assert.equal(parsePhotonFeature(weetangera, "smith street weet").street, "12 Smith Street");
});

test("bus stops and other places with no house number are dropped", () => {
	assert.equal(parsePhotonFeature(busStop, "3 crawford st"), null);
});

test("results outside Australia are dropped", () => {
	assert.equal(parsePhotonFeature({ properties: { ...weetangera.properties, countrycode: "TT" } }, "12 smith"), null);
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
