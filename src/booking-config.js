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

// Duration (minutes) of each bookable service. ONLY these five keys are
// bookable online; anything else is rejected before it reaches the slot maths.
export const SERVICE_DURATIONS = {
	"general-pest": 60,
	"termite-inspection": 60,
	"ants-spiders-roaches": 60,
	"rodents": 60,
	"wasps-bees": 45,
	"termite-treatment": 60,
};

// Human labels for each service key -- used later when creating the ServiceM8
// job and in the customer/staff emails, kept here so the label can never
// disagree with the duration it's paired with.
export const SERVICE_LABELS = {
	"general-pest": "General pest treatment",
	"termite-inspection": "Termite inspection",
	"ants-spiders-roaches": "Ants / Spiders / Cockroaches",
	"rodents": "Rodents (mice & rats)",
	"wasps-bees": "Wasps / Bees",
	"termite-treatment": "Termite Treatment"
};

// True only for a service the widget is allowed to book. Callers validate up
// front; availability.js also guards defensively.
export function isBookableService(key) {
	return key in SERVICE_DURATIONS;
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
