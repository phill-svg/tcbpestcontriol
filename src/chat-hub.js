import { DurableObject } from "cloudflare:workers";

const HISTORY_LIMIT = 50;
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
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === "/api/chat/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 400 });
			}
			return this.acceptVisitor(url);
		}

		return new Response("Not found", { status: 404 });
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
		if (!attachment || attachment.role !== "visitor") return;

		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}
		if (data.type !== "message" || typeof data.body !== "string") return;

		const body = data.body.trim().slice(0, MAX_MESSAGE_LENGTH);
		if (!body) return;

		const saved = this.insertMessage(attachment.conversationId, "visitor", body);
		this.broadcastToConversation(attachment.conversationId, { type: "message", message: saved }, ws);
	}

	// Reaches every other WebSocket open on the same conversation (e.g. the
	// same visitor with two tabs open). Staff broadcasting arrives in a later
	// stage once /api/chat/staff/ws exists.
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

	async webSocketClose(ws, code, reason) {
		ws.close(code, reason);
	}

	async webSocketError() {}
}
