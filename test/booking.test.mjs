// Unit tests for the pure helpers in the booking pipeline. Only the
// deterministic, network-free helper is covered here -- the scheduled-slot
// D1/ServiceM8 flow needs live bindings and is self-reviewed rather than
// mocked into a vacuous test. Run with:  node --test test/booking.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatConfirmedTime } from "../src/booking.js";
import { badgeField } from "../src/servicem8.js";
import {
	SERVICES,
	SERVICE_BADGES,
	SERVICE_CATEGORIES,
	SERVICE_DURATIONS,
	SERVICE_LABELS,
	SERVICE_TEMPLATES,
	WEBSITE_BOOKING_BADGES,
	isBookableService,
} from "../src/booking-config.js";
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

// --- service definitions ----------------------------------------------------
//
// These guard completeness, not values. `termite-treatment` had a template but
// no category for a week because the maps were separate objects and nothing
// checked they lined up; SERVICES is one row per service so that a gap shows,
// and this fails if one is left half-filled.

test("every bookable service is fully defined", () => {
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const keys = Object.keys(SERVICES);
	assert.ok(keys.length, "SERVICES must not be empty");

	for (const [key, svc] of Object.entries(SERVICES)) {
		assert.ok(svc.label && typeof svc.label === "string", `${key} needs a label`);
		assert.ok(Number.isFinite(svc.durationMin) && svc.durationMin > 0, `${key} needs a positive durationMin`);
		assert.ok(Array.isArray(svc.badges), `${key} badges must be an array (use [] for none)`);
		// null is allowed and means "no such record in ServiceM8" -- but a
		// present value must be a real uuid, never a name.
		for (const field of ["category", "template"]) {
			if (svc[field] == null) continue;
			assert.match(svc[field], UUID, `${key}.${field} must be a uuid, got: ${svc[field]}`);
		}
	}
});

test("a service that files under a category also has one to file under", () => {
	// The specific gap that shipped: a template with no category meant the job
	// arrived uncategorised while every other service matched the office's own
	// filing. Treated as required now -- drop the service from SERVICES rather
	// than leaving it half-mapped.
	for (const [key, svc] of Object.entries(SERVICES)) {
		assert.ok(svc.category, `${key} has no ServiceM8 category -- an online booking would land uncategorised`);
	}
});

test("the derived lookups agree with the table they come from", () => {
	// The rest of the code reads the projections, not SERVICES, so a broken
	// projection would silently un-map every service.
	for (const [key, svc] of Object.entries(SERVICES)) {
		assert.equal(SERVICE_DURATIONS[key], svc.durationMin);
		assert.equal(SERVICE_LABELS[key], svc.label);
		assert.equal(SERVICE_CATEGORIES[key], svc.category);
		assert.equal(SERVICE_TEMPLATES[key], svc.template);
		assert.deepEqual(SERVICE_BADGES[key], svc.badges);
	}
	assert.deepEqual(Object.keys(SERVICE_DURATIONS), Object.keys(SERVICES));
});

test("isBookableService accepts every defined service and nothing else", () => {
	for (const key of Object.keys(SERVICES)) assert.ok(isBookableService(key), `${key} should be bookable`);
	for (const key of ["", "possums", "general pest", "__proto__"]) {
		assert.equal(isBookableService(key), false, `${key} must not be bookable`);
	}
});

test("every service carries the shared website booking badges", () => {
	// The four are about the booking rather than the pest, so all six get them.
	// Asserted against the shared list rather than a copy, so adding a fifth
	// badge does not need this test edited.
	for (const key of Object.keys(SERVICES)) {
		assert.deepEqual(SERVICE_BADGES[key], WEBSITE_BOOKING_BADGES, `${key} should carry the shared badges`);
	}
	assert.equal(WEBSITE_BOOKING_BADGES.length, 4);
});

test("the shared badge list is frozen, so one service cannot mutate the rest", () => {
	// All six rows share the one array. Without the freeze, a push here would
	// silently badge every other service too.
	assert.ok(Object.isFrozen(WEBSITE_BOOKING_BADGES));
	assert.throws(() => WEBSITE_BOOKING_BADGES.push("nope"), TypeError);
});

test("a booked service produces the JSON payload ServiceM8 expects", () => {
	// End to end through the projection: the table's uuids come out as the
	// encoded string that actually goes on the job.
	const { badges } = badgeField(SERVICE_BADGES["general-pest"]);
	assert.equal(typeof badges, "string");
	assert.deepEqual(JSON.parse(badges), [...WEBSITE_BOOKING_BADGES]);
});
