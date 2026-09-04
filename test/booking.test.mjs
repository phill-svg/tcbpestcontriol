// Unit tests for the pure helpers in the booking pipeline. Only the
// deterministic, network-free helper is covered here -- the scheduled-slot
// D1/ServiceM8 flow needs live bindings and is self-reviewed rather than
// mocked into a vacuous test. Run with:  node --test test/booking.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatConfirmedTime } from "../src/booking.js";
import { badgeField } from "../src/servicem8.js";
import { SERVICE_BADGES } from "../src/booking-config.js";
import { msToSydneyParts, sydneyLocalToMs } from "../src/availability.js";

test("anchor sanity: 2026-08-11 09:00 really is a Sydney Tuesday", () => {
	assert.equal(msToSydneyParts(sydneyLocalToMs(2026, 8, 11, 9, 0)).weekday, 2);
});

test("formats a Sydney-local slot start as a friendly confirmed time (AEST)", () => {
	assert.equal(formatConfirmedTime("2026-08-11 09:00:00"), "Tue 11 Aug 2026, 9:00 AM");
});

test("uses 12-hour clock with an uppercase period for the afternoon", () => {
	assert.equal(formatConfirmedTime("2026-08-11 14:30:00"), "Tue 11 Aug 2026, 2:30 PM");
});

test("noon and midnight read as PM/AM, not 0:00", () => {
	assert.equal(formatConfirmedTime("2026-08-11 12:00:00"), "Tue 11 Aug 2026, 12:00 PM");
	assert.equal(formatConfirmedTime("2026-08-11 00:00:00"), "Tue 11 Aug 2026, 12:00 AM");
});

test("stays correct across DST -- a January slot is AEDT (+11), not AEST", () => {
	// 2026-01-13 is a Tuesday in Sydney, deep in daylight-saving (AEDT). The
	// display is driven off the Sydney wall clock, so the hour must read exactly
	// what was booked regardless of the +11 offset.
	assert.equal(msToSydneyParts(sydneyLocalToMs(2026, 1, 13, 9, 0)).weekday, 2);
	assert.equal(formatConfirmedTime("2026-01-13 09:00:00"), "Tue 13 Jan 2026, 9:00 AM");
});

test("returns empty string for anything that isn't the expected shape", () => {
	assert.equal(formatConfirmedTime(""), "");
	assert.equal(formatConfirmedTime(null), "");
	assert.equal(formatConfirmedTime(undefined), "");
	assert.equal(formatConfirmedTime("2026-08-11T09:00:00"), ""); // ISO 'T', not our space form
	assert.equal(formatConfirmedTime("not a date"), "");
});

// --- badges -----------------------------------------------------------------
//
// SERVICE_BADGES sat empty and unread for a week while a comment claimed it was
// wired in, so these guard the shape rather than the values: the map itself is
// config the office edits, but how it reaches ServiceM8 is code.

test("encodes badge uuids as a JSON string, not a bare array", () => {
	// ServiceM8 stores the field JSON-encoded. Sending the raw array is what the
	// original wiring did, and it does not take.
	assert.deepEqual(badgeField(["uuid-a"]), { badges: '["uuid-a"]' });
	assert.deepEqual(badgeField(["uuid-a", "uuid-b"]), { badges: '["uuid-a","uuid-b"]' });
});

test("no badges omits the field entirely rather than clearing existing ones", () => {
	// The distinction matters: `{badges: "[]"}` would strip badges the client
	// card had already applied to the job. An absent key leaves them alone.
	for (const empty of [[], undefined, null]) {
		assert.deepEqual(badgeField(empty), {}, `expected {} for ${JSON.stringify(empty)}`);
	}
});

test("an unmapped service yields no badges rather than throwing", () => {
	// SERVICE_BADGES[unknownKey] is undefined, and that path must stay quiet --
	// a service with no badge mapping is normal, not an error.
	assert.deepEqual(badgeField(SERVICE_BADGES["not-a-service"]), {});
});

test("every uuid in SERVICE_BADGES is a real badge uuid, not a name", () => {
	// The ServiceM8 API takes uuids only; a badge NAME is silently ignored, which
	// would look exactly like the bug this all started with.
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	for (const [service, badges] of Object.entries(SERVICE_BADGES)) {
		assert.ok(Array.isArray(badges), `${service} must map to an array of uuids`);
		for (const uuid of badges) assert.match(uuid, UUID, `${service} has a non-uuid badge: ${uuid}`);
	}
});
