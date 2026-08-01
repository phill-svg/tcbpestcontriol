// ServiceM8 integration: turn a chat lead into a Quote job.
//
// Auth is a single account API key (env.SERVICEM8_API_KEY) sent as the
// `X-API-Key` header -- confirmed working against the live API. Plain fetch(),
// so this runs fine from the Durable Object.
//
// Deduplication is the whole point of the search-before-create flow here: we
// never create a second client for an email/phone that already exists, and we
// won't silently open a second Quote job for a customer who already has one.

const BASE = "https://api.servicem8.com/api_1.0";

function headers(env) {
	return { "X-API-Key": env.SERVICEM8_API_KEY, "Content-Type": "application/json" };
}

function normEmail(e) {
	return (e || "").trim().toLowerCase();
}

// ServiceM8 stores AU numbers digits-only with country code (e.g. 61425080413).
// Normalise so our comparisons and writes match that shape.
function normPhone(p) {
	let d = (p || "").replace(/\D/g, "");
	if (!d) return "";
	if (d.startsWith("0")) d = "61" + d.slice(1);
	else if (d.length === 9 && !d.startsWith("61")) d = "61" + d; // 4xxxxxxxx -> 614xxxxxxxx
	return d;
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
async function findExistingCompanyUuid(env, email, phone) {
	const e = normEmail(email);
	if (e) {
		const rows = await sm8Get(env, `/companycontact.json?%24filter=${encodeURIComponent(`email eq '${e}'`)}`);
		const hit = Array.isArray(rows) && rows.find((r) => normEmail(r.email) === e && String(r.active) !== "0");
		if (hit) return hit.company_uuid;
	}
	const p = normPhone(phone);
	if (p) {
		const rows = await sm8Get(env, `/companycontact.json?%24filter=${encodeURIComponent(`phone eq '${p}'`)}`);
		const hit =
			Array.isArray(rows) &&
			rows.find((r) => (normPhone(r.phone) === p || normPhone(r.mobile) === p) && String(r.active) !== "0");
		if (hit) return hit.company_uuid;
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
		});
		await sm8Create(env, "companycontact", {
			company_uuid: companyUuid,
			first: first || name || "Website",
			last,
			email: normEmail(email),
			phone: normPhone(phone),
			mobile: normPhone(phone),
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
	});
	await sm8Create(env, "jobcontact", {
		job_uuid: jobUuid,
		first: first || name || "Website",
		last,
		email: normEmail(email),
		phone: normPhone(phone),
		mobile: normPhone(phone),
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
				// Left unset unless configured -- a message addressed from the same
				// person it's going to is the one case that risks being treated as
				// "your own message" and not pushed.
				...(fromStaffUuid ? { from_staff_uuid: fromStaffUuid } : {}),
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
