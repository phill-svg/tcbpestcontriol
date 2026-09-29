// Address lookup for the /book form: the customer starts typing, picks their
// address from a list, and street, suburb and postcode fill themselves in.
//
// Backed by Google Places API (New), but always through these two Worker
// routes so the API key stays a secret (GOOGLE_MAPS_KEY) and never reaches a
// browser. With no key set both routes answer 503 and the form's script stops
// asking -- the fields still work by typing, exactly as they did before.
//
//   GET /api/address/suggest?q=12+smith&session=<token>  -> { ok, suggestions: [{ id, text }] }
//   GET /api/address/details?id=<placeId>&session=<token> -> { ok, street, suburb, state, postcode }
//
// The session token ties the typing and the final pick into one Google
// "session", which is billed once rather than per keystroke.

const PLACES = "https://places.googleapis.com/v1";

// Bias results toward Canberra without ruling anything out: a 50 km circle
// from Civic reaches Queanbeyan, Googong, Bungendore and Wamboin.
const CANBERRA_BIAS = { circle: { center: { latitude: -35.2809, longitude: 149.13 }, radius: 50000 } };

// ACT postcodes: 2600-2618 (the 26xx block below Queanbeyan's 2619/2620) and
// the 29xx block. Everything else the site serves is NSW.
export function stateForPostcode(postcode) {
	const n = Number(postcode);
	if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
	return "NSW";
}

// Google's addressComponents -> the three fields on the form (plus state).
export function parseAddressComponents(components) {
	const pick = (type, short) => {
		const c = (components || []).find((x) => (x.types || []).includes(type));
		return c ? String((short ? c.shortText : c.longText) || "") : "";
	};
	const unit = pick("subpremise");
	const number = pick("street_number");
	const route = pick("route");
	const houseNo = unit && number ? `${unit}/${number}` : number || unit;
	return {
		street: [houseNo, route].filter(Boolean).join(" "),
		suburb: pick("locality") || pick("sublocality") || pick("postal_town"),
		state: pick("administrative_area_level_1", true),
		postcode: pick("postal_code"),
	};
}

function json(status, obj, extraHeaders) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

// Only our own pages may use the lookup -- otherwise anyone could spend the
// Google quota through us. Browsers always send Origin or Referer on a
// same-site fetch, so a request carrying neither isn't from the form.
function fromOurSite(request) {
	const own = new URL(request.url).host;
	const src = request.headers.get("origin") || request.headers.get("referer") || "";
	try {
		return new URL(src).host === own;
	} catch {
		return false;
	}
}

// Session tokens come from the browser; keep them to something harmless.
function cleanSession(s) {
	return /^[A-Za-z0-9_-]{8,64}$/.test(s || "") ? s : undefined;
}

export async function handleAddressLookup(request, env) {
	const url = new URL(request.url);
	if (!env.GOOGLE_MAPS_KEY) return json(503, { ok: false, error: "Address lookup is not set up." });
	if (!fromOurSite(request)) return json(403, { ok: false, error: "Forbidden." });

	const session = cleanSession(url.searchParams.get("session"));
	const headers = { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY };

	try {
		if (url.pathname === "/api/address/suggest") {
			const q = String(url.searchParams.get("q") || "").trim();
			if (q.length < 3 || q.length > 120) return json(200, { ok: true, suggestions: [] });
			const res = await fetch(`${PLACES}/places:autocomplete`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					input: q,
					includedRegionCodes: ["au"],
					locationBias: CANBERRA_BIAS,
					languageCode: "en-AU",
					...(session ? { sessionToken: session } : {}),
				}),
			});
			if (!res.ok) return json(502, { ok: false, error: "Lookup failed." });
			const data = await res.json();
			const suggestions = (data.suggestions || [])
				.map((s) => s.placePrediction)
				.filter(Boolean)
				.slice(0, 5)
				.map((p) => ({ id: p.placeId, text: (p.text && p.text.text) || "" }));
			return json(200, { ok: true, suggestions }, { "cache-control": "private, max-age=300" });
		}

		if (url.pathname === "/api/address/details") {
			const id = String(url.searchParams.get("id") || "");
			if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return json(400, { ok: false, error: "Bad place id." });
			const qs = new URLSearchParams({ languageCode: "en-AU" });
			if (session) qs.set("sessionToken", session);
			const res = await fetch(`${PLACES}/places/${id}?${qs}`, {
				headers: { ...headers, "X-Goog-FieldMask": "addressComponents" },
			});
			if (!res.ok) return json(502, { ok: false, error: "Lookup failed." });
			const data = await res.json();
			return json(200, { ok: true, ...parseAddressComponents(data.addressComponents) });
		}
	} catch {
		return json(502, { ok: false, error: "Lookup failed." });
	}

	return json(404, { ok: false, error: "Not found." });
}
