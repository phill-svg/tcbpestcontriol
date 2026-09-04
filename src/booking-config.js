// Single source of truth for the online booking widget's fixed rules --
// staff member, business timezone, slot geometry, and the services a customer
// is allowed to self-book. Deliberately data-only (constants + one tiny
// predicate): the slot maths lives in availability.js and the ServiceM8/router
// wiring lives elsewhere, so all three can share these numbers without any of
// them re-deriving (and drifting from) the others.

// Phill Johnston only -- every online booking is allocated to this one staff
// member, and availability is computed strictly against his ServiceM8 diary.
export const STAFF_UUID = "64965c17-f39c-4a54-9639-2303d0458beb";

// The account runs in Sydney time; the Worker itself runs in UTC. Every
// wall-clock number below is a Sydney wall-clock number, resolved to real
// instants by the DST-safe helpers in availability.js.
export const BUSINESS_TIMEZONE = "Australia/Sydney";

// Candidate start times step on this grid; a job must finish by the closing
// edge, and real occupancy is padded by BUFFER_MIN on both sides (travel /
// setup) before it's tested against a candidate slot.
export const SLOT_GRANULARITY_MIN = 30;
export const BUFFER_MIN = 15;

// Rolling booking window: from "today" in Sydney out this many calendar days.
export const HORIZON_DAYS = 28;

// Online-bookable hours MASK, keyed by JS getDay() weekday (0=Sun..6=Sat).
// Applied ON TOP of real ServiceM8 free/busy -- this is intentionally stricter
// than ServiceM8's own working hours so the website never offers a slot the
// business doesn't want taken online. Each entry is a list of [open, close]
// wall-clock segments; an empty list means "closed, not bookable online".
export const ONLINE_HOURS = {
	0: [], // Sun closed
	1: [["08:00", "16:00"]], // Mon
	2: [["08:00", "16:00"]], // Tue
	3: [["08:00", "16:00"]], // Wed
	4: [["08:00", "16:00"]], // Thu
	5: [["08:00", "16:00"]], // Fri
	6: [["08:00", "12:00"]], // Sat
};

// The six services a customer may book online, defined ONCE each. Everything
// the website needs to make the booking look like the job the office would
// have raised by hand lives on the one row: how long it takes, what it is
// called, and the three ServiceM8 records that give the job its identity.
//
// One row per service on purpose. These used to be five separate objects all
// keyed by the same six strings with nothing holding them level, and they
// drifted: `termite-treatment` had a template but no category, so a termite
// treatment booked online landed uncategorised while every other service
// matched. The categories comment had also come adrift from its own map and
// sat above the templates, which is how that went unnoticed. A missing field
// is now a visible hole in a row rather than an absence you have to notice.
//
// All three uuids are read straight off the ServiceM8 account -- a NAME is
// silently ignored by the API, which looks exactly like nothing happening.
//   category : Settings > Job Categories. Where the job files.
//   template : Settings > Job Templates. Cloned via
//              POST /jobtemplate/{uuid}/job.json, which brings the checklists,
//              tasks, materials and custom fields across. Note the names do
//              not line up with the categories -- the 'Premium Pest Treatment'
//              category pairs with the 'Premium Control Treatment' template.
//   badges   : Settings > Badges. A list, since a job can carry several.
//
// Any of the three may be null/[]: the job is still created, just without that
// piece. Nothing here is guessed -- a service with no obvious counterpart in
// ServiceM8 gets null rather than the nearest-looking record.
export const SERVICES = {
	"general-pest": {
		label: "General pest treatment",
		durationMin: 60,
		category: "97af1d3c-07ac-4aae-8862-23184055ce5b", // Premium Pest Treatment
		template: "4122de2a-6289-46e5-9b26-2319a3e5c2ed", // Premium Control Treatment
		badges: [],
	},
	"ants-spiders-roaches": {
		label: "Ants / Spiders / Cockroaches",
		durationMin: 60,
		category: "97af1d3c-07ac-4aae-8862-23184055ce5b", // Premium Pest Treatment
		template: "4122de2a-6289-46e5-9b26-2319a3e5c2ed", // Premium Control Treatment
		badges: [],
	},
	"wasps-bees": {
		label: "Wasps / Bees",
		durationMin: 45,
		category: "97af1d3c-07ac-4aae-8862-23184055ce5b", // Premium Pest Treatment
		template: "4122de2a-6289-46e5-9b26-2319a3e5c2ed", // Premium Control Treatment
		badges: [],
	},
	"rodents": {
		label: "Rodents (mice & rats)",
		durationMin: 60,
		category: "65374f33-5111-4411-976d-232fc24a43ab", // Rodent Treatment
		template: "1e590dc3-57d5-468b-a752-232d13aebcfd", // Rodent Pest Treatment
		badges: [],
	},
	"termite-inspection": {
		label: "Termite inspection",
		durationMin: 60,
		category: "41bd4556-8fed-4626-b853-241e0b8b876b", // Termite Inspection
		template: "d44e1074-edc9-4e55-82aa-2319a559b6cd", // Termite Inspection
		badges: [],
	},
	"termite-treatment": {
		label: "Termite Treatment",
		durationMin: 60,
		// Was missing entirely, so these booked in with no category at all while
		// the other five matched. 'Termite Management Treatment' is the account's
		// only termite TREATMENT category -- 'Termite Inspection' is the
		// inspection above, and pairs with a different template.
		category: "4b0df417-bd76-44a5-b9b9-231843331c3b", // Termite Management Treatment
		template: "ad68a5b4-ded4-479e-b240-235c3f04a14d", // Termite Treatment
		badges: [],
	},
};

// The five lookups the rest of the code already reads, projected off SERVICES
// so there is still exactly one place to edit a service. Derived rather than
// hand-written: that is the whole point of the table above.
const project = (pick) => Object.fromEntries(Object.entries(SERVICES).map(([key, svc]) => [key, pick(svc)]));

// Duration (minutes) of each bookable service. ONLY these keys are bookable
// online; anything else is rejected before it reaches the slot maths.
export const SERVICE_DURATIONS = project((s) => s.durationMin);

// Human labels -- used when creating the ServiceM8 job and in the
// customer/staff emails.
export const SERVICE_LABELS = project((s) => s.label);

// ServiceM8 job category, so a job created from the website lands in the same
// category the office would have picked by hand.
export const SERVICE_CATEGORIES = project((s) => s.category);

// ServiceM8 job template. A service with no template falls back to a plain job
// create, which still works -- it just arrives without the checklists.
export const SERVICE_TEMPLATES = project((s) => s.template);

// Badges to stamp on the job.
//
// Templates do NOT carry badges, despite a note here that said they did. That
// was drawn from one booking that arrived badged -- but ServiceM8 applies a
// CLIENT's badges to every new job for that client, and that booking was for
// an existing client whose card already had them. A new customer gets a blank
// client card, so the job arrives bare: job #966 (2026-09-04) cloned its
// template's "service report" checklist and still had no badges. Job Templates
// pre-fill requirements, checklists, documentation and materials -- badges are
// not on that list.
//
// So a badge belonging to a SERVICE goes in the table above. A badge belonging
// to a CUSTOMER still belongs on their client card in ServiceM8, where it is
// applied to every future job of theirs automatically.
export const SERVICE_BADGES = project((s) => s.badges);

// True only for a service the widget is allowed to book. Callers validate up
// front; availability.js also guards defensively.
//
// hasOwn, not `in`: `in` walks the prototype chain, so "__proto__",
// "constructor" and "toString" all passed this check. The request then got as
// far as the slot maths with SERVICE_DURATIONS[key] being an inherited
// function or Object.prototype instead of a number.
export function isBookableService(key) {
	return Object.hasOwn(SERVICES, key);
}

// Fixed online prices, keyed the same as SERVICE_DURATIONS/SERVICE_LABELS.
// Authoritative here and ONLY here -- the front end (assets/js/booking.js)
// embeds a display copy of this data to show a live price before submit, but
// every price actually charged is computed server-side via computePrice()
// below so a tampered client payload can never change what lands on the
// ServiceM8 invoice. "modifier" says what follow-up question (if any) decides
// the price: "bedrooms" or "property" pick from `prices`, "none" is a flat
// `price` with no follow-up.
export const PRICING = {
	"general-pest": { modifier: "bedrooms", prices: { "1-3": 249, "4-5": 289, "6+": 349 } },
	"ants-spiders-roaches": { modifier: "bedrooms", prices: { "1-3": 249, "4-5": 289, "6+": 349 } },
	"termite-inspection": { modifier: "property", prices: { subfloor: 320, slab: 289 } },
	"rodents": { modifier: "none", price: 289 },
	"wasps-bees": { modifier: "none", price: 289 },
	"termite-treatment": { modifier: "none", price: 0 },
};

// Question label shown above the modifier <select>, keyed by modifier type.
export const MODIFIER_LABELS = {
	bedrooms: "How many bedrooms?",
	property: "Property type",
};

// Options offered in the modifier <select>, keyed by modifier type. `label`
// is the human-facing text -- also what ends up in the ServiceM8 job
// description and invoice line-item name via computePrice()'s modifierLabel.
export const MODIFIER_OPTIONS = {
	bedrooms: [
		{ value: "1-3", label: "1–3 bedrooms" },
		{ value: "4-5", label: "4–5 bedrooms" },
		{ value: "6+", label: "6 or more bedrooms" },
	],
	property: [
		{ value: "subfloor", label: "With subfloor" },
		{ value: "slab", label: "On a slab (no subfloor)" },
	],
};

// What follow-up question (if any) a service's price depends on. "none" is
// the safe default for an unknown key so an unrecognised service key never
// pretends to need a modifier it has no options for.
export function getModifierType(serviceKey) {
	const entry = PRICING[serviceKey];
	return entry ? entry.modifier : "none";
}

// Resolves a service key + the customer's chosen modifier value into the
// fixed price to charge. This is the ONE place a price is decided -- callers
// (src/index.js's handleBooking) must always go through this rather than
// trusting anything posted by the client.
//   "none"              -> modifierValue is ignored, flat `price`.
//   "bedrooms"/"property" -> looks up `prices[modifierValue]`; an unknown or
//                            missing modifierValue is a hard failure (ok:false)
//                            since we never charge a guessed price.
// Returns { ok:false } on anything invalid, otherwise
// { ok:true, amount, modifierLabel } where modifierLabel is "" for "none".
export function computePrice(serviceKey, modifierValue) {
	const entry = PRICING[serviceKey];
	if (!entry) return { ok: false };

	if (entry.modifier === "none") {
		return { ok: true, amount: entry.price, modifierLabel: "" };
	}

	const options = MODIFIER_OPTIONS[entry.modifier] || [];
	const option = options.find((o) => o.value === modifierValue);
	const amount = entry.prices ? entry.prices[modifierValue] : undefined;
	if (!option || amount === undefined) return { ok: false };

	return { ok: true, amount, modifierLabel: option.label };
}
