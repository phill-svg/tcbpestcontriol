import { DurableObject } from "cloudflare:workers";
import { sendPushNotification } from "./push.js";
import { passcodeMatches, hashPassword, verifyPassword, loginCookieHeader } from "./staff-auth.js";
import { sendPasswordResetEmail } from "./email.js";

// Password-reset links stay valid for one hour.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const HISTORY_LIMIT = 50;
const CONVERSATION_LIST_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 2000;
// A conversation auto-closes once this long has passed with no new message
// from the visitor -- tracked via last_visitor_message_at and swept by the
// Durable Object alarm below, not a live timer (this DO can hibernate).
const AUTO_CLOSE_AFTER_MS = 10 * 60 * 1000;

// Single global instance (env.CHAT_HUB.idFromName("global")) holds every
// conversation's messages and live WebSocket connections. Traffic for this
// site is low enough that sharding by conversation isn't worth the added
// complexity of routing to the right shard.
export class ChatHub extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.initSchema();
		});
	}

	initSchema() {
		const sql = this.ctx.storage.sql;
		sql.exec(`
			CREATE TABLE IF NOT EXISTS conversations (
				id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				last_message_at INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				unread_by_staff INTEGER NOT NULL DEFAULT 0
			)
		`);
		sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversation_id TEXT NOT NULL,
				sender TEXT NOT NULL,
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id)`);
		sql.exec(`
			CREATE TABLE IF NOT EXISTS push_subscriptions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				endpoint TEXT NOT NULL UNIQUE,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		sql.exec(`
			CREATE TABLE IF NOT EXISTS staff_users (
				username TEXT PRIMARY KEY,
				password_salt TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				is_admin INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			)
		`);
		// Self-service signup requests live in their OWN table and only get
		// promoted into staff_users when an admin approves. Keeping them
		// separate means the live login path and existing accounts are never
		// touched by this feature -- a pending person simply isn't a staff
		// user yet, so there's no way this can lock anyone out.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS staff_signup_requests (
				username TEXT PRIMARY KEY,
				password_salt TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		// Staff-to-staff messages -- room is either the fixed string "team"
		// (one shared channel everyone can see) or "dm:<a>:<b>" with the two
		// usernames alphabetically sorted, so a DM room id is the same
		// regardless of who's asking for it.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS staff_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				room TEXT NOT NULL,
				sender_username TEXT NOT NULL,
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_staff_messages_room ON staff_messages(room, id)`);
		sql.exec(`
			CREATE TABLE IF NOT EXISTS staff_read_marks (
				username TEXT NOT NULL,
				room TEXT NOT NULL,
				last_read_message_id INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (username, room)
			)
		`);

		// These columns were added after their tables already existed in
		// production -- CREATE TABLE IF NOT EXISTS above is a no-op on an
		// existing table, so they need an explicit, idempotent ALTER.
		this.ensureColumn("conversations", "visitor_name", "TEXT");
		this.ensureColumn("conversations", "visitor_email", "TEXT");
		this.ensureColumn("messages", "sender_name", "TEXT");
		this.ensureColumn("conversations", "last_visitor_message_at", "INTEGER");
		// Which staff member a push subscription belongs to -- lets team/DM
		// notifications target the right device(s) instead of every staff
		// device. Subscriptions created before this column existed have a
		// NULL username and simply won't be targeted by those (customer chat
		// notifications are unaffected -- they still push to everyone).
		this.ensureColumn("push_subscriptions", "username", "TEXT");

		// Recovery email for each staff account (used only for password-reset
		// links). Nullable -- accounts created before this existed simply have
		// no email until they set one, and the emailed-reset flow just isn't
		// available to them until they do.
		this.ensureColumn("staff_users", "email", "TEXT");

		// One-time, expiring password-reset tokens. Only the SHA-256 hash of the
		// token is stored, never the token itself -- so a DB read can't be used
		// to forge a reset link. Consumed (used_at set) on first successful use.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS password_reset_tokens (
				token_hash TEXT PRIMARY KEY,
				username TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				used_at INTEGER
			)
		`);
	}

	ensureColumn(table, column, type) {
		const sql = this.ctx.storage.sql;
		const columns = sql.exec(`PRAGMA table_info(${table})`).toArray();
		if (!columns.some((c) => c.name === column)) {
			sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === "/api/chat/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 400 });
			}
			return this.acceptVisitor(url);
		}

		// Auth for this one already happened in the Worker (src/index.js) before
		// the request reached this Durable Object -- only a request that already
		// carried a valid staff session cookie gets forwarded here.
		if (url.pathname === "/api/chat/staff/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 400 });
			}
			return this.acceptStaff(url);
		}

		// Also already auth-gated in the Worker before reaching here, which
		// also attaches ?username= (verified, not trusted from the client) so
		// team/DM push notifications can target the right device.
		if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
			return this.handleSubscribe(request, url.searchParams.get("username"));
		}
		if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") {
			return this.handleUnsubscribe(request);
		}

		if (url.pathname === "/api/staff/bootstrap-check") {
			const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM staff_users").one().n;
			return new Response(JSON.stringify({ needed: count === 0 }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (url.pathname === "/api/staff/bootstrap" && request.method === "POST") {
			return this.handleBootstrap(request);
		}
		if (url.pathname === "/api/staff/login" && request.method === "POST") {
			return this.handleLogin(request);
		}
		// Public: anyone can request a staff account. It stays pending in
		// staff_signup_requests until an admin approves -- see handleSignup.
		if (url.pathname === "/api/staff/signup" && request.method === "POST") {
			return this.handleSignup(request);
		}
		// Account recovery: reset an existing account's password using the
		// shared setup passcode (env.ADMIN_PASSCODE). This is the only way back
		// in for someone who's forgotten their password and can't reach an admin
		// -- there's no email/token flow. Gated on the passcode exactly like
		// bootstrap; see handleResetPassword.
		if (url.pathname === "/api/staff/reset-password" && request.method === "POST") {
			return this.handleResetPassword(request);
		}
		// Self-service email-based recovery. /forgot emails a one-time link;
		// /reset-with-token consumes it and sets the new password. Both public
		// (the token is the credential); see handleForgotPassword / handleResetWithToken.
		if (url.pathname === "/api/staff/forgot" && request.method === "POST") {
			return this.handleForgotPassword(request, url);
		}
		if (url.pathname === "/api/staff/reset-with-token" && request.method === "POST") {
			return this.handleResetWithToken(request);
		}
		// A signed-in staff member sets their own recovery email. Auth + verified
		// username are enforced in the Worker (src/index.js) before this is reached.
		if (url.pathname === "/api/staff/set-email" && request.method === "POST") {
			return this.handleSetEmail(request, url.searchParams.get("username"));
		}
		// Admin-only -- already checked in the Worker before forwarding here,
		// which also attaches ?actingUser= so the safety checks below (can't
		// remove yourself, can't remove the last admin) know who's asking.
		if (url.pathname === "/api/staff/users") {
			if (request.method === "GET") {
				return new Response(JSON.stringify({ users: this.listStaffUsers() }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.method === "POST") return this.handleCreateStaffUser(request);
			if (request.method === "DELETE") return this.handleRemoveStaffUser(request, url.searchParams.get("actingUser"));
		}
		// Admin-only -- gated in the Worker, same as /api/staff/users above.
		if (url.pathname === "/api/staff/signup-requests" && request.method === "GET") {
			return new Response(JSON.stringify({ requests: this.listSignupRequests() }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/api/staff/signup-requests/approve" && request.method === "POST") {
			return this.handleApproveSignup(request);
		}
		if (url.pathname === "/api/staff/signup-requests/reject" && request.method === "POST") {
			return this.handleRejectSignup(request);
		}

		return new Response("Not found", { status: 404 });
	}

	async handleBootstrap(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM staff_users").one().n;
		if (count > 0) return jsonError(409, "Setup has already been completed");

		if (!(await passcodeMatches(this.env, body.passcode))) return jsonError(401, "Incorrect passcode");

		const username = normalizeUsername(body.username);
		const password = typeof body.password === "string" ? body.password : "";
		if (!username) return jsonError(400, "Username is required");
		if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");

		const { salt, hash } = await hashPassword(password);
		this.ctx.storage.sql.exec(
			"INSERT INTO staff_users (username, password_salt, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)",
			username,
			salt,
			hash,
			Date.now()
		);

		const cookie = await loginCookieHeader(this.env, { username, isAdmin: true });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
	}

	async handleLogin(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const username = normalizeUsername(body.username);
		const password = typeof body.password === "string" ? body.password : "";
		if (!username || !password) return jsonError(401, "Incorrect username or password");

		const row = this.ctx.storage.sql
			.exec("SELECT password_salt, password_hash, is_admin FROM staff_users WHERE username = ?", username)
			.toArray()[0];
		if (!row) {
			// Not an active account -- but if it's a pending signup and the
			// password is correct, say so rather than a generic failure. Gating
			// on a correct password means this can't be used to probe usernames.
			const pending = this.ctx.storage.sql
				.exec("SELECT password_salt, password_hash FROM staff_signup_requests WHERE username = ?", username)
				.toArray()[0];
			if (pending && (await verifyPassword(password, pending.password_salt, pending.password_hash))) {
				return jsonError(403, "Your account is awaiting admin approval.");
			}
			return jsonError(401, "Incorrect username or password");
		}
		if (!(await verifyPassword(password, row.password_salt, row.password_hash))) {
			return jsonError(401, "Incorrect username or password");
		}

		const cookie = await loginCookieHeader(this.env, { username, isAdmin: !!row.is_admin });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
	}

	// Resets an existing account's password. Gated purely on the shared setup
	// passcode -- deliberately: it's the recovery path for someone locked out
	// with no working login and no admin to help. Anyone holding the passcode
	// can reset any account (including admin), so the passcode is effectively a
	// master key; that's the accepted trade for a self-contained recovery flow.
	// On success the caller is signed straight in as the reset account.
	async handleResetPassword(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		if (!(await passcodeMatches(this.env, body.passcode))) return jsonError(401, "Incorrect setup passcode");

		const username = normalizeUsername(body.username);
		const password = typeof body.password === "string" ? body.password : "";
		if (!username) return jsonError(400, "Username is required");
		if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");

		const row = this.ctx.storage.sql
			.exec("SELECT is_admin FROM staff_users WHERE username = ?", username)
			.toArray()[0];
		if (!row) return jsonError(404, "No staff account with that username");

		const { salt, hash } = await hashPassword(password);
		this.ctx.storage.sql.exec(
			"UPDATE staff_users SET password_salt = ?, password_hash = ? WHERE username = ?",
			salt,
			hash,
			username
		);

		const cookie = await loginCookieHeader(this.env, { username, isAdmin: !!row.is_admin });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
	}

	// Emails a one-time password-reset link. Accepts either a username or an
	// email address. ALWAYS returns a generic success -- never reveals whether
	// an account (or email) exists, so this can't be used to enumerate staff.
	async handleForgotPassword(request, url) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const generic = () =>
			new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

		const identifier = (typeof body.identifier === "string" ? body.identifier : "").trim();
		if (!identifier) return generic();

		const sql = this.ctx.storage.sql;
		// Match on username (normalised) or email (case-insensitive).
		const uname = normalizeUsername(identifier);
		const emailLc = identifier.toLowerCase();
		const row = sql
			.exec(
				"SELECT username, email FROM staff_users WHERE username = ? OR lower(email) = ? LIMIT 1",
				uname,
				emailLc
			)
			.toArray()[0];

		// No account, or no email on file -> nothing to send, but still generic.
		if (!row || !row.email) return generic();

		// Fresh token; store only its hash. Clear any previous unused tokens for
		// this user so old links stop working once a new one is requested.
		const token = randomToken();
		const tokenHash = await sha256Hex(token);
		sql.exec("DELETE FROM password_reset_tokens WHERE username = ? AND used_at IS NULL", row.username);
		sql.exec(
			"INSERT INTO password_reset_tokens (token_hash, username, expires_at, used_at) VALUES (?, ?, ?, NULL)",
			tokenHash,
			row.username,
			Date.now() + RESET_TOKEN_TTL_MS
		);

		const resetUrl = `${url.origin}/staff-chat?reset=${token}`;
		try {
			await sendPasswordResetEmail(this.env, row.email, resetUrl, row.username);
		} catch (e) {
			// Don't leak send failures to the caller (still generic), but surface
			// them in logs so a misconfigured binding is diagnosable.
			console.error("Password reset email failed:", e && e.message);
		}
		return generic();
	}

	// Consumes a reset token and sets the new password, then signs the user in.
	async handleResetWithToken(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const token = typeof body.token === "string" ? body.token : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!token) return jsonError(400, "Missing reset token");
		if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");

		const sql = this.ctx.storage.sql;
		const tokenHash = await sha256Hex(token);
		const tok = sql
			.exec("SELECT username, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?", tokenHash)
			.toArray()[0];
		if (!tok || tok.used_at || Date.now() > tok.expires_at) {
			return jsonError(400, "This reset link is invalid or has expired. Please request a new one.");
		}

		const user = sql.exec("SELECT is_admin FROM staff_users WHERE username = ?", tok.username).toArray()[0];
		if (!user) return jsonError(400, "This reset link is invalid or has expired. Please request a new one.");

		const { salt, hash } = await hashPassword(password);
		sql.exec("UPDATE staff_users SET password_salt = ?, password_hash = ? WHERE username = ?", salt, hash, tok.username);
		// Burn this token and any other outstanding ones for the account.
		sql.exec("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?", Date.now(), tokenHash);
		sql.exec("DELETE FROM password_reset_tokens WHERE username = ? AND used_at IS NULL", tok.username);

		const cookie = await loginCookieHeader(this.env, { username: tok.username, isAdmin: !!user.is_admin });
		return new Response(JSON.stringify({ ok: true, username: tok.username }), {
			status: 200,
			headers: { "content-type": "application/json", "Set-Cookie": cookie },
		});
	}

	// A signed-in staff member sets/updates their own recovery email. `username`
	// is the verified caller attached by the Worker, never trusted from the body.
	async handleSetEmail(request, username) {
		if (!username) return jsonError(401, "Not signed in");
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const email = (typeof body.email === "string" ? body.email : "").trim();
		// Deliberately light validation -- just enough to catch obvious typos.
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(400, "Please enter a valid email address");

		this.ctx.storage.sql.exec("UPDATE staff_users SET email = ? WHERE username = ?", email, username);
		return new Response(JSON.stringify({ ok: true, email }), { status: 200, headers: { "content-type": "application/json" } });
	}

	listStaffUsers() {
		return this.ctx.storage.sql
			.exec("SELECT username, is_admin, created_at FROM staff_users ORDER BY created_at ASC")
			.toArray()
			.map((r) => ({ username: r.username, isAdmin: !!r.is_admin, createdAt: r.created_at }));
	}

	async handleCreateStaffUser(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const username = normalizeUsername(body.username);
		const password = typeof body.password === "string" ? body.password : "";
		if (!username) return jsonError(400, "Username is required");
		if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");

		const exists = this.ctx.storage.sql.exec("SELECT username FROM staff_users WHERE username = ?", username).toArray().length > 0;
		if (exists) return jsonError(409, "That username is already taken");

		const { salt, hash } = await hashPassword(password);
		this.ctx.storage.sql.exec(
			"INSERT INTO staff_users (username, password_salt, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
			username,
			salt,
			hash,
			body.isAdmin ? 1 : 0,
			Date.now()
		);

		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	async handleSignup(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const username = normalizeUsername(body.username);
		const password = typeof body.password === "string" ? body.password : "";
		if (!username) return jsonError(400, "Username is required");
		if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");

		const sql = this.ctx.storage.sql;
		const taken = sql.exec("SELECT username FROM staff_users WHERE username = ?", username).toArray().length > 0;
		if (taken) return jsonError(409, "That username is already taken");
		const alreadyRequested = sql.exec("SELECT username FROM staff_signup_requests WHERE username = ?", username).toArray().length > 0;
		if (alreadyRequested) return jsonError(409, "A request for that username is already awaiting approval");

		const { salt, hash } = await hashPassword(password);
		sql.exec(
			"INSERT INTO staff_signup_requests (username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
			username,
			salt,
			hash,
			Date.now()
		);

		// Best-effort nudge; the pending-requests list in the admin panel is the
		// reliable channel (an admin only gets this if they enabled notifications).
		await this.notifyAdminsOfSignup(username);

		return new Response(JSON.stringify({ ok: true, pending: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	listSignupRequests() {
		return this.ctx.storage.sql
			.exec("SELECT username, created_at FROM staff_signup_requests ORDER BY created_at ASC")
			.toArray()
			.map((r) => ({ username: r.username, createdAt: r.created_at }));
	}

	async handleApproveSignup(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}
		const username = normalizeUsername(body.username);
		if (!username) return jsonError(400, "Username is required");

		const sql = this.ctx.storage.sql;
		const req = sql
			.exec("SELECT username, password_salt, password_hash FROM staff_signup_requests WHERE username = ?", username)
			.toArray()[0];
		if (!req) return jsonError(404, "No such pending request");

		// Guard against a race where the same username got created directly.
		const exists = sql.exec("SELECT username FROM staff_users WHERE username = ?", username).toArray().length > 0;
		if (exists) {
			sql.exec("DELETE FROM staff_signup_requests WHERE username = ?", username);
			return jsonError(409, "That username already exists as a staff account");
		}

		// Approved accounts are always ordinary staff, never admin, and reuse the
		// password the requester already chose (no reset needed).
		sql.exec(
			"INSERT INTO staff_users (username, password_salt, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)",
			username,
			req.password_salt,
			req.password_hash,
			Date.now()
		);
		sql.exec("DELETE FROM staff_signup_requests WHERE username = ?", username);

		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	async handleRejectSignup(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}
		const username = normalizeUsername(body.username);
		if (!username) return jsonError(400, "Username is required");
		this.ctx.storage.sql.exec("DELETE FROM staff_signup_requests WHERE username = ?", username);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	async notifyAdminsOfSignup(username) {
		const admins = this.ctx.storage.sql
			.exec("SELECT username FROM staff_users WHERE is_admin = 1")
			.toArray()
			.map((r) => r.username);
		if (!admins.length) return;
		const subscriptions = this.getPushSubscriptionsForUsernames(admins);
		if (!subscriptions.length) return;
		const payload = {
			title: "New staff account request",
			body: `${username} has requested access — approve or reject in the staff dashboard.`,
			url: "/staff-chat",
		};
		await Promise.all(
			subscriptions.map(async (subscription) => {
				const result = await sendPushNotification(this.env, subscription, payload);
				if (result === "gone") this.removePushSubscription(subscription.endpoint);
			})
		);
	}

	async handleRemoveStaffUser(request, actingUser) {
		let body;
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON");
		}

		const username = normalizeUsername(body.username);
		if (!username) return jsonError(400, "Username is required");
		if (username === actingUser) return jsonError(400, "You can't remove your own account while signed in as it");

		const row = this.ctx.storage.sql.exec("SELECT is_admin FROM staff_users WHERE username = ?", username).toArray()[0];
		if (!row) return jsonError(404, "No such user");

		if (row.is_admin) {
			const adminCount = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM staff_users WHERE is_admin = 1").one().n;
			if (adminCount <= 1) return jsonError(400, "Can't remove the last remaining admin account");
		}

		this.ctx.storage.sql.exec("DELETE FROM staff_users WHERE username = ?", username);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	async handleSubscribe(request, username) {
		let body;
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		if (!body || typeof body.endpoint !== "string" || !body.keys || typeof body.keys.p256dh !== "string" || typeof body.keys.auth !== "string") {
			return new Response(JSON.stringify({ error: "Invalid subscription" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		this.addPushSubscription(body.endpoint, body.keys.p256dh, body.keys.auth, username || null);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	async handleUnsubscribe(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			body = null;
		}

		if (body && typeof body.endpoint === "string") {
			this.removePushSubscription(body.endpoint);
		}
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}

	acceptVisitor(url) {
		const conversationId = url.searchParams.get("cid");
		if (!conversationId) return new Response("Missing cid", { status: 400 });
		const since = Number(url.searchParams.get("since")) || 0;
		const visitorName = (url.searchParams.get("name") || "").trim().slice(0, 200);
		const visitorEmail = (url.searchParams.get("email") || "").trim().slice(0, 200);
		if (!visitorName || !visitorEmail) return new Response("Name and email required", { status: 400 });

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ role: "visitor", conversationId });

		this.ensureConversation(conversationId, visitorName, visitorEmail);
		server.send(JSON.stringify({ type: "history", messages: this.getMessages(conversationId, since) }));

		return new Response(null, { status: 101, webSocket: client });
	}

	acceptStaff(url) {
		const username = url.searchParams.get("username") || "";

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ role: "staff", username });

		server.send(JSON.stringify({ type: "conversations", ...this.getConversationLists() }));
		server.send(JSON.stringify({ type: "teamRooms", ...this.getTeamRoomsSummary(username) }));

		return new Response(null, { status: 101, webSocket: client });
	}

	ensureConversation(conversationId, visitorName, visitorEmail) {
		const sql = this.ctx.storage.sql;
		const exists = sql.exec("SELECT id FROM conversations WHERE id = ?", conversationId).toArray().length > 0;
		if (!exists) {
			const now = Date.now();
			sql.exec(
				"INSERT INTO conversations (id, created_at, last_message_at, status, unread_by_staff, visitor_name, visitor_email) VALUES (?, ?, ?, 'open', 0, ?, ?)",
				conversationId,
				now,
				now,
				visitorName || null,
				visitorEmail || null
			);
		} else if (visitorName || visitorEmail) {
			// Keep it current if the visitor re-enters their details later (e.g.
			// localStorage got cleared) -- COALESCE so an empty value here never
			// wipes out one already on file.
			sql.exec(
				"UPDATE conversations SET visitor_name = COALESCE(?, visitor_name), visitor_email = COALESCE(?, visitor_email) WHERE id = ?",
				visitorName || null,
				visitorEmail || null,
				conversationId
			);
		}
	}

	getMessages(conversationId, sinceId) {
		const rows = this.ctx.storage.sql
			.exec(
				"SELECT id, sender, sender_name, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
				conversationId,
				sinceId,
				HISTORY_LIMIT
			)
			.toArray();
		return rows.map((r) => ({ id: r.id, sender: r.sender, senderName: r.sender_name, body: r.body, createdAt: r.created_at }));
	}

	// One row per conversation in the given status, each carrying a preview
	// of its most recent message, for the staff dashboard's conversation list.
	getConversationsSummary(status) {
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT
					c.id, c.created_at, c.last_message_at, c.unread_by_staff, c.visitor_name, c.visitor_email,
					(SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
					(SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
				FROM conversations c
				WHERE c.status = ?
				ORDER BY c.last_message_at DESC
				LIMIT ?`,
				status,
				CONVERSATION_LIST_LIMIT
			)
			.toArray();
		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			lastMessageAt: r.last_message_at,
			unreadByStaff: r.unread_by_staff,
			visitorName: r.visitor_name,
			visitorEmail: r.visitor_email,
			lastBody: r.last_body,
			lastSender: r.last_sender,
		}));
	}

	// Sent to staff on connect, on any conversation-list-changing event, and
	// after loading a conversation -- both tabs at once, since it's cheap and
	// keeps the client from having to ask separately for each.
	getConversationLists() {
		return { open: this.getConversationsSummary("open"), closed: this.getConversationsSummary("closed") };
	}

	markReadByStaff(conversationId) {
		this.ctx.storage.sql.exec("UPDATE conversations SET unread_by_staff = 0 WHERE id = ?", conversationId);
	}

	// Manual close/reopen from the staff dashboard, independent of the
	// auto-close sweep. Reopening gives it a fresh AUTO_CLOSE_AFTER_MS grace
	// period from now (bumping last_visitor_message_at) -- otherwise a
	// conversation reopened well after the visitor's last message would look
	// re-opened for only an instant before the very next alarm sweep closed
	// it straight back up again.
	setConversationStatus(conversationId, status) {
		const sql = this.ctx.storage.sql;
		if (status === "open") {
			const now = Date.now();
			sql.exec("UPDATE conversations SET status = 'open', last_visitor_message_at = ? WHERE id = ?", now, conversationId);
			this.ctx.waitUntil(this.scheduleCloseSweep(now + AUTO_CLOSE_AFTER_MS));
		} else {
			sql.exec("UPDATE conversations SET status = 'closed' WHERE id = ?", conversationId);
		}
	}

	// A DM room id is deterministic regardless of which of the two staff
	// members is asking -- alphabetically sorted usernames joined together.
	dmRoomId(a, b) {
		return "dm:" + [a, b].sort().join(":");
	}

	isDmRoom(room) {
		return room.startsWith("dm:");
	}

	dmParticipants(room) {
		return room.slice(3).split(":");
	}

	// The fixed "team" channel is open to every staff account; a DM room is
	// only open to its two named participants.
	canAccessRoom(room, username) {
		if (room === "team") return true;
		if (this.isDmRoom(room)) return this.dmParticipants(room).includes(username);
		return false;
	}

	getTeamMessages(room, sinceId) {
		const rows = this.ctx.storage.sql
			.exec(
				"SELECT id, sender_username, body, created_at FROM staff_messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?",
				room,
				sinceId,
				HISTORY_LIMIT
			)
			.toArray();
		return rows.map((r) => ({ id: r.id, sender: r.sender_username, body: r.body, createdAt: r.created_at }));
	}

	// Every room this staff member can see (the shared channel plus one
	// potential DM per other staff account) with an unread count for each,
	// so the client can render the picker with badges without a round trip
	// per room.
	getTeamRoomsSummary(username) {
		const sql = this.ctx.storage.sql;
		const staffList = this.listStaffUsers()
			.map((u) => u.username)
			.filter((u) => u !== username);

		const rooms = ["team", ...staffList.map((other) => this.dmRoomId(username, other))];
		const unread = {};
		for (const room of rooms) {
			const mark = sql.exec("SELECT last_read_message_id FROM staff_read_marks WHERE username = ? AND room = ?", username, room).toArray()[0];
			const lastRead = mark ? mark.last_read_message_id : 0;
			unread[room] = sql
				.exec("SELECT COUNT(*) AS n FROM staff_messages WHERE room = ? AND id > ? AND sender_username != ?", room, lastRead, username)
				.one().n;
		}
		return { staff: staffList, unread };
	}

	markTeamRoomRead(username, room, messageId) {
		this.ctx.storage.sql.exec(
			`INSERT INTO staff_read_marks (username, room, last_read_message_id) VALUES (?, ?, ?)
			 ON CONFLICT(username, room) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`,
			username,
			room,
			messageId
		);
	}

	insertTeamMessage(room, senderUsername, body) {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec("INSERT INTO staff_messages (room, sender_username, body, created_at) VALUES (?, ?, ?, ?)", room, senderUsername, body, now);
		const { id } = sql.exec("SELECT last_insert_rowid() AS id").one();
		// The sender's own read cursor advances too, so their own message
		// never shows up as unread to them on reconnect.
		this.markTeamRoomRead(senderUsername, room, id);
		return { id, sender: senderUsername, body, createdAt: now };
	}

	// Reaches only the staff sockets allowed to see this room -- everyone for
	// "team", just the two participants for a DM.
	broadcastToRoom(room, payload) {
		const text = JSON.stringify(payload);
		const targets = this.isDmRoom(room) ? new Set(this.dmParticipants(room)) : null;
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment();
			if (!attachment || attachment.role !== "staff") continue;
			if (targets && !targets.has(attachment.username)) continue;
			ws.send(text);
		}
	}

	sendToUsername(username, payload) {
		const text = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment();
			if (attachment && attachment.role === "staff" && attachment.username === username) ws.send(text);
		}
	}

	// Refreshes the unread badge counts for whichever staff members can see
	// this room -- called after every team/DM message so a badge updates
	// live even for someone who doesn't have that room open right now.
	broadcastRoomsSummary(room) {
		const usernames = this.isDmRoom(room) ? this.dmParticipants(room) : this.listStaffUsers().map((u) => u.username);
		for (const username of usernames) {
			this.sendToUsername(username, { type: "teamRooms", ...this.getTeamRoomsSummary(username) });
		}
	}

	// Same "don't buzz an open dashboard" rule as customer-chat notifications
	// (notifyStaffOfNewMessage below), but per-recipient and targeted --
	// only whoever can see this room, minus the sender, minus anyone with a
	// dashboard already connected.
	async notifyTeamMessage(room, senderUsername, body) {
		const recipients = (this.isDmRoom(room) ? this.dmParticipants(room) : this.listStaffUsers().map((u) => u.username)).filter(
			(u) => u !== senderUsername && !this.isUsernameConnected(u)
		);
		if (!recipients.length) return;

		const subscriptions = this.getPushSubscriptionsForUsernames(recipients);
		if (!subscriptions.length) return;

		const payload = {
			title: (room === "team" ? "Team chat — " : "") + senderUsername,
			body: body.length > 120 ? body.slice(0, 117) + "..." : body,
			url: "/staff-chat",
		};

		await Promise.all(
			subscriptions.map(async (subscription) => {
				const result = await sendPushNotification(this.env, subscription, payload);
				if (result === "gone") this.removePushSubscription(subscription.endpoint);
			})
		);
	}

	// Re-arms the close-sweep alarm to the earliest pending auto-close
	// deadline, if any -- called after every visitor message. Durable Object
	// alarms are exactly-once and persist across hibernation, so this is
	// reliable without keeping the DO alive or running a live timer.
	async scheduleCloseSweep(deadline) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || deadline < current) {
			await this.ctx.storage.setAlarm(deadline);
		}
	}

	// Fires when the earliest scheduled auto-close deadline arrives. Closes
	// every open conversation that's been silent (from the visitor's side)
	// for AUTO_CLOSE_AFTER_MS or longer, then re-arms itself for whichever
	// still-open conversation is next in line, if any.
	async alarm() {
		const sql = this.ctx.storage.sql;
		const cutoff = Date.now() - AUTO_CLOSE_AFTER_MS;
		const toClose = sql
			.exec(
				"SELECT id FROM conversations WHERE status = 'open' AND last_visitor_message_at IS NOT NULL AND last_visitor_message_at <= ?",
				cutoff
			)
			.toArray();

		if (toClose.length) {
			sql.exec(
				"UPDATE conversations SET status = 'closed' WHERE status = 'open' AND last_visitor_message_at IS NOT NULL AND last_visitor_message_at <= ?",
				cutoff
			);
			this.broadcastToStaff({ type: "conversations", ...this.getConversationLists() });
		}

		const next = sql
			.exec(
				"SELECT MIN(last_visitor_message_at) AS next_at FROM conversations WHERE status = 'open' AND last_visitor_message_at IS NOT NULL"
			)
			.one();
		if (next && next.next_at !== null) {
			this.ctx.storage.setAlarm(next.next_at + AUTO_CLOSE_AFTER_MS);
		}
	}

	getPushSubscriptions() {
		return this.ctx.storage.sql.exec("SELECT endpoint, p256dh, auth FROM push_subscriptions").toArray();
	}

	// Only subscriptions known to belong to one of the given usernames --
	// used for team/DM notifications so they don't fan out to every staff
	// device the way customer-chat notifications intentionally do.
	getPushSubscriptionsForUsernames(usernames) {
		if (!usernames.length) return [];
		const placeholders = usernames.map(() => "?").join(",");
		return this.ctx.storage.sql
			.exec(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username IN (${placeholders})`, ...usernames)
			.toArray();
	}

	addPushSubscription(endpoint, p256dh, auth, username) {
		const sql = this.ctx.storage.sql;
		// Delete-then-insert rather than an upsert -- simpler to reason about,
		// and this table is small enough (one row per staff device) that there's
		// no meaningful cost to it.
		sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
		sql.exec(
			"INSERT INTO push_subscriptions (endpoint, p256dh, auth, username, created_at) VALUES (?, ?, ?, ?, ?)",
			endpoint,
			p256dh,
			auth,
			username || null,
			Date.now()
		);
	}

	removePushSubscription(endpoint) {
		this.ctx.storage.sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
	}

	hasConnectedStaff() {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment();
			if (attachment && attachment.role === "staff") return true;
		}
		return false;
	}

	isUsernameConnected(username) {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment();
			if (attachment && attachment.role === "staff" && attachment.username === username) return true;
		}
		return false;
	}

	// Fire-and-forget from the caller's perspective (wrapped in ctx.waitUntil
	// there) -- pushes every stored subscription, dropping any the push
	// service reports as gone (unsubscribed/expired).
	async notifyStaffOfNewMessage(conversationId, body) {
		const subscriptions = this.getPushSubscriptions();
		if (!subscriptions.length) return;

		const payload = {
			title: "New chat message — TCB Pest Control",
			body: body.length > 120 ? body.slice(0, 117) + "..." : body,
			url: "/staff-chat?c=" + encodeURIComponent(conversationId),
		};

		await Promise.all(
			subscriptions.map(async (subscription) => {
				const result = await sendPushNotification(this.env, subscription, payload);
				if (result === "gone") this.removePushSubscription(subscription.endpoint);
			})
		);
	}

	insertMessage(conversationId, sender, body, senderName) {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec(
			"INSERT INTO messages (conversation_id, sender, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)",
			conversationId,
			sender,
			senderName || null,
			body,
			now
		);
		const { id } = sql.exec("SELECT last_insert_rowid() AS id").one();
		// Any new message reopens a closed conversation -- a customer replying
		// (or staff following up) after auto-close should surface it again.
		sql.exec(
			"UPDATE conversations SET last_message_at = ?, unread_by_staff = unread_by_staff + ?, status = 'open', last_visitor_message_at = CASE WHEN ? THEN ? ELSE last_visitor_message_at END WHERE id = ?",
			now,
			sender === "visitor" ? 1 : 0,
			sender === "visitor" ? 1 : 0,
			now,
			conversationId
		);
		if (sender === "visitor") this.ctx.waitUntil(this.scheduleCloseSweep(now + AUTO_CLOSE_AFTER_MS));
		return { id, sender, senderName: senderName || null, body, createdAt: now };
	}

	async webSocketMessage(ws, raw) {
		const attachment = ws.deserializeAttachment();
		if (!attachment) return;

		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}

		if (attachment.role === "visitor") {
			this.handleVisitorMessage(ws, attachment, data);
		} else if (attachment.role === "staff") {
			this.handleStaffMessage(ws, attachment, data);
		}
	}

	handleVisitorMessage(ws, attachment, data) {
		// Ephemeral typing signal -- relayed to any staff watching, never stored.
		if (data.type === "typing") {
			this.broadcastToStaff({ type: "typing", conversationId: attachment.conversationId, from: "visitor" });
			return;
		}
		if (data.type !== "message" || typeof data.body !== "string") return;

		const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
		if (!body) return;

		const saved = this.insertMessage(attachment.conversationId, "visitor", body);
		this.broadcastToConversation(attachment.conversationId, { type: "message", message: saved }, ws);

		// Let any connected staff know live -- both an in-thread update (if
		// they happen to have this exact conversation open) and a refreshed
		// list (new preview text, moved to the top, unread count changed).
		this.broadcastToStaff({ type: "message", conversationId: attachment.conversationId, message: saved });
		this.broadcastToStaff({ type: "conversations", ...this.getConversationLists() });

		// Only push if nobody's actually watching the dashboard right now --
		// if a staff device is connected, the broadcasts above already reached
		// it live, a phone buzz would just be noise.
		if (!this.hasConnectedStaff()) {
			this.ctx.waitUntil(this.notifyStaffOfNewMessage(attachment.conversationId, body));
		}
	}

	handleStaffMessage(ws, attachment, data) {
		// Ephemeral typing signal -- relayed to the visitor on this conversation,
		// never stored.
		if (data.type === "typing" && typeof data.conversationId === "string") {
			this.broadcastToConversation(data.conversationId, { type: "typing", from: "staff" });
			return;
		}
		if (data.type === "loadConversation" && typeof data.conversationId === "string") {
			this.markReadByStaff(data.conversationId);
			ws.send(JSON.stringify({ type: "history", conversationId: data.conversationId, messages: this.getMessages(data.conversationId, 0) }));
			this.broadcastToStaff({ type: "conversations", ...this.getConversationLists() });
			return;
		}

		if (
			data.type === "setConversationStatus" &&
			typeof data.conversationId === "string" &&
			(data.status === "open" || data.status === "closed")
		) {
			this.setConversationStatus(data.conversationId, data.status);
			this.broadcastToStaff({ type: "conversations", ...this.getConversationLists() });
			return;
		}

		if (data.type === "reply" && typeof data.conversationId === "string" && typeof data.body === "string") {
			const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
			if (!body) return;

			const saved = this.insertMessage(data.conversationId, "staff", body, attachment.username);
			this.broadcastToConversation(data.conversationId, { type: "message", message: saved });
			this.broadcastToStaff({ type: "message", conversationId: data.conversationId, message: saved });
			this.broadcastToStaff({ type: "conversations", ...this.getConversationLists() });
			return;
		}

		if (data.type === "loadTeamRoom" && typeof data.room === "string") {
			if (!this.canAccessRoom(data.room, attachment.username)) return;
			const messages = this.getTeamMessages(data.room, 0);
			const latestId = messages.length ? messages[messages.length - 1].id : 0;
			this.markTeamRoomRead(attachment.username, data.room, latestId);
			ws.send(JSON.stringify({ type: "teamHistory", room: data.room, messages }));
			ws.send(JSON.stringify({ type: "teamRooms", ...this.getTeamRoomsSummary(attachment.username) }));
			return;
		}

		if (data.type === "teamMessage" && typeof data.room === "string" && typeof data.body === "string") {
			if (!this.canAccessRoom(data.room, attachment.username)) return;
			const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
			if (!body) return;

			const saved = this.insertTeamMessage(data.room, attachment.username, body);
			this.broadcastToRoom(data.room, { type: "teamMessage", room: data.room, message: saved });
			this.broadcastRoomsSummary(data.room);
			this.ctx.waitUntil(this.notifyTeamMessage(data.room, attachment.username, body));
		}
	}

	// Reaches every visitor WebSocket open on the given conversation (e.g. the
	// same visitor with two tabs open, plus wherever a staff reply needs to
	// land).
	broadcastToConversation(conversationId, payload, exclude) {
		const text = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === exclude) continue;
			const attachment = ws.deserializeAttachment();
			if (attachment && attachment.role === "visitor" && attachment.conversationId === conversationId) {
				ws.send(text);
			}
		}
	}

	broadcastToStaff(payload) {
		const text = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment();
			if (attachment && attachment.role === "staff") {
				ws.send(text);
			}
		}
	}

	async webSocketClose(ws, code, reason) {
		ws.close(code, reason);
	}

	async webSocketError() {}
}

function normalizeUsername(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function jsonError(status, message) {
	return new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } });
}

// A 256-bit URL-safe random token (hex) for password-reset links.
function randomToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 hex -- only the hash of a reset token is ever stored.
async function sha256Hex(input) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input || ""));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
