// Address lookup for the /book form: the customer starts typing, picks their
// address from a list, and street, suburb and postcode fill themselves in.
//
// Backed by Photon (photon.komoot.io), a free search-as-you-type service over
// OpenStreetMap data -- no key, no account. Google Places was the first
// choice but wants a card and an upfront payment. OpenStreetMap has most
// Canberra houses, but not every one: when only the street is known, the
// house number the customer typed is kept, so the pick still fills in right.
//
//   GET /api/address/suggest?q=12+smith -> { ok, suggestions: [{ id, text, street, suburb, state, postcode }] }
//
// Always called through this Worker route rather than from the browser, so
// the results can be cleaned up and Cloudflare can cache repeat queries --
// Photon is a shared free service and asks for fair use.

const PHOTON = "https://photon.komoot.io/api/";

// Canberra plus the NSW towns the site serves: Queanbeyan, Googong,
// Jerrabomberra, Bungendore and Wamboin. minLon,minLat,maxLon,maxLat.
const REGION_BBOX = "148.7,-35.95,149.65,-34.95";

// ACT postcodes: 2600-2618 (the 26xx block below Queanbeyan's 2619/2620) and
// the 29xx block. Everything else the site serves is NSW.
export function stateForPostcode(postcode) {
	const n = Number(postcode);
	if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
	return "NSW";
}

const STATE_SHORT = { "Australian Capital Territory": "ACT", "New South Wales": "NSW" };

// One Photon result -> what the form needs, or null if it isn't an address
// someone lives or works at (a bus stop, a park, somewhere overseas).
// `typed` is what the customer typed. If it starts with a house number
// ("20" or "4/20"), that number wins: a street-only match, or a different
// house on the same street (OpenStreetMap often has 94 but not 3), would
// otherwise fill the form in with the wrong number or none.
export function parsePhotonFeature(feature, typed) {
	const p = (feature && feature.properties) || {};
	if (p.countrycode !== "AU") return null;

	let road;
	if (p.housenumber && p.street) road = p.street;
	else if (p.type === "street" && p.name) road = p.name;
	else return null;

	const m = String(typed || "").trim().match(/^(\d+[a-z]?(?:\/\d+[a-z]?)?)\s/i);
	const number = m ? m[1] : p.housenumber || "";
	const street = number ? `${number} ${road}` : road;

	const suburb = p.district || p.locality || p.city || "";
	const postcode = p.postcode && /^\d{4}$/.test(p.postcode) ? p.postcode : "";
	const state = postcode ? stateForPostcode(postcode) : STATE_SHORT[p.state] || "";
	const place = [suburb, state, postcode].filter(Boolean).join(" ");
	return {
		id: `${p.osm_type || ""}${p.osm_id || ""}`,
		text: [street, place].filter(Boolean).join(", "),
		street,
		suburb,
		state,
		postcode,
	};
}

function json(status, obj, extraHeaders) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

// Only our own pages may use the lookup, so the route can't be used as a
// free proxy onto Photon. Browsers always send Origin or Referer on a
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

export async function handleAddressLookup(request) {
	const url = new URL(request.url);
	if (url.pathname !== "/api/address/suggest") return json(404, { ok: false, error: "Not found." });
	if (!fromOurSite(request)) return json(403, { ok: false, error: "Forbidden." });

	const q = String(url.searchParams.get("q") || "").trim();
	if (q.length < 3 || q.length > 120) return json(200, { ok: true, suggestions: [] });

	const qs = new URLSearchParams({ q, limit: "10", lang: "en", bbox: REGION_BBOX });
	qs.append("layer", "house");
	qs.append("layer", "street");

	try {
		const res = await fetch(`${PHOTON}?${qs}`, {
			headers: { "User-Agent": "tcbpestcontrolcanberra.com.au booking form" },
			cf: { cacheTtl: 86400, cacheEverything: true },
		});
		if (!res.ok) return json(502, { ok: false, error: "Lookup failed." });
		const data = await res.json();
		const seen = new Set();
		const suggestions = [];
		for (const f of data.features || []) {
			const a = parsePhotonFeature(f, q);
			if (!a || seen.has(a.text)) continue;
			seen.add(a.text);
			suggestions.push(a);
			if (suggestions.length === 5) break;
		}
		return json(200, { ok: true, suggestions }, { "cache-control": "private, max-age=300" });
	} catch {
		return json(502, { ok: false, error: "Lookup failed." });
	}
}
