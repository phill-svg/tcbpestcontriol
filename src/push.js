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
		// flow (which doesn't depend on push) keeps working regardless.
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
			options: { ttl: 300, urgency: "high" },
		},
	});

	const response = await fetch(endpoint, { method: "POST", headers, body });

	if (response.status === 201) return "ok";
	if (response.status === 404 || response.status === 410) return "gone";
	return "error";
}
