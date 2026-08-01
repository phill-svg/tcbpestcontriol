import { buildPushHTTPRequest } from "@pushforge/builder";

// Sends one Web Push notification to one stored subscription. Returns
// { result, status, detail } where result is:
//   "ok"    delivered to the push service
//   "gone"  the subscription is dead -- caller should delete it
//   "error" a transient failure; the subscription is left alone
// status and detail carry the push service's own answer, which is the only
// way to tell "nobody is subscribed" apart from "the key is wrong" when a
// notification doesn't arrive. See handlePushTest in chat-hub.js.
export async function sendPushNotification(env, subscription, payload) {
	let privateJwk;
	try {
		privateJwk = JSON.parse(env.VAPID_PRIVATE_KEY);
	} catch {
		// VAPID_PRIVATE_KEY hasn't been set yet (or isn't valid JSON) -- treat
		// push as not configured rather than throwing, so the rest of the chat
		// flow (which doesn't depend on push) keeps working regardless. Say so
		// in the logs though: silently returning made a missing secret look
		// identical to a device that simply wasn't subscribed.
		console.error("Push send skipped: VAPID_PRIVATE_KEY is missing or not valid JSON");
		return { result: "error", status: 0, detail: "VAPID_PRIVATE_KEY is missing or not valid JSON" };
	}

	// Building the request derives keys from what's stored against the
	// subscription. A row with truncated or malformed keys throws in here
	// rather than returning, which would take down the whole fan-out (and the
	// diagnostics endpoint with it) over one bad device.
	let request;
	try {
		request = await buildPushHTTPRequest({
			privateJWK: privateJwk,
			subscription: {
				endpoint: subscription.endpoint,
				keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			},
			message: {
				payload,
				adminContact: env.VAPID_SUBJECT,
				options: {
					// A phone that's off-network, asleep in a pocket or on a patchy
					// signal for more than a few minutes is the normal case, not the
					// exception -- a 5 minute TTL had Apple's push service dropping
					// those notifications before the device ever came back. Half a day
					// still gets a late "new chat message" in front of whoever's on
					// call, which beats it never arriving.
					ttl: 43200,
					urgency: "high",
				},
			},
		});
	} catch (e) {
		const detail = (e && e.message) || "could not build the push request";
		console.error("Push send failed to build", safeEndpointHost(subscription.endpoint), detail);
		return { result: "error", status: 0, detail };
	}

	const { endpoint, headers, body } = request;

	let response;
	try {
		response = await fetch(endpoint, { method: "POST", headers, body });
	} catch (e) {
		const detail = (e && e.message) || "network error";
		console.error("Push send network failure", safeEndpointHost(subscription.endpoint), detail);
		return { result: "error", status: 0, detail };
	}

	// Apple's gateway answers 201, others may use 200/202 -- accept the whole
	// success range rather than the single status one vendor happens to send.
	if (response.ok) return { result: "ok", status: response.status, detail: "" };
	if (response.status === 404 || response.status === 410) {
		return { result: "gone", status: response.status, detail: "subscription no longer valid" };
	}

	// Anything else (403 for a bad VAPID signature, 413 for an oversized
	// payload, 429, 5xx) used to vanish without trace, which made "it isn't
	// sending" impossible to diagnose. Log it -- observability is on.
	let detail = "";
	try {
		detail = (await response.text()).slice(0, 200);
	} catch {}
	console.error("Push send failed", response.status, safeEndpointHost(subscription.endpoint), detail);
	return { result: "error", status: response.status, detail };
}

// Never throws on a malformed stored endpoint -- used only for log lines, and
// a logging call that crashes would hide the very error it was reporting.
function safeEndpointHost(endpoint) {
	try {
		return new URL(endpoint).host;
	} catch {
		return "unknown";
	}
}
