export { ChatHub } from "./chat-hub.js";
import { logoutCookieHeader, getStaffSession } from "./staff-auth.js";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// Canonicalise the bare apex domain to www.
		// Both hostnames are bound as Worker Custom Domains, so Cloudflare
		// Page Rules never get a chance to run for them -- this has to
		// happen here, before assets are served.
		if (url.hostname === "tcbpestcontrolcanberra.com.au") {
			url.hostname = "www.tcbpestcontrolcanberra.com.au";
			return Response.redirect(url.toString(), 301);
		}

		// Enforce the no-trailing-slash URL convention ourselves.
		// html_handling is "none" below because Cloudflare's own
		// trailing-slash/index.html canonicalisation redirects the root
		// path "/" to itself forever -- it has no shorter form to drop
		// the slash to. Handling this in the Worker lets us exempt "/".
		if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			return Response.redirect(url.toString(), 301);
		}

		// Live chat API: WebSocket upgrades (and staff/push routes) are all
		// handled by a single global ChatHub Durable Object instance -- see
		// src/chat-hub.js. The staff socket is gated here, before the request
		// ever reaches the Durable Object: only a request already carrying a
		// valid staff session cookie gets forwarded.
		if (url.pathname === "/api/chat/staff/ws") {
			const session = await getStaffSession(request, env);
			if (!session) {
				return new Response("Unauthorized", { status: 401 });
			}
			// Attaches the verified username (not trusted from the client) so
			// replies can be attributed to whoever actually sent them.
			const forwardUrl = new URL(request.url);
			forwardUrl.searchParams.set("username", session.username);
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(new Request(forwardUrl, request));
		}
		if (url.pathname.startsWith("/api/chat/")) {
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(request);
		}

		// Staff auth: individual username/password accounts, stored in the
		// ChatHub Durable Object (see src/chat-hub.js's staff_users table and
		// src/staff-auth.js for the password hashing / session cookie).
		// bootstrap-check and bootstrap exist to create the very first (admin)
		// account when no accounts exist yet; ordinary logins are always
		// username/password from then on. There's no session storage anywhere
		// beyond the signed cookie -- it's re-verified fresh on every request.
		if (url.pathname === "/api/staff/bootstrap-check" || (url.pathname === "/api/staff/bootstrap" && request.method === "POST")) {
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(request);
		}
		if (url.pathname === "/api/staff/login" && request.method === "POST") {
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(request);
		}
		if (url.pathname === "/api/staff/logout" && request.method === "POST") {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json", "Set-Cookie": logoutCookieHeader() },
			});
		}
		if (url.pathname === "/api/staff/session") {
			const session = await getStaffSession(request, env);
			return new Response(
				JSON.stringify({ authenticated: !!session, username: session ? session.username : null, isAdmin: session ? session.isAdmin : false }),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		// Admin-only: managing other staff accounts. actingUser is attached
		// here (not trusted from the client) so the Durable Object's safety
		// checks -- can't remove yourself, can't remove the last admin -- know
		// who's actually asking.
		if (url.pathname === "/api/staff/users") {
			const session = await getStaffSession(request, env);
			if (!session || !session.isAdmin) return new Response("Forbidden", { status: 403 });
			const forwardUrl = new URL(request.url);
			forwardUrl.searchParams.set("actingUser", session.username);
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(new Request(forwardUrl, request));
		}

		// Web Push: the public key is safe to hand out to anyone (it's designed
		// to be public -- only the private half, held server-side, is secret).
		// Subscribe/unsubscribe are staff-only, same auth gate as the staff
		// socket above, before ever reaching the Durable Object.
		if (url.pathname === "/api/push/vapid-public-key") {
			return new Response(env.VAPID_PUBLIC_KEY || "", { status: 200, headers: { "content-type": "text/plain" } });
		}
		if (url.pathname === "/api/push/subscribe" || url.pathname === "/api/push/unsubscribe") {
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const session = await getStaffSession(request, env);
			if (!session) {
				return new Response("Unauthorized", { status: 401 });
			}
			// Attaches the verified username so team/DM push notifications can
			// target the right device instead of every staff device.
			const forwardUrl = new URL(request.url);
			forwardUrl.searchParams.set("username", session.username);
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(new Request(forwardUrl, request));
		}

		const response = await fetchAsset(request, url, env);

		// Force every served HTML page's canonical tag to self-reference the
		// exact URL it was actually served at. A past URL-structure migration
		// left canonical tags on ~114 pages pointing at a different (often
		// redirecting) URL. Fixing this at the edge, once, keeps every page
		// correct automatically instead of hand-editing each HTML file.
		const contentType = response.headers.get("content-type") || "";
		if (response.status === 200 && contentType.includes("text/html")) {
			const canonicalUrl = `${url.origin}${url.pathname}`;
			// The staff admin dashboard gets its own UI instead of the visitor
			// chat bubble -- see the /staff-chat build in a later stage.
			const isStaffPage = url.pathname === "/staff-chat" || url.pathname.startsWith("/staff-chat/");
			return new HTMLRewriter()
				.on('link[rel="canonical"]', {
					element(el) {
						el.setAttribute("href", canonicalUrl);
					},
				})
				.on(".header-actions", {
					element(el) {
						if (!isStaffPage) el.before(SEARCH_TRIGGER_HTML, { html: true });
					},
				})
				.on("body", {
					element(el) {
						if (!isStaffPage) {
							el.append(SEARCH_OVERLAY_HTML, { html: true });
							el.append(CHAT_WIDGET_HTML, { html: true });
						}
					},
				})
				.transform(response);
		}

		return response;
	},
};

// html_handling is "none", so in principle the assets binding should only
// serve exact matches. In practice, calling env.ASSETS.fetch() directly on a
// bare directory-style path (e.g. "/residential") can still trigger the
// binding's own internal trailing-slash canonicalisation, returning a 301 to
// "/residential/" instead of a 404. Since our top-level handler above strips
// trailing slashes, that redirect immediately bounces back here and loops
// forever between the two forms.
//
// To avoid ever calling the binding on an ambiguous bare-directory path, we
// resolve directory-style URLs (no file extension in the last segment) to
// their index.html directly, first. Only paths that already look like a
// literal file (have an extension) or don't match any index.html fall back
// to an exact-match lookup.
async function fetchAsset(request, url, env) {
	const lastSegment = url.pathname.split("/").pop();
	const looksLikeDirectory = url.pathname === "/" || !lastSegment.includes(".");

	if (looksLikeDirectory) {
		const indexPath = url.pathname === "/" ? "/index.html" : `${url.pathname}/index.html`;
		const indexResponse = await env.ASSETS.fetch(new Request(new URL(indexPath, url), request));
		if (indexResponse.status !== 404) {
			return indexResponse;
		}
	}

	return env.ASSETS.fetch(request);
}

// Injected into every page's header, right before the phone/CTA group, via
// HTMLRewriter -- same "fix it once at the edge" approach used above for
// canonical tags. Visible at every breakpoint (it sits outside the
// .main-nav/.header-actions containers that main.css hides on mobile), so it
// doubles as the mobile search entry point next to the hamburger button.
const SEARCH_TRIGGER_HTML = `<button type="button" class="search-trigger" data-search-open aria-label="Search the site" title="Search (press /)"><svg aria-hidden="true" class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg></button>`;

// Command-palette style overlay appended once per page, just before </body>.
// assets/js/search.js wires it up and lazy-loads assets/search-index.json
// (regenerate that with `node scripts/build-search-index.js` after adding,
// removing, or retitling a page).
const SEARCH_OVERLAY_HTML = `<div class="search-overlay" id="site-search" role="dialog" aria-modal="true" aria-label="Search the site" hidden><div class="search-backdrop" data-search-close></div><div class="search-panel"><div class="search-field"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input type="text" class="search-input" placeholder="Search services, suburbs, articles..." autocomplete="off" aria-label="Search"/><button type="button" class="search-close" data-search-close>Esc</button></div><div class="search-results"></div></div></div><script src="/assets/js/search.js"></script>`;

// Floating chat bubble + panel appended once per page (skipped on the staff
// admin page, which gets its own dashboard UI). assets/js/chat.js wires it
// up and opens a WebSocket to /api/chat/ws, backed by the ChatHub Durable
// Object above.
const CHAT_WIDGET_HTML = `<button type="button" class="chat-bubble" data-chat-open aria-label="Chat with us" title="Chat with us"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></button><div class="chat-panel" id="site-chat" role="dialog" aria-modal="true" aria-label="Chat with TCB Pest Control" hidden><div class="chat-panel-inner"><div class="chat-header"><div class="chat-header-brand"><span class="chat-header-badge"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg></span><div class="chat-header-text"><span class="chat-header-title">TCB Pest Control</span><span class="chat-header-subtitle">Chat with us</span></div></div><button type="button" class="chat-close" data-chat-close aria-label="Close chat"><span class="chat-close-esc">Esc</span><span class="chat-close-icon">&times;</span></button></div><div class="chat-intake" data-chat-intake><p class="chat-intake-title">Let's chat</p><p class="chat-intake-lead">Tell us who you are and we will get you sorted.</p><form class="form" data-chat-intake-form><div class="field"><label for="chat-name">Name</label><input id="chat-name" name="name" type="text" autocomplete="name" required/></div><div class="field"><label for="chat-email">Email</label><input id="chat-email" name="email" type="email" autocomplete="email" required/></div><div class="form-footer"><button class="btn btn-primary" type="submit">Start chat</button></div></form></div><div class="chat-messages" data-chat-messages hidden><p class="chat-hint">Send us a message and we will reply here as soon as we can.</p></div><form class="chat-input-row" data-chat-form hidden><input type="text" class="chat-input" data-chat-input placeholder="Type a message..." autocomplete="off" aria-label="Message" maxlength="2000" required/><button type="submit" class="btn btn-primary chat-send-icon" aria-label="Send"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></form></div></div><script src="/assets/js/chat.js"></script>`;
