// Pure-logic core of the online booking widget: DST-safe Sydney<->UTC time
// helpers plus the slot-computation engine. NO network, NO Cloudflare
// bindings, NO fetch, and no Date.now() inside the slot maths -- everything
// takes its "now" as an argument so it stays deterministic and Node-testable
// in isolation (`node --test`). A later task feeds computeSlots real ServiceM8
// busy-times; this file only cares about the maths.

import {
	BUSINESS_TIMEZONE,
	SLOT_GRANULARITY_MIN,
	BUFFER_MIN,
	HORIZON_DAYS,
	ONLINE_HOURS,
	SERVICE_DURATIONS,
} from "./booking-config.js";

const MIN_MS = 60 * 1000;

// The Sydney wall-clock parts of an instant, read from Intl rather than by
// arithmetic on a fixed offset so they stay correct across daylight saving.
// Mirrors serviceM8Timestamp's approach in servicem8.js (Intl parts, en-CA for
// 24-hour time). Month is 1-based here to match sydneyLocalToMs' signature and
// the "YYYY-MM-DD" string format; weekday is JS getDay() (0=Sun..6=Sat).
export function msToSydneyParts(ms) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: BUSINESS_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(new Date(ms));
	const get = (t) => (parts.find((p) => p.type === t) || {}).value || "00";
	const year = Number(get("year"));
	const month = Number(get("month"));
	const day = Number(get("day"));
	// en-CA gives 24-hour time, but midnight can come back as "24" in some
	// runtimes -- normalise it so downstream maths and strings stay valid.
	const hour = get("hour") === "24" ? 0 : Number(get("hour"));
	const min = Number(get("minute"));
	const sec = Number(get("second"));
	// Weekday of this Sydney calendar date: treat the wall-clock date as a UTC
	// date and read getUTCDay(), which is timezone-of-runtime independent.
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return { year, month, day, hour, min, sec, weekday };
}

// The Australia/Sydney UTC offset (ms, positive east of UTC) in effect at the
// given instant. Derived by asking what the Sydney wall clock reads at `utcMs`,
// then treating those wall-clock parts as if they were UTC: the difference is
// the offset that was applied. This is what makes the conversions DST-aware --
// +10h (AEST) in winter, +11h (AEDT) in summer, decided by the instant itself.
export function zonedOffsetMs(utcMs) {
	const p = msToSydneyParts(utcMs);
	const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.min, p.sec);
	// asUTC - utcMs would carry sub-second noise from the instant; round to whole
	// seconds since zone offsets are always whole-minute quantities.
	return Math.round((asUTC - utcMs) / 1000) * 1000;
}

// Convert a Sydney wall-clock time to an absolute epoch-ms instant, correct
// across DST. We can't know the offset until we know the instant, so: guess the
// instant as if the wall clock were UTC, look up the offset at that guess,
// subtract it, then re-check -- if the correction landed us on the other side
// of a DST transition the offset changes, so we redo the subtraction with the
// corrected offset. Month is 1-based.
export function sydneyLocalToMs(year, month, day, hour, min) {
	const guess = Date.UTC(year, month - 1, day, hour, min, 0);
	const off1 = zonedOffsetMs(guess);
	let ms = guess - off1;
	const off2 = zonedOffsetMs(ms);
	if (off2 !== off1) {
		ms = guess - off2;
	}
	return ms;
}

// "YYYY-MM-DD HH:MM:SS" in Sydney local time -- the exact shape ServiceM8's API
// and our D1 rows use. Built from the same Intl parts as serviceM8Timestamp so
// it stays correct across daylight saving.
export function formatSydneyTimestamp(ms) {
	const p = msToSydneyParts(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return (
		`${p.year}-${pad(p.month)}-${pad(p.day)} ` +
		`${pad(p.hour)}:${pad(p.min)}:${pad(p.sec)}`
	);
}

// "YYYY-MM-DD" for "today" in Sydney at the given instant.
export function sydneyTodayYmd(nowMs) {
	const p = msToSydneyParts(nowMs);
	const pad = (n) => String(n).padStart(2, "0");
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Advance a {year, month, day} calendar date by n days. Done via Date.UTC so
// month/year rollover is handled for us, and WITHOUT adding n*24h to an instant
// (a Sydney "day" is 23h or 25h across a DST transition, so hour arithmetic
// would drift). Pure calendar maths -- no timezone involved.
function addCalendarDays(ymd, n) {
	const dt = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + n));
	return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

// Weekday (0=Sun..6=Sat) for a calendar date, matching ONLINE_HOURS' keys.
function weekdayOf(ymd) {
	return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay();
}

// "HH:MM" -> minutes-since-midnight.
function hhmmToMinutes(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

// Compute the bookable slots for one service against Phill's known busy time.
//
//   occupancy : [{ startMs, endMs }, ...] real busy intervals (may be empty),
//               treated as opaque -- ServiceM8 jobs, leave, blocks, whatever.
//   service   : a SERVICE_DURATIONS key (throws if unknown -- defensive; the
//               caller is expected to have validated already).
//   nowMs     : current instant (epoch ms), passed in so this stays pure.
//
// Rules: never same-day (earliest offered day is the next OPEN day strictly
// after Sydney-today); horizon is Sydney-today + HORIZON_DAYS inclusive; a
// candidate must FINISH by its mask segment's close (the mask edge is a hard
// wall with no buffer); real occupancy is padded by BUFFER_MIN on both sides
// before the overlap test. Every in-range OPEN day is returned, even with an
// empty slots array; closed days (empty ONLINE_HOURS) are omitted entirely.
export function computeSlots({ occupancy, service, nowMs }) {
	// hasOwn, not `in`, for the same reason as isBookableService: `in` walks the
	// prototype chain, so "__proto__" and friends slipped past this guard and
	// made `duration` an inherited value rather than a number.
	if (!Object.hasOwn(SERVICE_DURATIONS, service)) {
		throw new Error(`Unknown service: ${service}`);
	}
	const duration = SERVICE_DURATIONS[service];
	const busy = Array.isArray(occupancy) ? occupancy : [];
	const bufferMs = BUFFER_MIN * MIN_MS;
	const durationMs = duration * MIN_MS;

	const today = msToSydneyParts(nowMs);
	const todayYmd = { year: today.year, month: today.month, day: today.day };

	const days = [];
	// Day 0 is today (never offered -- no same-day); offer day 1 .. HORIZON_DAYS.
	for (let dayOffset = 1; dayOffset <= HORIZON_DAYS; dayOffset++) {
		const ymd = addCalendarDays(todayYmd, dayOffset);
		const segments = ONLINE_HOURS[weekdayOf(ymd)] || [];
		if (segments.length === 0) continue; // closed day -- omit entirely

		const pad = (n) => String(n).padStart(2, "0");
		const dateStr = `${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`;

		const slots = [];
		for (const [open, close] of segments) {
			const openMin = hhmmToMinutes(open);
			const closeMin = hhmmToMinutes(close);
			// Step starts on the grid while the job still finishes by close. The
			// buffer deliberately does NOT need to fit before close -- the mask edge
			// is checked against the unbuffered slot.
			for (let startMin = openMin; startMin + duration <= closeMin; startMin += SLOT_GRANULARITY_MIN) {
				const startMs = sydneyLocalToMs(ymd.year, ymd.month, ymd.day, Math.floor(startMin / 60), startMin % 60);
				const endMs = startMs + durationMs;

				// Buffer applies ONLY against real occupancy, never against the mask
				// edge -- pad the candidate on both sides and reject on any overlap.
				const bufStart = startMs - bufferMs;
				const bufEnd = endMs + bufferMs;
				const clashes = busy.some((b) => b.startMs < bufEnd && b.endMs > bufStart);
				if (clashes) continue;

				const startIso = formatSydneyTimestamp(startMs);
				const endIso = formatSydneyTimestamp(endMs);
				slots.push({
					start: startIso.slice(11, 16),
					end: endIso.slice(11, 16),
					startIso,
					endIso,
				});
			}
		}
		// Keep slots ascending by start (segments are already in order, but be
		// explicit so multi-segment days can never surprise us).
		slots.sort((a, b) => (a.startIso < b.startIso ? -1 : a.startIso > b.startIso ? 1 : 0));
		days.push({ date: dateStr, slots });
	}

	return {
		service,
		durationMinutes: duration,
		timezone: BUSINESS_TIMEZONE,
		days,
	};
}
