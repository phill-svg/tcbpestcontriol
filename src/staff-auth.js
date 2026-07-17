// Stateless staff auth: a single shared passcode (env.ADMIN_PASSCODE) grants
// an HMAC-signed, time-limited session cookie (signed with env.SESSION_SECRET).
// There is no session storage anywhere -- the cookie itself is the only
// session state, and it's re-verified fresh on every request.

const COOKIE_NAME = "tcb_staff_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export async function passcodeMatches(env, submitted) {
	if (typeof submitted !== "string" || !submitted) return false;
	const expected = await sha256Hex(env.ADMIN_PASSCODE);
	const actual = await sha256Hex(submitted);
	return timingSafeEqual(expected, actual);
}

export async function loginCookieHeader(env) {
	const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
	const payload = String(expires);
	const signature = await hmacSignHex(env.SESSION_SECRET, payload);
	const token = `${payload}.${signature}`;
	return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function logoutCookieHeader() {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isStaffSession(request, env) {
	const token = readCookie(request, COOKIE_NAME);
	if (!token) return false;

	const [payload, signature] = token.split(".");
	if (!payload || !signature) return false;

	const expected = await hmacSignHex(env.SESSION_SECRET, payload);
	if (!timingSafeEqual(signature, expected)) return false;

	const expires = Number(payload);
	return Number.isFinite(expires) && Date.now() < expires;
}

function readCookie(request, name) {
	const header = request.headers.get("Cookie") || "";
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
	}
	return null;
}

async function sha256Hex(input) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input || ""));
	return toHex(digest);
}

async function hmacSignHex(secret, message) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret || ""),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return toHex(signature);
}

function toHex(buffer) {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Both arguments here are always fixed-length hex digests (SHA-256 or
// HMAC-SHA256, 64 chars), so comparing lengths first never leaks anything
// about user-supplied input -- only the byte comparison below needs to run
// in constant time.
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
