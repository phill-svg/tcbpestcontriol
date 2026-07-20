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
	return "https://go.servicem8.com/#job/" + uuid;
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
		throw new Error("ServiceM8 POST " + resource + " -> " + res.status + " " + detail.slice(0, 200));
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
