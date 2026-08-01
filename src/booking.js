// Shared booking-enquiry logic used by both the public /api/booking HTTP
// endpoint (src/index.js's handleBooking) and the submit_booking_enquiry MCP
// tool (src/mcp.js) -- one place for field validation and the
// ServiceM8-lead-plus-notification-email pipeline, so the two entry points
// can never drift apart.
import { createServiceM8Lead, notifyStaffOfNewJob, allocateJobToStaff } from "./servicem8.js";
import { sendBookingNotification, sendBookingConfirmation } from "./email.js";

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
	const { alertLabel = "New booking", emailLabel = "booking", notifyOffice = true, confirmCustomer = true } = opts;
	const description = [
		sourceLabel,
		`Service: ${f.service}`,
		f.date || f.time ? `Preferred: ${[f.date, f.time].filter(Boolean).join(" ")}` : "",
		"",
		f.message || "(no additional notes)",
	]
		.filter((l) => l !== "")
		.join("\n");

	const booking = { name: f.name, email: f.email, phone: f.phone, address: f.address, service: f.service, date: f.date, time: f.time, message: f.message };
	let jobUrl = null;
	let jobUuid = null;
	try {
		const result = await createServiceM8Lead(env, { name: f.name, email: f.email, phone: f.phone, address: f.address, description }, { force: true });
		jobUrl = result && result.jobUrl;
		jobUuid = result && result.jobUuid;
	} catch (e) {
		// Don't fail the enquiry on a ServiceM8 hiccup -- the office notification
		// below still captures the lead (flagged for manual entry).
		console.error("Booking -> ServiceM8 failed:", e && (e.stack || e.message));
	}

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
