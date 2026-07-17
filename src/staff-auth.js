// Staff auth: individual username/password accounts (stored in ChatHub's
// SQLite storage -- see the staff_users table in src/chat-hub.js), each
// granting an HMAC-signed, time-limited session cookie carrying
// {username, isAdmin, expires}. No server-side session storage -- the
// cookie itself is the session, re-verified fresh on every request.
//
// env.ADMIN_PASSCODE has one remaining job: gating the one-time bootstrap
// that creates the very first (admin) account when staff_users is empty.
// After that it's not used for anything -- normal logins are always
// username/password from then on.

const COOKIE_NAME = "tcb_staff_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100000;

export async function passcodeMatches(env, submitted) {
	if (typeof submitted !== "string" || !submitted) return false;
	const expected = await sha256Hex(env.ADMIN_PASSCODE);
	const actual = await sha256Hex(submitted);
	return timingSafeEqual(expected, actual);
}

export async function hashPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await deriveBits(password, salt);
	return { salt: toHex(salt), hash: toHex(hash) };
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
	const salt = fromHex(saltHex);
	const actualHashHex = toHex(await deriveBits(password, salt));
	return timingSafeEqual(actualHashHex, expectedHashHex);
}

async function deriveBits(password, salt) {
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password || ""), "PBKDF2", false, [
		"deriveBits",
	]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
}

export async function loginCookieHeader(env, session) {
	const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
	const payloadBytes = new TextEncoder().encode(
		JSON.stringify({ username: session.username, isAdmin: !!session.isAdmin, expires })
	);
	const payload = toBase64Url(payloadBytes);
	const signature = await hmacSignHex(env.SESSION_SECRET, payload);
	const token = `${payload}.${signature}`;
	return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function logoutCookieHeader() {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// Returns {username, isAdmin} for a valid, unexpired session, or null.
export async function getStaffSession(request, env) {
	const token = readCookie(request, COOKIE_NAME);
	if (!token) return null;

	const [payload, signature] = token.split(".");
	if (!payload || !signature) return null;

	const expected = await hmacSignHex(env.SESSION_SECRET, payload);
	if (!timingSafeEqual(signature, expected)) return null;

	let data;
	try {
		data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
	} catch {
		return null;
	}

	if (!data || typeof data.expires !== "number" || Date.now() >= data.expires) return null;
	return { username: data.username, isAdmin: !!data.isAdmin };
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

function toHex(bytesOrBuffer) {
	return [...new Uint8Array(bytesOrBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
	return bytes;
}

function toBase64Url(bytes) {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// Both arguments here are always fixed-length hex digests (SHA-256,
// HMAC-SHA256, or PBKDF2 output, all 64 hex chars), so comparing lengths
// first never leaks anything about user-supplied input -- only the byte
// comparison below needs to run in constant time.
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
