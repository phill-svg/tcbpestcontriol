import { DurableObject } from "cloudflare:workers";
import { sendPushNotification } from "./push.js";
import { passcodeMatches, hashPassword, verifyPassword, loginCookieHeader } from "./staff-auth.js";

const HISTORY_LIMIT = 50;
const CONVERSATION_LIST_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 2000;

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
			return this.acceptStaff();
		}

		// Also already auth-gated in the Worker before reaching here.
		if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
			return this.handleSubscribe(request);
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
		if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
			return jsonError(401, "Incorrect username or password");
		}

		const cookie = await loginCookieHeader(this.env, { username, isAdmin: !!row.is_admin });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
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

	async handleSubscribe(request) {
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

		this.addPushSubscription(body.endpoint, body.keys.p256dh, body.keys.auth);
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

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ role: "visitor", conversationId });

		this.ensureConversation(conversationId);
		server.send(JSON.stringify({ type: "history", messages: this.getMessages(conversationId, since) }));

		return new Response(null, { status: 101, webSocket: client });
	}

	acceptStaff() {
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ role: "staff" });

		server.send(JSON.stringify({ type: "conversations", list: this.getConversationsSummary() }));

		return new Response(null, { status: 101, webSocket: client });
	}

	ensureConversation(conversationId) {
		const sql = this.ctx.storage.sql;
		const exists = sql.exec("SELECT id FROM conversations WHERE id = ?", conversationId).toArray().length > 0;
		if (!exists) {
			const now = Date.now();
			sql.exec(
				"INSERT INTO conversations (id, created_at, last_message_at, status, unread_by_staff) VALUES (?, ?, ?, 'open', 0)",
				conversationId,
				now,
				now
			);
		}
	}

	getMessages(conversationId, sinceId) {
		const rows = this.ctx.storage.sql
			.exec(
				"SELECT id, sender, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
				conversationId,
				sinceId,
				HISTORY_LIMIT
			)
			.toArray();
		return rows.map((r) => ({ id: r.id, sender: r.sender, body: r.body, createdAt: r.created_at }));
	}

	// One row per open conversation, each carrying a preview of its most
	// recent message, for the staff dashboard's conversation list.
	getConversationsSummary() {
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT
					c.id, c.created_at, c.last_message_at, c.unread_by_staff,
					(SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
					(SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
				FROM conversations c
				WHERE c.status = 'open'
				ORDER BY c.last_message_at DESC
				LIMIT ?`,
				CONVERSATION_LIST_LIMIT
			)
			.toArray();
		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			lastMessageAt: r.last_message_at,
			unreadByStaff: r.unread_by_staff,
			lastBody: r.last_body,
			lastSender: r.last_sender,
		}));
	}

	markReadByStaff(conversationId) {
		this.ctx.storage.sql.exec("UPDATE conversations SET unread_by_staff = 0 WHERE id = ?", conversationId);
	}

	getPushSubscriptions() {
		return this.ctx.storage.sql.exec("SELECT endpoint, p256dh, auth FROM push_subscriptions").toArray();
	}

	addPushSubscription(endpoint, p256dh, auth) {
		const sql = this.ctx.storage.sql;
		// Delete-then-insert rather than an upsert -- simpler to reason about,
		// and this table is small enough (one row per staff device) that there's
		// no meaningful cost to it.
		sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
		sql.exec(
			"INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)",
			endpoint,
			p256dh,
			auth,
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

	insertMessage(conversationId, sender, body) {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec(
			"INSERT INTO messages (conversation_id, sender, body, created_at) VALUES (?, ?, ?, ?)",
			conversationId,
			sender,
			body,
			now
		);
		const { id } = sql.exec("SELECT last_insert_rowid() AS id").one();
		sql.exec(
			"UPDATE conversations SET last_message_at = ?, unread_by_staff = unread_by_staff + ? WHERE id = ?",
			now,
			sender === "visitor" ? 1 : 0,
			conversationId
		);
		return { id, sender, body, createdAt: now };
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
			this.handleStaffMessage(ws, data);
		}
	}

	handleVisitorMessage(ws, attachment, data) {
		if (data.type !== "message" || typeof data.body !== "string") return;

		const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
		if (!body) return;

		const saved = this.insertMessage(attachment.conversationId, "visitor", body);
		this.broadcastToConversation(attachment.conversationId, { type: "message", message: saved }, ws);

		// Let any connected staff know live -- both an in-thread update (if
		// they happen to have this exact conversation open) and a refreshed
		// list (new preview text, moved to the top, unread count changed).
		this.broadcastToStaff({ type: "message", conversationId: attachment.conversationId, message: saved });
		this.broadcastToStaff({ type: "conversations", list: this.getConversationsSummary() });

		// Only push if nobody's actually watching the dashboard right now --
		// if a staff device is connected, the broadcasts above already reached
		// it live, a phone buzz would just be noise.
		if (!this.hasConnectedStaff()) {
			this.ctx.waitUntil(this.notifyStaffOfNewMessage(attachment.conversationId, body));
		}
	}

	handleStaffMessage(ws, data) {
		if (data.type === "loadConversation" && typeof data.conversationId === "string") {
			this.markReadByStaff(data.conversationId);
			ws.send(JSON.stringify({ type: "history", conversationId: data.conversationId, messages: this.getMessages(data.conversationId, 0) }));
			this.broadcastToStaff({ type: "conversations", list: this.getConversationsSummary() });
			return;
		}

		if (data.type === "reply" && typeof data.conversationId === "string" && typeof data.body === "string") {
			const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
			if (!body) return;

			const saved = this.insertMessage(data.conversationId, "staff", body);
			this.broadcastToConversation(data.conversationId, { type: "message", message: saved });
			this.broadcastToStaff({ type: "message", conversationId: data.conversationId, message: saved });
			this.broadcastToStaff({ type: "conversations", list: this.getConversationsSummary() });
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
