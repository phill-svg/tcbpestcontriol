// Getting an access token for a Google API from a service account.
//
// The alternative was the usual OAuth dance -- a consent screen, a redirect
// URL, a refresh token to store and renew. That is the right shape when an
// app acts on behalf of whoever is signed in. Here the Worker always acts as
// itself, reading one property that has been explicitly shared with it, so a
// service account is both simpler and narrower: nothing to consent to, no
// refresh token to leak, and access is revoked by removing one user in the
// Search Console settings page.
//
// The flow is the JWT bearer grant. The Worker signs a short-lived assertion
// with the service account's private key and exchanges it for an access
// token. Everything needed is in WebCrypto.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

// Tokens last an hour. Caching them per isolate saves a round trip on most
// requests without ever persisting a credential anywhere.
const cache = new Map();

function base64url(bytes) {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value) {
	return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

// The `private_key` in a service account JSON is a PKCS#8 PEM with literal
// "\n" sequences if it has been pasted through something that escaped them,
// which is a common way to get an unhelpful "invalid key" error.
export function pemToDer(pem) {
	const body = String(pem || "")
		.replace(/\\n/g, "\n")
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s+/g, "");
	if (!body) throw new Error("The service account's private_key is empty.");
	const binary = atob(body);
	const der = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
	return der;
}

// Parses the JSON blob from the Cloudflare secret, naming what is wrong with
// it rather than throwing whatever JSON.parse says. Whoever sees this pasted
// the wrong file, and "Unexpected token" will not tell them that.
export function readServiceAccount(raw) {
	if (!raw) throw new Error("No service account key is configured.");
	let parsed;
	try {
		parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		throw new Error("The service account key is not valid JSON — paste the whole downloaded file, including the braces.");
	}
	if (parsed.type && parsed.type !== "service_account") {
		throw new Error(`That key is a "${parsed.type}" key. Search Console needs a service account key.`);
	}
	for (const field of ["client_email", "private_key"]) {
		if (!parsed[field]) throw new Error(`The service account key has no ${field} — it looks incomplete.`);
	}
	return parsed;
}

// `now` is injectable so the assertion can be built at a known time in a test.
export async function accessToken(account, scope, now = () => Math.floor(Date.now() / 1000)) {
	const key = `${account.client_email}:${scope}`;
	const issued = now();
	const cached = cache.get(key);
	// A minute of slack, so a token is never handed out moments before it dies.
	if (cached && cached.expires > issued + 60) return cached.token;

	const assertion = await signedAssertion(account, scope, issued);
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: GRANT, assertion }),
	});

	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		// Google's token errors are two words long. These are the ones that
		// actually happen, translated into what to go and change.
		const code = body.error || `HTTP ${response.status}`;
		if (code === "invalid_grant") {
			throw new Error(
				"Google rejected the sign-in key (invalid_grant). Usually the key has been deleted or disabled in Google Cloud, " +
					"or the service account itself has been removed."
			);
		}
		if (code === "invalid_client") {
			throw new Error("Google does not recognise this service account (invalid_client). Check the whole key file was pasted.");
		}
		throw new Error(`Google would not issue an access token (${code}${body.error_description ? `: ${body.error_description}` : ""}).`);
	}

	cache.set(key, { token: body.access_token, expires: issued + (Number(body.expires_in) || 3600) });
	return body.access_token;
}

export async function signedAssertion(account, scope, issued) {
	const claims = {
		iss: account.client_email,
		scope,
		aud: TOKEN_URL,
		iat: issued,
		// An hour is the maximum Google accepts, and the assertion is used
		// once, immediately.
		exp: issued + 3600,
	};
	const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claims)}`;

	let key;
	try {
		key = await crypto.subtle.importKey(
			"pkcs8",
			pemToDer(account.private_key),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"]
		);
	} catch (error) {
		throw new Error(`The service account's private key could not be read (${error.message}).`);
	}

	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
	return `${unsigned}.${base64url(signature)}`;
}

// Exposed for tests -- an isolate-local cache that survives between them
// would make results depend on their order.
export function clearTokenCache() {
	cache.clear();
}
