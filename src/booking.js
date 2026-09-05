// Shared booking-enquiry logic used by both the public /api/booking HTTP
// endpoint (src/index.js's handleBooking) and the submit_booking_enquiry MCP
// tool (src/mcp.js) -- one place for field validation and the
// ServiceM8-lead-plus-notification-email pipeline, so the two entry points
// can never drift apart.
import {
	createServiceM8Lead,
	createWorkOrderJob,
	createJobActivity,
	createInvoiceLineItem,
	createJobNote,
	notifyStaffOfNewJob,
	allocateJobToStaff,
	findOpenWorkOrderForCustomer,
} from "./servicem8.js";
import { sendBookingNotification, sendBookingConfirmation } from "./email.js";
import { STAFF_UUID, SERVICE_BADGES, SERVICE_CATEGORIES, SERVICE_TEMPLATES } from "./booking-config.js";
import { sydneyLocalToMs } from "./availability.js";

// Deliberately not a single regex like /^[^\s@]+@[^\s@]+\.[^\s@]+$/ -- since
// "." is a valid member of [^\s@], the two variable-length groups either
// side of the literal "." overlap and can match the same characters in many
// different ways, which is a classic catastrophic-backtracking (ReDoS)
// shape on attacker-controlled input (flagged by CodeQL). The regex here
// only enforces "no @ or whitespace either side of a single @", which is
// unambiguous and linear-time; the "has a dot in the domain" check is a
// second, plain string check instead of being folded into the same regex.
function isValidEmail(email) {
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) return false;
	const domain = email.slice(email.indexOf("@") + 1);
	const dot = domain.indexOf(".");
	return dot > 0 && dot < domain.length - 1;
}

export function validateBookingFields(f) {
	const errors = [];
	if (!f.name || f.name.length > 120) errors.push("Please enter your name.");
	if (!isValidEmail(f.email)) errors.push("Please enter a valid email address.");
	if (f.phone.replace(/\D/g, "").length < 6) errors.push("Please enter a valid phone number.");
	if (!f.address) errors.push("Please enter the service address.");
	if (!f.service) errors.push("Please choose a service.");
	if (f.message.length > 2000) errors.push("Message is too long.");
	return errors;
}

// The /contact enquiry form asks for less than /book does: no address, and
// phone is optional. Validate what it actually collects rather than rejecting
// a perfectly good enquiry over a field we never put on the form.
export function validateEnquiryFields(f) {
	const errors = [];
	if (!f.name || f.name.length > 120) errors.push("Please enter your name.");
	if (!isValidEmail(f.email)) errors.push("Please enter a valid email address.");
	if (f.phone && f.phone.replace(/\D/g, "").length < 6) errors.push("Please enter a valid phone number.");
	if (!f.service) errors.push("Please choose a service.");
	if (f.message.length > 2000) errors.push("Message is too long.");
	return errors;
}

// What the customer typed, formatted for the job's Notes section. Labelled so
// it reads unambiguously as their words rather than a staff note. Empty when
// they didn't write anything -- an empty note is worse than no note.
function customerNote(f) {
	return f.message ? `Notes from the customer:\n${f.message}` : "";
}

// Save the customer's own words on the job, best-effort. Their message is
// always in the office email too, so a failure here is a "someone copy this
// across" flag, never a failed booking. Returns a warning string ("" if fine)
// for the office email and the staff message to carry.
async function attachCustomerNote(env, jobUuid, f) {
	const note = customerNote(f);
	if (!note || !jobUuid) return "";
	try {
		await createJobNote(env, jobUuid, note);
		return "";
	} catch (e) {
		console.error(
			`Booking job note FAILED for job ${jobUuid} (job itself is fine) -- the customer's notes are in the office email and need copying onto the job:`,
			e && (e.stack || e.message)
		);
		return "⚠ Couldn't save the customer's notes onto the job — they're in this email, please copy them across.";
	}
}

// f = { name, email, phone, address, service, date, time, message } -- all
// already trimmed strings. sourceLabel is prepended to the ServiceM8 job
// description so staff can tell at a glance where the enquiry came from
// (the web form vs. an AI agent via MCP).
//
// opts:
//   alertLabel       first words of the ServiceM8 staff message ("New booking")
//   emailLabel       what the office email calls this ("booking")
//   notifyOffice     send the office the details (on by default)
//   confirmCustomer  send the customer a booking confirmation -- off for the
//                    /contact form, where "thanks for booking" would
//                    misdescribe what they actually sent
//
// Never throws: a ServiceM8 API failure is caught and logged so the caller
// still gets a clean response, and the office notification email captures the
// raw enquiry for manual entry.
export async function createBookingAndNotify(env, ctx, f, sourceLabel, opts = {}) {
	// When the customer picked a real open slot, take the scheduled path instead:
	// lock the slot in D1, create a confirmed Work Order + jobactivity, and send
	// confirmed (not "we'll be in touch") notifications. The lead/enquiry body
	// below is left completely untouched -- absence of opts.slot means identical
	// behaviour to before.
	if (opts.slot) return bookScheduledSlot(env, ctx, f, sourceLabel, opts);

	const { alertLabel = "New booking", emailLabel = "booking", notifyOffice = true, confirmCustomer = true } = opts;
	// Description is the headline only. What the customer wrote goes to the job's
	// Notes section below, once the job exists to attach it to.
	const description = [sourceLabel, `Service: ${f.service}`, f.date || f.time ? `Preferred: ${[f.date, f.time].filter(Boolean).join(" ")}` : ""]
		.filter((l) => l !== "")
		.join("\n");

	let jobUrl = null;
	let jobUuid = null;
	try {
		const result = await createServiceM8Lead(
			env,
			{ name: f.name, email: f.email, phone: f.phone, address: f.address, description, categoryUuid: SERVICE_CATEGORIES[opts.serviceKey] },
			{ force: true }
		);
		jobUrl = result && result.jobUrl;
		jobUuid = result && result.jobUuid;
	} catch (e) {
		// Don't fail the enquiry on a ServiceM8 hiccup -- the office notification
		// below still captures the lead (flagged for manual entry).
		console.error("Booking -> ServiceM8 failed:", e && (e.stack || e.message));
	}

	const noteWarning = await attachCustomerNote(env, jobUuid, f);
	const booking = {
		name: f.name,
		email: f.email,
		phone: f.phone,
		address: f.address,
		service: f.service,
		date: f.date,
		time: f.time,
		message: f.message,
		warning: noteWarning,
	};

	// Fire the office notification + customer confirmation without blocking the
	// response (allSettled so one failing send never affects the other). Log the
	// outcome of each so a send failure is diagnosable.
	const sends = [];
	if (notifyOffice) sends.push(["office notification", sendBookingNotification(env, booking, jobUrl, emailLabel)]);
	if (confirmCustomer) sends.push(["customer confirmation", sendBookingConfirmation(env, booking, emailLabel)]);

	const notify = Promise.allSettled(sends.map(([, p]) => p)).then((results) => {
		results.forEach((r, i) => {
			const label = sends[i][0];
			if (r.status === "rejected") console.error(`Booking ${label} email FAILED:`, r.reason && (r.reason.stack || r.reason.message));
			else console.log(`Booking ${label} email sent`);
		});
	});

	// Allocating the job to staff is what makes ServiceM8 itself raise the
	// notification, and because that notification is native to the ServiceM8
	// app, tapping it opens the job in the app rather than a browser.
	//
	// This is deliberately the only phone notification for a lead. The site can
	// send its own Web Push (the staff chat uses it), but that arrives from the
	// website and can only ever open a web page -- notifications about jobs
	// belong to ServiceM8, so that's where they come from.
	const allocate = allocateJobToStaff(env, jobUuid);

	// ...and a message against the job in ServiceM8, so whoever picks it up
	// has the enquiry detail right there.
	// First line is what shows in the push, so it carries the useful bit.
	const alert = notifyStaffOfNewJob(env, jobUuid, [
		`${alertLabel}: ${f.name} — ${f.service}`,
		noteWarning,
		f.phone,
		f.address,
		f.date || f.time ? `Preferred: ${[f.date, f.time].filter(Boolean).join(" ")}` : "",
		f.email,
		f.message ? `\n${f.message}` : "",
		`\n${sourceLabel}`,
	]);

	const done = Promise.all([notify, allocate, alert]);
	if (ctx && ctx.waitUntil) ctx.waitUntil(done);
	else await done;

	return { jobUrl };
}

// Turn a "YYYY-MM-DD HH:MM:SS" Sydney-local slot start into a customer-facing
// display string like "Tue 11 Aug 2026, 9:00 AM". Pure and deterministic: the
// ISO parts are converted to an absolute instant via sydneyLocalToMs (so DST is
// handled the same way as everywhere else), then formatted from Intl parts
// rather than the locale's own joined string, so the exact shape is stable
// across ICU versions and testable. Returns "" on anything that isn't the
// expected shape, so a bad slot degrades to no time rather than "Invalid Date".
export function formatConfirmedTime(startIso) {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(startIso || ""));
	if (!m) return "";
	const ms = sydneyLocalToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
	const parts = new Intl.DateTimeFormat("en-AU", {
		timeZone: "Australia/Sydney",
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).formatToParts(new Date(ms));
	const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
	// dayPeriod comes back lower-case ("am"/"pm") on en-AU in some runtimes and
	// can carry dots ("a.m.") in others -- normalise to a bare "AM"/"PM".
	const period = get("dayPeriod").toUpperCase().replace(/\./g, "");
	return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${period}`;
}

// Release our own lock row. Never throws -- a failed release is logged but must
// not turn into an error the caller has to handle; the row is ours and at worst
// lingers as a stale 'pending' that the overlap guard still respects.
async function releaseSlotLock(env, id) {
	try {
		await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(id).run();
	} catch (e) {
		console.error("Booking lock release (DELETE) failed:", e && (e.stack || e.message));
	}
}

// The scheduled path: the customer has locked into a specific open slot, so we
// must (a) reserve it so two people can't take the same time and (b) land it in
// ServiceM8 as a confirmed Work Order on the calendar. Never throws -- every
// outcome maps to a return value the router can translate:
//   { conflict: true }        -- the slot was taken (identical or overlapping)
//   { error: true }           -- couldn't create the ServiceM8 job (release lock)
//   { jobUrl, booked: true }  -- booked (incl. the partial-failure case below)
//
// Concurrency: the INSERT OR IGNORE on UNIQUE(staff_uuid, start_date) is atomic
// and is what actually blocks two requests racing for the *identical* start --
// exactly one INSERT reports changes===1, the loser sees changes===0. The
// overlap SELECT that follows is a best-effort guard for *different*-start slots
// that still overlap (durations vary); it is NOT perfectly atomic across
// concurrent requests, so two overlapping different-start bookings landing in
// the same instant could both pass. At one technician and this booking volume
// that residual race is acceptable and is documented rather than engineered
// away (a transaction/serialisation would be the fix if volume ever demanded).
async function bookScheduledSlot(env, ctx, f, sourceLabel, opts) {
	const { slot } = opts;
	const emailLabel = opts.emailLabel || "booking";
	// pricing = { quote:true } for a custom-quote booking, or
	// { amount, modifierLabel } for a fixed-price one. Always present -- the
	// only caller (handleBooking's scheduled branch) computes it server-side
	// before ever getting here.
	const pricing = opts.pricing || {};

	// f.service is already the human label (index.js sets it from
	// SERVICE_LABELS before calling in) -- fold the chosen modifier in so the
	// service and what was picked read as one line. No "Service:" prefix: this
	// is the job's headline in ServiceM8, so it's just the service itself.
	const serviceLine = !pricing.quote && pricing.modifierLabel ? `${f.service} (${pricing.modifierLabel})` : f.service;
	const descPriceLine = pricing.quote
		? "Customer requested a CUSTOM QUOTE (no fixed price) — please quote."
		: pricing.amount != null
			? `Fixed online price: $${pricing.amount} inc GST`
			: "";

	// Service first (it's the headline), then price, then where it came from.
	// No "Preferred" line on this path -- the slot is already booked in, so the
	// scheduled time on the job is the answer and a preferred date just muddies
	// it. What the customer wrote isn't here either: it goes to the job's Notes
	// section further down, so the description stays a three-line headline.
	const description = [serviceLine, descPriceLine, sourceLabel].filter((l) => l !== "").join("\n");

	const confirmedTime = formatConfirmedTime(slot.startIso);
	const id = crypto.randomUUID();

	// 1. Acquire the lock. INSERT OR IGNORE is a no-op (changes===0) when the
	//    UNIQUE(staff_uuid, start_date) row already exists -- that's the slot
	//    already being held, so bail before creating anything in ServiceM8.
	let lock;
	try {
		lock = await env.DB.prepare(
			`INSERT OR IGNORE INTO bookings
				(id, staff_uuid, start_date, end_date, service, status, customer_email, customer_phone, created_at)
				VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
		)
			.bind(id, STAFF_UUID, slot.startIso, slot.endIso, slot.serviceKey, f.email, f.phone, Date.now())
			.run();
	} catch (e) {
		console.error("Booking slot INSERT failed:", e && (e.stack || e.message));
		return { error: true };
	}
	if (!lock || !lock.meta || lock.meta.changes === 0) {
		return { conflict: true };
	}

	// 2. Overlap guard: a different start time whose interval still overlaps ours
	//    (start_date < ourEnd AND end_date > ourStart). Lexicographic compare on
	//    "YYYY-MM-DD HH:MM:SS" is chronological. If anyone else already holds an
	//    overlapping slot, release our row and report the conflict.
	let overlap;
	try {
		overlap = await env.DB.prepare(
			`SELECT id FROM bookings
				WHERE staff_uuid = ? AND status IN ('pending','confirmed')
					AND start_date < ?
					AND end_date   > ?
					AND id != ?`
		)
			.bind(STAFF_UUID, slot.endIso, slot.startIso, id)
			.all();
	} catch (e) {
		// Can't verify we're clear -- don't hold a lock we couldn't validate.
		console.error("Booking overlap SELECT failed:", e && (e.stack || e.message));
		await releaseSlotLock(env, id);
		return { error: true };
	}
	if (overlap && Array.isArray(overlap.results) && overlap.results.length > 0) {
		await releaseSlotLock(env, id);
		return { conflict: true };
	}

	// 3. Create the confirmed Work Order -- unless this customer already has one
	//    open, in which case the new visit goes onto that job rather than
	//    spawning a second. A Completed job is finished work and does not count:
	//    the next booking after it is genuinely new and gets its own job.
	//
	//    Only the job is reused. The calendar entry is still placed (it is a real
	//    second visit at a real second time) but the price is NOT added to the
	//    existing job's invoice -- one open job now carries two visits, and
	//    whether that is one charge or two is a call for the office, not for us.
	let jobUuid = null;
	let jobUrl = null;
	let reusedOpenJob = null;
	try {
		reusedOpenJob = await findOpenWorkOrderForCustomer(env, { email: f.email, phone: f.phone });
	} catch (e) {
		// A dedup lookup failure must never cost us a booking -- fall through and
		// create the job as we always did.
		console.error("Booking open-job lookup failed (creating a new job):", e && (e.stack || e.message));
	}
	if (reusedOpenJob) {
		jobUuid = reusedOpenJob.jobUuid;
		jobUrl = reusedOpenJob.jobUrl;
		try {
			await createJobNote(
				env,
				jobUuid,
				[
					`Another online booking came in for this customer on ${confirmedTime}.`,
					description,
					pricing.quote || pricing.amount == null
						? ""
						: `NOT added to this job's invoice -- $${pricing.amount} still to be priced by the office.`,
				]
					.filter(Boolean)
					.join("\n")
			);
		} catch (e) {
			console.error("Booking reuse note failed (booking still made):", e && (e.stack || e.message));
		}
	} else {
		try {
			const res = await createWorkOrderJob(
				env,
				{ name: f.name, email: f.email, phone: f.phone, address: f.address, description, categoryUuid: SERVICE_CATEGORIES[slot.serviceKey] },
				{
					status: pricing.quote ? "Quote" : "Work Order",
					// Templates only on a real Work Order. They default to Work Order and
					// the template endpoint ignores `status`, so using one for a quote
					// leaves the job as a Work Order unless a follow-up update lands.
					templateUuid: pricing.quote ? undefined : SERVICE_TEMPLATES[slot.serviceKey],
					// SERVICE_BADGES was added and documented as "wired in", but nothing
					// ever read it -- this is the line that was missing, so filling the
					// map in had no effect. Unlike templates, badges apply on the quote
					// path too: a quote for a termite treatment is still a termite job.
					badges: SERVICE_BADGES[slot.serviceKey],
				}
			);
			jobUuid = res && res.jobUuid;
			jobUrl = res && res.jobUrl;
		} catch (e) {
			console.error("Booking -> ServiceM8 Work Order failed:", e && (e.stack || e.message));
			await releaseSlotLock(env, id);
			return { error: true };
		}
	}

	// 4. Schedule it on the calendar. If THIS fails the job already exists, so we
	//    do NOT release -- we keep the booking (never lose a real customer over a
	//    transient scheduling hiccup) and flag the office to place it by hand.
	let jobactivityUuid = null;
	let schedulingFailed = false;
	try {
		jobactivityUuid = await createJobActivity(env, { jobUuid, staffUuid: STAFF_UUID, startIso: slot.startIso, endIso: slot.endIso });
	} catch (e) {
		schedulingFailed = true;
		console.error(
			`Booking auto-schedule FAILED for job ${jobUuid} (Work Order created, jobactivity NOT) -- office must set the time in ServiceM8 manually:`,
			e && (e.stack || e.message)
		);
	}

	// Persist the outcome. Confirmed either way (the booking is captured and the
	// lock stays held so our widget won't re-offer the slot); jobactivity_uuid is
	// only set when auto-scheduling actually placed it. A failure of THIS UPDATE
	// is separate from the scheduling outcome above -- the job/jobactivity already
	// exist, so log it but still treat the booking as made.
	try {
		if (jobactivityUuid) {
			await env.DB.prepare(`UPDATE bookings SET status='confirmed', job_uuid=?, jobactivity_uuid=? WHERE id=?`)
				.bind(jobUuid, jobactivityUuid, id)
				.run();
		} else {
			await env.DB.prepare(`UPDATE bookings SET status='confirmed', job_uuid=? WHERE id=?`).bind(jobUuid, id).run();
		}
	} catch (e) {
		console.error("Booking confirm UPDATE failed (ServiceM8 job/jobactivity already created):", e && (e.stack || e.message));
	}

	// 4b. Add the fixed price as an invoice line item, best-effort. Deliberately
	//     its own try/catch, separate from job/jobactivity creation above: the
	//     booking itself is already fully made by this point (job exists, slot
	//     locked, calendar entry placed), so a line-item failure must only be
	//     logged and flagged to the office -- never treated as a booking failure.
	//     Skipped entirely for a custom-quote booking, which has no fixed amount.
	let lineItemFailed = false;
	if (!reusedOpenJob && !pricing.quote && pricing.amount != null) {
		try {
			await createInvoiceLineItem(env, {
				jobUuid,
				name: `${f.service}${pricing.modifierLabel ? ` (${pricing.modifierLabel})` : ""} — online booking`,
				amount: pricing.amount,
			});
		} catch (e) {
			lineItemFailed = true;
			console.error(
				`Booking invoice line item FAILED for job ${jobUuid} (job/booking still confirmed) -- office must add the $${pricing.amount} charge in ServiceM8 manually:`,
				e && (e.stack || e.message)
			);
		}
	}

	// 5. Notify. The customer always gets a clean confirmed-time email (an
	//    internal scheduling/invoicing hiccup isn't their problem -- the office
	//    will fix it up). The office copy and the ServiceM8 StaffMessage carry
	//    the warning(s) so someone follows up by hand.
	// 4c. The customer's own words go on the job as a note, not in the
	//     description. Best-effort for the same reason as the line item: the
	//     booking is already made, and their message is in the office email too.
	const noteWarning = await attachCustomerNote(env, jobUuid, f);

	const warning = [
		reusedOpenJob
			? `⚠ Customer already had an open job (${reusedOpenJob.generatedJobId || reusedOpenJob.jobUuid}) -- this visit was added to it, and the ${pricing.quote || pricing.amount == null ? "price" : `$${pricing.amount}`} has NOT been put on its invoice.`
			: "",
		schedulingFailed ? "⚠ Booking created but auto-scheduling failed — set the time in ServiceM8 manually." : "",
		lineItemFailed ? `⚠ Couldn't add the $${pricing.amount} price to the ServiceM8 invoice — add it manually.` : "",
		noteWarning,
	]
		.filter(Boolean)
		.join(" ");
	const priceLine = pricing.quote ? "Custom quote requested" : pricing.amount != null ? `$${pricing.amount} inc GST` : "";
	const customerBooking = {
		name: f.name,
		email: f.email,
		phone: f.phone,
		address: f.address,
		service: f.service,
		date: f.date,
		time: f.time,
		message: f.message,
		confirmedTime,
		priceLine,
	};
	const officeBooking = { ...customerBooking, warning };

	const sends = [
		["office notification", sendBookingNotification(env, officeBooking, jobUrl, emailLabel)],
		["customer confirmation", sendBookingConfirmation(env, customerBooking, emailLabel)],
	];
	const notify = Promise.allSettled(sends.map(([, p]) => p)).then((results) => {
		results.forEach((r, i) => {
			const label = sends[i][0];
			if (r.status === "rejected") console.error(`Booking ${label} email FAILED:`, r.reason && (r.reason.stack || r.reason.message));
			else console.log(`Booking ${label} email sent`);
		});
	});

	// Phill's phone push about the new confirmed booking. First line is the push
	// preview, so it carries the useful bit; the warning (if any) is line two so
	// the office can't miss it on opening the message. Note: NOT allocateJobToStaff
	// -- the jobactivity already puts this on the calendar; this is just the ping.
	const alert = notifyStaffOfNewJob(env, jobUuid, [
		`⚡ New confirmed booking: ${f.name} — ${f.service} @ ${confirmedTime}`,
		warning,
		f.phone,
		f.address,
		f.email,
		f.message ? `\n${f.message}` : "",
		`\n${sourceLabel}`,
	]);

	const done = Promise.all([notify, alert]);
	if (ctx && ctx.waitUntil) ctx.waitUntil(done);
	else await done;

	return { jobUrl, booked: true };
}
