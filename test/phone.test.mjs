// Unit tests for the phone helpers in src/servicem8.js. These decide what a
// customer's number LOOKS like on their ServiceM8 client card (auPhone) and
// whether two spellings of the same number count as the same customer
// (phoneKey, which drives dedup). Run with:
//   node --test test/phone.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { auPhone, phoneKey } from "../src/servicem8.js";

test("auPhone writes AU mobiles in national 04 format", () => {
	assert.equal(auPhone("0412345678"), "0412345678");
	assert.equal(auPhone("0412 345 678"), "0412345678");
	assert.equal(auPhone("+61 412 345 678"), "0412345678");
	assert.equal(auPhone("61412345678"), "0412345678");
	assert.equal(auPhone("412345678"), "0412345678");
	assert.equal(auPhone("(04) 1234-5678"), "0412345678");
});

test("auPhone handles Canberra landlines the same way", () => {
	assert.equal(auPhone("02 6105 9771"), "0261059771");
	assert.equal(auPhone("+61 2 6105 9771"), "0261059771");
});

test("auPhone leaves an empty or unusable number alone rather than inventing one", () => {
	assert.equal(auPhone(""), "");
	assert.equal(auPhone(null), "");
	assert.equal(auPhone(undefined), "");
	// Too short to be a national number -- kept as typed, not prefixed with 0.
	assert.equal(auPhone("61059771"), "61059771");
});

test("phoneKey treats every spelling of one number as the same customer", () => {
	const spellings = ["0412345678", "0412 345 678", "+61 412 345 678", "61412345678", "412345678", "(0412) 345-678"];
	const keys = new Set(spellings.map(phoneKey));
	assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(", ")}`);
	assert.equal(phoneKey("0412345678"), "412345678");
});

test("phoneKey keeps different numbers apart", () => {
	assert.notEqual(phoneKey("0412345678"), phoneKey("0412345679"));
	assert.notEqual(phoneKey("0412345678"), phoneKey("0261059771"));
});

test("phoneKey only strips a country code from a full-length number", () => {
	// "61059771" is a landline typed without its area code, not 61 + national.
	// Stripping "61" there would corrupt it into a different number.
	assert.equal(phoneKey("61059771"), "61059771");
	assert.equal(phoneKey("61412345678"), "412345678");
});
