// Unit tests for the booking availability engine -- pure logic, no network.
// Run with:  node --test test/availability.test.mjs
//
// All "now" values are built via our own sydneyLocalToMs (never Date.now()) so
// the tests are fully deterministic. Anchors self-verify their own weekday so a
// wrong calendar assumption fails loudly instead of silently.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	computeSlots,
	sydneyLocalToMs,
	msToSydneyParts,
	formatSydneyTimestamp,
	zonedOffsetMs,
	sydneyTodayYmd,
} from "../src/availability.js";

const MIN_MS = 60 * 1000;

// 2026-06-02 is a Tuesday in Sydney (AEST, +10, well clear of any DST edge).
// With "now" on Tuesday afternoon the next OPEN day is Wednesday 2026-06-03,
// so the Wednesday-shaped assertions live at days[0].
const NOW_TUE = sydneyLocalToMs(2026, 6, 2, 14, 0);
const WED = "2026-06-03";
const SAT = "2026-06-06";
const SUN = "2026-06-07";

const findDay = (result, date) => result.days.find((d) => d.date === date);
const startsOf = (day) => day.slots.map((s) => s.start);

test("anchor sanity: NOW_TUE really is a Sydney Tuesday", () => {
	assert.equal(msToSydneyParts(NOW_TUE).weekday, 2);
	assert.equal(sydneyTodayYmd(NOW_TUE), "2026-06-02");
});

test("empty occupancy, general-pest on a Wednesday: 08:00 grid, last start 15:00", () => {
	const result = computeSlots({ occupancy: [], service: "general-pest", nowMs: NOW_TUE });

	assert.equal(result.service, "general-pest");
	assert.equal(result.durationMinutes, 60);
	assert.equal(result.timezone, "Australia/Sydney");

	const wed = findDay(result, WED);
	assert.ok(wed, "Wednesday 2026-06-03 present");
	assert.equal(msToSydneyParts(sydneyLocalToMs(2026, 6, 3, 0, 0)).weekday, 3, "target day is a Wednesday");

	const starts = startsOf(wed);
	assert.equal(starts[0], "08:00", "first slot 08:00");
	assert.equal(starts[starts.length - 1], "15:00", "last start 15:00 (15:00+60=16:00 close)");

	// NOTE: brief prose said "17 slots", but its own anchors (first 08:00, last
	// start 15:00, 30-min grid) give (15:00-08:00)/30 + 1 = 15. 17 is the count
	// of grid points 08:00..16:00 ignoring the 60-min duration -- an arithmetic
	// slip in the brief. The algorithm as specified yields 15; we assert 15.
	assert.equal(wed.slots.length, 15);

	// Grid + shape spot-check.
	assert.deepEqual(wed.slots[0], {
		start: "08:00",
		end: "09:00",
		startIso: "2026-06-03 08:00:00",
		endIso: "2026-06-03 09:00:00",
	});
	assert.equal(wed.slots[1].start, "08:30");
});

test("Saturday: last start 11:00 (11:00+60=12:00 close); Sunday omitted", () => {
	const result = computeSlots({ occupancy: [], service: "general-pest", nowMs: NOW_TUE });

	const sat = findDay(result, SAT);
	assert.ok(sat, "Saturday 2026-06-06 present");
	assert.equal(msToSydneyParts(sydneyLocalToMs(2026, 6, 6, 0, 0)).weekday, 6, "target day is a Saturday");

	const starts = startsOf(sat);
	assert.equal(starts[0], "08:00");
	assert.equal(starts[starts.length - 1], "11:00");
	assert.equal(sat.slots.length, 7); // 08:00..11:00 inclusive on 30-min grid

	// Sunday is closed -> not present at all (per our rule: omit closed days).
	assert.equal(findDay(result, SUN), undefined, "Sunday omitted, not empty");
	assert.ok(
		result.days.every((d) => msToSydneyParts(sydneyLocalToMs(...d.date.split("-").map(Number), 0, 0)).weekday !== 0),
		"no returned day is a Sunday"
	);
});

test("buffer: a 10:00-10:30 block excludes 09:00/09:30/10:00/10:30", () => {
	// One busy block on the Wednesday, 10:00-10:30.
	const block = {
		startMs: sydneyLocalToMs(2026, 6, 3, 10, 0),
		endMs: sydneyLocalToMs(2026, 6, 3, 10, 30),
	};
	const result = computeSlots({ occupancy: [block], service: "general-pest", nowMs: NOW_TUE });
	const wed = findDay(result, WED);
	const starts = startsOf(wed);

	// Hand-computed with 15-min buffer on BOTH sides of the candidate:
	//   09:00 -> 09:00-10:00 buffered 08:45-10:15, block 10:00-10:30 -> overlaps
	//   09:30 -> 09:30-10:30 buffered 09:15-10:45 -> overlaps
	//   10:00 -> 10:00-11:00 buffered 09:45-11:15 -> overlaps
	//   10:30 -> 10:30-11:30 buffered 10:15-11:45 -> overlaps
	for (const excluded of ["09:00", "09:30", "10:00", "10:30"]) {
		assert.ok(!starts.includes(excluded), `${excluded} excluded by buffer`);
	}
	// Neighbours just outside the buffered block survive:
	//   08:30 -> 08:30-09:30 buffered 08:15-09:45 -> no overlap
	//   11:00 -> 11:00-12:00 buffered 10:45-12:15 -> no overlap
	assert.ok(starts.includes("08:00"), "08:00 offered");
	assert.ok(starts.includes("08:30"), "08:30 offered");
	assert.ok(starts.includes("11:00"), "11:00 offered");

	// 15 baseline minus the 4 buffered-out starts.
	assert.equal(wed.slots.length, 11);
});

test("no same-day: today never offered; earliest day is the next open day", () => {
	const result = computeSlots({ occupancy: [], service: "general-pest", nowMs: NOW_TUE });
	const today = sydneyTodayYmd(NOW_TUE);

	assert.ok(
		result.days.every((d) => d.date !== today),
		"Sydney-today is never returned"
	);
	assert.equal(result.days[0].date, WED, "earliest offered day is the next open day");
});

test("unknown service throws", () => {
	assert.throws(() => computeSlots({ occupancy: [], service: "not-a-service", nowMs: NOW_TUE }), /Unknown service/);
});

test("wasps-bees uses its 45-minute duration for the close check", () => {
	const result = computeSlots({ occupancy: [], service: "wasps-bees", nowMs: NOW_TUE });
	assert.equal(result.durationMinutes, 45);
	const wed = findDay(result, WED);
	// 08:00 grid, last start where start+45 <= 16:00 -> 15:00 (15:00+45=15:45<=16:00),
	// next would be 15:30+45=16:15 > 16:00. First slot ends 08:45.
	assert.equal(wed.slots[0].end, "08:45");
	assert.equal(wed.slots[wed.slots.length - 1].start, "15:00");
});

test("DST round-trip: wall-clock survives on both sides of a Sydney DST boundary", () => {
	// January is AEDT (+11), July is AEST (+10). A wall-clock time set in each
	// must format back to the exact same string, proving the offset is derived
	// from the instant, not hard-coded.
	const janMs = sydneyLocalToMs(2026, 1, 15, 12, 0);
	const julMs = sydneyLocalToMs(2026, 7, 15, 12, 0);

	assert.equal(formatSydneyTimestamp(janMs), "2026-01-15 12:00:00");
	assert.equal(formatSydneyTimestamp(julMs), "2026-07-15 12:00:00");

	// And the two instants really are on opposite sides of the boundary:
	assert.equal(zonedOffsetMs(janMs), 11 * 60 * MIN_MS, "January is AEDT +11");
	assert.equal(zonedOffsetMs(julMs), 10 * 60 * MIN_MS, "July is AEST +10");
	assert.notEqual(zonedOffsetMs(janMs), zonedOffsetMs(julMs));

	// Parts round-trip too (weekday included: 2026-01-15 is a Thursday).
	const p = msToSydneyParts(janMs);
	assert.deepEqual(
		{ year: p.year, month: p.month, day: p.day, hour: p.hour, min: p.min },
		{ year: 2026, month: 1, day: 15, hour: 12, min: 0 }
	);
	assert.equal(p.weekday, 4);
});
