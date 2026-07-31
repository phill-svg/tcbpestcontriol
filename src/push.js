import { buildPushHTTPRequest } from "@pushforge/builder";

// Sends one Web Push notification to one stored subscription. Returns
// "ok", "gone" (the subscription is dead -- caller should delete it), or
// "error" (a transient failure, subscription is left alone).
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
		return "error";
	}

	const { endpoint, headers, body } = await buildPushHTTPRequest({
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

	const response = await fetch(endpoint, { method: "POST", headers, body });

	// Apple's gateway answers 201, others may use 200/202 -- accept the whole
	// success range rather than the single status one vendor happens to send.
	if (response.ok) return "ok";
	if (response.status === 404 || response.status === 410) return "gone";

	// Anything else (403 for a bad VAPID signature, 413 for an oversized
	// payload, 429, 5xx) used to vanish without trace, which made "it isn't
	// sending" impossible to diagnose. Log it -- observability is on.
	let detail = "";
	try {
		detail = (await response.text()).slice(0, 200);
	} catch {}
	console.error("Push send failed", response.status, new URL(subscription.endpoint).host, detail);
	return "error";
}
