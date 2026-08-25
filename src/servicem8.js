// ServiceM8 integration: turn a chat lead into a Quote job.
//
// Auth is a single account API key (env.SERVICEM8_API_KEY) sent as the
// `X-API-Key` header -- confirmed working against the live API. Plain fetch(),
// so this runs fine from the Durable Object.
//
// Deduplication is the whole point of the search-before-create flow here: we
// never create a second client for an email/phone that already exists, and we
// won't silently open a second Quote job for a customer who already has one.

import { sydneyLocalToMs, formatSydneyTimestamp } from "./availability.js";
import { STAFF_UUID } from "./booking-config.js";

const BASE = "https://api.servicem8.com/api_1.0";

function headers(env) {
	return { "X-API-Key": env.SERVICEM8_API_KEY, "Content-Type": "application/json" };
}

function normEmail(e) {
	return (e || "").trim().toLowerCase();
}

// Comparison key for a phone number: digits only, with any country code and
// leading zero stripped, so "0412 345 678", "+61 412 345 678" and
// "61412345678" all reduce to "412345678" and match each other. Only strips
// when what's left is a full 9-digit national number, so a short or malformed
// entry is compared as typed rather than silently mangled.
export function phoneKey(p) {
	let d = (p || "").replace(/\D/g, "");
	if (d.startsWith("61") && d.length === 11) d = d.slice(2);
	if (d.startsWith("0") && d.length === 10) d = d.slice(1);
	return d;
}

// How a number is WRITTEN to ServiceM8: AU national format, "0412345678" --
// what staff read and dial. Records created before this used digits-with-
// country-code ("61412345678") instead, which is why lookups have to know
// about both shapes.
export function auPhone(p) {
	const k = phoneKey(p);
	if (!k) return "";
	return k.length === 9 ? "0" + k : k;
}

function jobUrl(uuid) {
	// Deep-link that opens the job directly for a logged-in ServiceM8 user.
	return "https://go.servicem8.com/openjob/" + uuid;
}

async function sm8Get(env, pathAndQuery) {
	const res = await fetch(BASE + pathAndQuery, { headers: headers(env) });
	if (!res.ok) throw new Error("ServiceM8 GET " + pathAndQuery + " -> " + res.status);
	return res.json();
}

// POST a record; ServiceM8 returns the new UUID in the x-record-uuid header.
async function sm8Create(env, resource, body) {
	const res = await fetch(`${BASE}/${resource}.json`, {
		method: "POST",
		headers: headers(env),
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		const error = new Error("ServiceM8 POST " + resource + " -> " + res.status + " " + detail.slice(0, 200));
		// Kept as fields as well as in the message so callers (and the
		// /api/servicem8/diagnose endpoint) can report what ServiceM8 actually
		// said, rather than everyone re-parsing a string.
		error.status = res.status;
		error.detail = detail.slice(0, 300);
		throw error;
	}
	const uuid = res.headers.get("x-record-uuid");
	if (!uuid) throw new Error("ServiceM8 POST " + resource + " returned no record UUID");
	return uuid;
}

function splitName(name) {
	const parts = (name || "").trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return { first: "", last: "" };
	if (parts.length === 1) return { first: parts[0], last: "" };
	return { first: parts[0], last: parts.slice(1).join(" ") };
}

// Find an existing customer (company_uuid) by contact email, then phone.
// Returns null if none -- caller creates a new one. Throws on API error so we
// never accidentally create a duplicate when the dedup check itself failed.
//
// Matches inactive/archived contacts too, not just active ones: ServiceM8
// enforces company-name uniqueness even against archived companies, so if we
// only matched active contacts here, an archived customer's name would block
// a genuine repeat customer's create with "Name must be unique" instead of
// reusing their existing record (confirmed live 2026-08-05).
async function findExistingCompanyUuid(env, email, phone) {
	const e = normEmail(email);
	if (e) {
		const rows = await sm8Get(env, `/companycontact.json?%24filter=${encodeURIComponent(`email eq '${e}'`)}`);
		const hit = Array.isArray(rows) && rows.find((r) => normEmail(r.email) === e);
		if (hit) return hit.company_uuid;
	}
	const key = phoneKey(phone);
	if (key) {
		// Two shapes to look for: contacts written now carry the number on
		// `mobile` in national format, while ones written before that change
		// carry it on `phone` with the country code. Ask for each in turn and
		// confirm on either field, so dedup keeps working across both.
		for (const filter of [`mobile eq '${auPhone(phone)}'`, `phone eq '61${key}'`]) {
			const rows = await sm8Get(env, `/companycontact.json?%24filter=${encodeURIComponent(filter)}`);
			const hit = Array.isArray(rows) && rows.find((r) => phoneKey(r.phone) === key || phoneKey(r.mobile) === key);
			if (hit) return hit.company_uuid;
		}
	}
	return null;
}

async function findOpenQuoteJob(env, companyUuid) {
	const rows = await sm8Get(
		env,
		`/job.json?%24filter=${encodeURIComponent(`company_uuid eq '${companyUuid}' and status eq 'Quote'`)}`
	);
	if (!Array.isArray(rows) || !rows.length) return null;
	return rows.find((j) => String(j.active) !== "0") || rows[0];
}

// Main entry: create (or reuse) a ServiceM8 Quote job for a chat lead.
//   lead = { name, email, phone, description, address }
//   opts = { force }  -- force:true creates a new job even if an open quote exists
// Returns one of:
//   { created:true,   jobUuid, jobUrl, generatedJobId, reusedCustomer }
//   { duplicate:true, jobUuid, jobUrl, generatedJobId, reusedCustomer }  (existing open quote)
export async function createServiceM8Lead(env, lead, opts = {}) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");

	const { name, email, phone, description, address } = lead;
	const { first, last } = splitName(name);

	// 1. Find or create the customer (never duplicate an existing email/phone).
	let companyUuid = await findExistingCompanyUuid(env, email, phone);
	const reusedCustomer = !!companyUuid;
	if (!companyUuid) {
		companyUuid = await sm8Create(env, "company", {
			name: name || email || "Website enquiry",
			active: 1,
			is_individual: 1,
			// The client card gets the address too, not just the job. Without this
			// a customer who booked online showed up with a blank address on their
			// record, so anything driven off the client (rather than the job) had
			// nothing to work with.
			address: address || "",
		});
		await sm8Create(env, "companycontact", {
			company_uuid: companyUuid,
			first: first || name || "Website",
			last,
			email: normEmail(email),
			// Mobile only, in national format: this is the number staff dial, and
			// writing it to `phone` as well just duplicated it into a field the
			// office doesn't use.
			mobile: auPhone(phone),
			type: "JOB",
			is_primary_contact: 1,
			active: 1,
		});
	}

	// 2. Job dedup: if the customer already has an open Quote, don't silently
	//    create another -- hand it back so staff can decide.
	if (!opts.force) {
		const existing = await findOpenQuoteJob(env, companyUuid);
		if (existing) {
			return {
				duplicate: true,
				jobUuid: existing.uuid,
				jobUrl: jobUrl(existing.uuid),
				generatedJobId: existing.generated_job_id || null,
				reusedCustomer,
			};
		}
	}

	// 3. Create the Quote job + its job contact.
	const jobUuid = await sm8Create(env, "job", {
		status: "Quote",
		company_uuid: companyUuid,
		job_description: description || "",
		job_address: address || "",
		// Only sent when the caller knows which category this is (booking-config's
		// SERVICE_CATEGORIES). A free-text enquiry has no reliable category, and
		// an empty category_uuid is better than a wrong one.
		...(lead.categoryUuid ? { category_uuid: lead.categoryUuid } : {}),
	});
	await sm8Create(env, "jobcontact", {
		job_uuid: jobUuid,
		first: first || name || "Website",
		last,
		email: normEmail(email),
		mobile: auPhone(phone),
		type: "JOB",
	});

	return { created: true, jobUuid, jobUrl: jobUrl(jobUuid), generatedJobId: null, reusedCustomer };
}

// --- Telling staff about it, inside ServiceM8 -------------------------------
//
// Creating the job was silent: it appeared in the Quote list and that was it,
// so a website enquiry could sit unnoticed until somebody thought to look. A
// StaffMessage is ServiceM8's own staff-to-staff message -- it shows up in
// Messages in the ServiceM8 app and pushes to the phone of any staff member
// whose device can receive one. Setting regarding_job_uuid attaches it to the
// job, so opening the message goes straight to the enquiry it's about.

function splitList(value) {
	return String(value || "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

function staffLabel(s) {
	return [s.first, s.last].filter(Boolean).join(" ") || s.email || s.uuid;
}

// Who hears about a new website enquiry, in order of preference:
//   SERVICEM8_NOTIFY_STAFF_UUID   -- one or more staff UUIDs, comma separated
//   SERVICEM8_NOTIFY_STAFF_EMAIL  -- one or more staff emails, comma separated
//   (neither set)                 -- every active staff member whose device can
//                                    actually receive a push
// Resolved against the live staff list rather than hard-coded, so it keeps
// working as staff come and go. Returns [{uuid, label}].
async function resolveNotifyStaff(env) {
	const explicit = splitList(env.SERVICEM8_NOTIFY_STAFF_UUID);
	if (explicit.length) return explicit.map((uuid) => ({ uuid, label: uuid }));

	const rows = await sm8Get(env, "/staff.json");
	const active = (Array.isArray(rows) ? rows : []).filter((s) => String(s.active) !== "0");

	const wantedEmails = splitList(env.SERVICEM8_NOTIFY_STAFF_EMAIL).map(normEmail);
	if (wantedEmails.length) {
		const matched = active.filter((s) => wantedEmails.includes(normEmail(s.email)));
		if (matched.length) return matched.map((s) => ({ uuid: s.uuid, label: staffLabel(s) }));
		console.error(
			"ServiceM8 notify: no active staff matched SERVICEM8_NOTIFY_STAFF_EMAIL " +
				`(${wantedEmails.join(", ")}) -- falling back to all push-capable staff`
		);
	}

	// can_receive_push_notification is ServiceM8's own flag for "this staff
	// member has the app installed with notifications enabled", so it's the
	// closest thing to "who will actually see this".
	return active
		.filter((s) => String(s.can_receive_push_notification) === "1")
		.map((s) => ({ uuid: s.uuid, label: staffLabel(s) }));
}

// Allocating a job to a staff member is the thing that makes the ServiceM8 app
// itself raise a notification -- ServiceM8's own docs list "job allocated to
// staff" as a trigger for a booking notification to field staff. A
// StaffMessage (below) only ever shows up inside the app once you open it.
//
// It's also why this is the right mechanism for "open the job in the app, not
// a browser": the notification is native to ServiceM8, so tapping it lands in
// the ServiceM8 app on the job, with no web link in between.
//
// Never throws -- the job already exists, and a failed allocation must not
// take down the enquiry that created it.
export async function allocateJobToStaff(env, jobUuid, opts = {}) {
	if (!env.SERVICEM8_API_KEY || !jobUuid) return { allocated: 0 };

	let recipients;
	try {
		recipients = await resolveNotifyStaff(env);
	} catch (e) {
		console.error("ServiceM8 allocate: couldn't resolve staff:", e && (e.stack || e.message));
		return { allocated: 0 };
	}

	if (!recipients.length) {
		console.error(
			"ServiceM8 allocate: nobody to allocate to -- set SERVICEM8_NOTIFY_STAFF_EMAIL (or " +
				"SERVICEM8_NOTIFY_STAFF_UUID), or enable push notifications for a staff member in the ServiceM8 app"
		);
		return { allocated: 0 };
	}

	// Dates are ServiceM8's own "YYYY-MM-DD HH:MM:SS" in the account's local
	// time. allocation_date is the earliest the work should show up on a
	// schedule -- today, because a new website lead wants looking at now.
	const now = serviceM8Timestamp(opts.timeZone || BUSINESS_TIMEZONE);

	// Every allocation ServiceM8 itself creates carries a window, so send one:
	// an allocation without it is the shape the API rejects. Configured wins;
	// otherwise use whichever window the account actually has.
	let allocationWindowUuid = env.SERVICEM8_ALLOCATION_WINDOW_UUID || "";
	if (!allocationWindowUuid) {
		try {
			const windows = await sm8Get(env, "/allocationwindow.json");
			const usable = (Array.isArray(windows) ? windows : []).find((w) => String(w.active) !== "0");
			if (usable) allocationWindowUuid = usable.uuid;
		} catch (e) {
			console.error("ServiceM8 allocate: couldn't read allocation windows:", e && e.message);
		}
	}

	const results = await Promise.allSettled(
		recipients.map((r) =>
			sm8Create(env, "joballocation", {
				// active is not optional in practice -- left unset the record is
				// created inactive, which shows up nowhere and notifies nobody.
				active: 1,
				job_uuid: jobUuid,
				staff_uuid: r.uuid,
				allocation_date: now.slice(0, 10) + " 00:00:00",
				allocated_timestamp: now,
				// Matches what ServiceM8 writes for its own allocations: a far-off
				// expiry rather than none, and a nominal duration.
				expiry_timestamp: `${Number(now.slice(0, 4)) + 10}${now.slice(4)}`,
				estimated_duration: "60",
				...(allocationWindowUuid ? { allocation_window_uuid: allocationWindowUuid } : {}),
				...(env.SERVICEM8_NOTIFY_FROM_STAFF_UUID
					? { allocated_by_staff_uuid: env.SERVICEM8_NOTIFY_FROM_STAFF_UUID }
					: { allocated_by_staff_uuid: r.uuid }),
			})
		)
	);

	let allocated = 0;
	const failures = [];
	results.forEach((r, i) => {
		if (r.status === "fulfilled") {
			allocated++;
			return;
		}
		const reason = r.reason || {};
		failures.push({ staff: recipients[i].label, status: reason.status || 0, detail: reason.detail || reason.message || "" });
		console.error(
			`ServiceM8 allocate: allocating job ${jobUuid} to ${recipients[i].label} failed ` +
				`(HTTP ${reason.status || "?"}):`,
			reason.detail || reason.message || reason
		);
	});

	console.log(
		`ServiceM8 allocate: job ${jobUuid} allocated to ${allocated}/${recipients.length} ` +
			`(${recipients.map((r) => r.label).join(", ")})`
	);
	return { allocated, recipients: recipients.length, failures, allocationWindowUuid };
}

// Reports what the ServiceM8 side of a lead notification actually looks like:
// whether the key is set, who would be notified, whether the account has an
// allocation window, and -- given a job UUID -- the raw result of really
// allocating it. Exists because "no notification arrived" has several causes
// that are indistinguishable without asking ServiceM8 directly.
export async function diagnoseServiceM8(env, jobUuid) {
	const report = { apiKeyConfigured: !!env.SERVICEM8_API_KEY };
	if (!report.apiKeyConfigured) {
		report.problem = "SERVICEM8_API_KEY is not set on the Worker.";
		return report;
	}

	try {
		const rows = await sm8Get(env, "/staff.json");
		const active = (Array.isArray(rows) ? rows : []).filter((s) => String(s.active) !== "0");
		report.activeStaff = active.map((s) => ({
			name: staffLabel(s),
			uuid: s.uuid,
			canReceivePush: String(s.can_receive_push_notification) === "1",
		}));
	} catch (e) {
		report.staffLookupError = e.message;
	}

	try {
		report.notifyTargets = (await resolveNotifyStaff(env)).map((r) => r.label);
	} catch (e) {
		report.notifyTargetsError = e.message;
	}

	try {
		const windows = await sm8Get(env, "/allocationwindow.json");
		report.allocationWindows = (Array.isArray(windows) ? windows : [])
			.filter((w) => String(w.active) !== "0")
			.map((w) => ({ uuid: w.uuid, name: w.name || w.description || "" }));
	} catch (e) {
		report.allocationWindowError = e.message;
	}

	if (jobUuid) report.allocation = await allocateJobToStaff(env, jobUuid);
	return report;
}

const BUSINESS_TIMEZONE = "Australia/Sydney";

// "YYYY-MM-DD HH:MM:SS" in the account's local time, which is the only date
// format the ServiceM8 API accepts. Built from Intl parts rather than string
// surgery on an ISO timestamp so it stays correct across daylight saving.
function serviceM8Timestamp(timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const get = (t) => (parts.find((p) => p.type === t) || {}).value || "00";
	// en-CA gives 24-hour time, but midnight can come back as "24" in some
	// runtimes -- normalise it so the string is always a valid timestamp.
	const hour = get("hour") === "24" ? "00" : get("hour");
	return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

function truncate(text, max) {
	const t = String(text || "").trim();
	return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Sends one in-app ServiceM8 message per recipient, about `jobUuid`.
//
// Deliberately never throws or rejects: this is a courtesy ping about a job
// that has already been created, and a messaging failure must not take down
// the enquiry that triggered it. Every failure path is logged instead, since
// a notification that quietly stops working is worse than none at all.
export async function notifyStaffOfNewJob(env, jobUuid, lines) {
	if (!env.SERVICEM8_API_KEY || !jobUuid) return { sent: 0 };

	let recipients;
	try {
		recipients = await resolveNotifyStaff(env);
	} catch (e) {
		console.error("ServiceM8 notify: couldn't resolve recipients:", e && (e.stack || e.message));
		return { sent: 0 };
	}

	if (!recipients.length) {
		console.error(
			"ServiceM8 notify: nobody to notify -- set SERVICEM8_NOTIFY_STAFF_EMAIL (or " +
				"SERVICEM8_NOTIFY_STAFF_UUID), or enable push notifications for a staff member in the ServiceM8 app"
		);
		return { sent: 0 };
	}

	// ServiceM8 shows the first line of the message in the push itself, so the
	// customer's name and the service lead, and the detail follows.
	const message = truncate(lines.filter(Boolean).join("\n"), 900);
	const fromStaffUuid = env.SERVICEM8_NOTIFY_FROM_STAFF_UUID || "";

	const results = await Promise.allSettled(
		recipients.map((r) =>
			sm8Create(env, "staffmessage", {
				to_staff_uuid: r.uuid,
				// from_staff_uuid is REQUIRED by ServiceM8 (confirmed live 2026-08-05:
				// omitting it entirely 400s with "is mandatory") -- there's no
				// "no sender" option. Prefer the configured sender; otherwise fall back
				// to the recipient's own uuid, which risks being treated as "your own
				// message" and not pushed as prominently, but still succeeds -- far
				// better than the message failing outright every time.
				from_staff_uuid: fromStaffUuid || r.uuid,
				message,
				regarding_job_uuid: jobUuid,
			})
		)
	);

	let sent = 0;
	results.forEach((r, i) => {
		if (r.status === "fulfilled") sent++;
		else
			console.error(
				`ServiceM8 notify: message to ${recipients[i].label} failed:`,
				r.reason && (r.reason.stack || r.reason.message)
			);
	});

	console.log(
		`ServiceM8 notify: job ${jobUuid} -> in-app message sent to ${sent}/${recipients.length} ` +
			`(${recipients.map((r) => r.label).join(", ")})`
	);
	return { sent, recipients: recipients.length };
}

// --- Online booking widget: read/write the calendar directly -------------
//
// The lead flow above (createServiceM8Lead) opens a Quote and lets a human
// pick a time later. The booking widget is the opposite: the customer picks
// an exact slot on the website, so by the time we talk to ServiceM8 the job
// needs to land as an already-confirmed Work Order with a jobactivity that
// occupies the calendar -- and before that, we need to know which slots are
// actually free by reading the calendar back.

// Parse a ServiceM8 "YYYY-MM-DD HH:MM:SS" Sydney-local timestamp (as seen on
// jobactivity/vacation start_date/end_date) into an absolute epoch-ms
// instant. Splits the string rather than handing it to Date() -- Date would
// parse it in the runtime's own timezone (UTC on Workers), not Sydney's --
// and defers the actual DST-safe conversion to sydneyLocalToMs so this file
// never re-derives its own timezone maths. Returns NaN on anything that
// doesn't match the shape, so a bad row gets filtered out rather than
// silently treated as instant 0.
function parseServiceM8Timestamp(s) {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || ""));
	if (!m) return NaN;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const min = Number(m[5]);
	const sec = Number(m[6]);
	return sydneyLocalToMs(year, month, day, hour, min) + sec * 1000;
}

// Real busy intervals for STAFF_UUID between two instants, as
// [{ startMs, endMs }, ...] -- the shape computeSlots (availability.js)
// expects as `occupancy`. Two ServiceM8 objects can make a staff member
// busy: jobactivity (scheduled work) and vacation (leave/blocked time).
//
// Both queries use the same overlap filter -- `start_date lt TO and
// end_date gt FROM` -- rather than "starts within the window", so a job that
// starts before the window but is still running when it opens (or starts
// inside the window and runs past its end) is still caught.
//
// Fails safe: a broken jobactivity read throws (the caller must not offer
// slots computed from unknown occupancy -- no availability beats wrong
// availability). A broken vacation read only logs and is dropped, because
// jobactivity is the occupancy source we're sure of and vacation's exact
// object/field shape is unconfirmed (see task report).
export async function readStaffOccupancy(env, fromMs, toMs) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");

	const fromStr = formatSydneyTimestamp(fromMs);
	const toStr = formatSydneyTimestamp(toMs);
	const overlapFilter = `staff_uuid eq '${STAFF_UUID}' and start_date lt '${toStr}' and end_date gt '${fromStr}'`;

	const jobActivityRows = await sm8Get(env, `/jobactivity.json?%24filter=${encodeURIComponent(overlapFilter)}`);
	const jobActivityIntervals = (Array.isArray(jobActivityRows) ? jobActivityRows : [])
		.filter((r) => String(r.active) !== "0")
		.map((r) => ({ startMs: parseServiceM8Timestamp(r.start_date), endMs: parseServiceM8Timestamp(r.end_date) }))
		.filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs);

	let vacationIntervals = [];
	try {
		const vacationRows = await sm8Get(env, `/vacation.json?%24filter=${encodeURIComponent(overlapFilter)}`);
		vacationIntervals = (Array.isArray(vacationRows) ? vacationRows : [])
			.filter((r) => String(r.active) !== "0")
			.map((r) => ({ startMs: parseServiceM8Timestamp(r.start_date), endMs: parseServiceM8Timestamp(r.end_date) }))
			.filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs);
	} catch (e) {
		console.error(
			"ServiceM8 readStaffOccupancy: vacation read failed, continuing on jobactivity occupancy only:",
			e && e.message
		);
	}

	return jobActivityIntervals.concat(vacationIntervals);
}

// Like createServiceM8Lead, but for a booking the customer has already
// locked into a specific slot -- so the job is created straight into
// "Work Order" status, not "Quote", and there's no open-Quote dedup step (a
// booking is always a new confirmed job, never a stand-in for some earlier
// enquiry). Customer dedup is otherwise identical to createServiceM8Lead:
// never create a second company/contact for an email/phone ServiceM8
// already has.
//   lead = { name, email, phone, address, description }
//   opts = { status }  -- job status to create with; defaults to "Work Order".
//                         The pricing widget passes status:"Quote" when the
//                         customer asked for a custom quote instead of taking
//                         the fixed online price -- everything else about the
//                         flow (slot locked, jobactivity scheduled) is unchanged.
// Returns { jobUuid, jobUrl }.
export async function createWorkOrderJob(env, lead, opts = {}) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");

	const { name, email, phone, address, description } = lead;
	const { first, last } = splitName(name);

	// 1. Find or create the customer (never duplicate an existing email/phone).
	let companyUuid = await findExistingCompanyUuid(env, email, phone);
	if (!companyUuid) {
		const baseName = name || email || "Website booking";
		// address goes on the client card as well as the job -- a customer who
		// booked online used to end up with a blank address on their record.
		const companyFields = { active: 1, is_individual: 1, address: address || "" };
		try {
			companyUuid = await sm8Create(env, "company", { name: baseName, ...companyFields });
		} catch (e) {
			// ServiceM8 enforces company-NAME uniqueness as a separate constraint
			// from our email/phone dedup above -- two unrelated customers can
			// share a display name (or the same literal test name gets reused),
			// and that has nothing to do with whether they're the same contact.
			// Confirmed live 2026-08-05: this 400s even though findExistingCompanyUuid
			// correctly found no matching contact. Disambiguate with email/phone
			// (guaranteed to differ per distinct customer) and retry once.
			if (e && e.status === 400 && /name must be unique/i.test(e.detail || e.message || "")) {
				const suffix = normEmail(email) || auPhone(phone) || String(Date.now());
				companyUuid = await sm8Create(env, "company", { name: `${baseName} (${suffix})`, ...companyFields });
			} else {
				throw e;
			}
		}
		await sm8Create(env, "companycontact", {
			company_uuid: companyUuid,
			first: first || name || "Website",
			last,
			email: normEmail(email),
			// Mobile only, in national format: this is the number staff dial, and
			// writing it to `phone` as well just duplicated it into a field the
			// office doesn't use.
			mobile: auPhone(phone),
			type: "JOB",
			is_primary_contact: 1,
			active: 1,
		});
	}

	// 2. Create the job (Work Order by default) + its job contact.
	const jobUuid = await sm8Create(env, "job", {
		status: opts.status || "Work Order",
		company_uuid: companyUuid,
		job_description: description || "",
		job_address: address || "",
		// Set from the booked service via booking-config's SERVICE_CATEGORIES, so
		// an online booking lands in the same category the office would have
		// picked by hand. Omitted entirely when the service has no mapping.
		...(lead.categoryUuid ? { category_uuid: lead.categoryUuid } : {}),
	});
	await sm8Create(env, "jobcontact", {
		job_uuid: jobUuid,
		first: first || name || "Website",
		last,
		email: normEmail(email),
		mobile: auPhone(phone),
		type: "JOB",
	});

	return { jobUuid, jobUrl: jobUrl(jobUuid) };
}

// Adds a note to the job -- the Notes section on the job in ServiceM8, which
// is where free text about a job belongs. The job description is the headline
// (service, price, where it came from); whatever the customer actually typed
// into the form goes here instead, so a long note can't bury the description.
//
// Throws on failure so the caller can decide: every caller treats this as
// best-effort, because the customer's words are also in the office email and
// a note that didn't save must never fail a booking that did.
export async function createJobNote(env, jobUuid, note) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");
	if (!jobUuid || !note) return null;

	return sm8Create(env, "note", {
		related_object: "job",
		related_object_uuid: jobUuid,
		note,
		active: 1,
	});
}

// Puts the booking on Phill's ServiceM8 calendar -- this is the write that
// actually occupies the slot; readStaffOccupancy above reads exactly this
// object back, so a booking is only really "locked in" once this succeeds.
// startIso/endIso are "YYYY-MM-DD HH:MM:SS" Sydney local, same shape as
// everywhere else in this file. activity_was_scheduled:1 marks this as a
// real scheduled booking (as opposed to a logged/completed activity); active
// is required for it to show up at all, same as every other create here.
// Returns the new jobactivity uuid.
export async function createJobActivity(env, { jobUuid, staffUuid, startIso, endIso }) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");

	return sm8Create(env, "jobactivity", {
		job_uuid: jobUuid,
		staff_uuid: staffUuid,
		start_date: startIso,
		end_date: endIso,
		activity_was_scheduled: 1,
		active: 1,
	});
}

// Puts the fixed online price on the job as an invoice line item, so the
// ServiceM8 invoice reflects what the customer was quoted on the website
// without staff re-entering it by hand. Called best-effort by the booking
// pipeline (src/booking.js) -- a failure here must never undo an
// already-confirmed booking, so this throws on error and it's the caller's
// job to catch it.
//
// GST: confirmed via ServiceM8's own field docs -- `jobmaterial.price` is
// always EX-tax ("unit price of the material excluding tax"), while the
// customer-facing invoice/quote amount is the separate `displayed_amount`
// field, whose tax treatment is controlled by `displayed_amount_is_tax_inclusive`.
// `amount` here is our inc-GST quoted price, so it goes in `displayed_amount`
// (flagged as tax-inclusive) and is divided by 1.1 (AU GST) for `price`.
// Confirmed live 2026-08-05: without `displayed_amount` set at all, ServiceM8
// rejects the create with 400 "Provided displayed_amount is incorrect."
export async function createInvoiceLineItem(env, { jobUuid, name, amount }) {
	if (!env.SERVICEM8_API_KEY) throw new Error("ServiceM8 is not configured (no API key set)");

	const exGstPrice = Math.round((amount / 1.1) * 100) / 100;

	return sm8Create(env, "jobmaterial", {
		job_uuid: jobUuid,
		name,
		quantity: 1,
		price: exGstPrice,
		displayed_amount: amount,
		displayed_amount_is_tax_inclusive: true,
	});
}
