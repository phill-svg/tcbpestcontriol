export { ChatHub } from "./chat-hub.js";
import { loginCookieHeader, logoutCookieHeader, getStaffSession, shouldRenewSession } from "./staff-auth.js";
import { sendPasswordResetEmail } from "./email.js";
import { validateBookingFields, validateEnquiryFields, createBookingAndNotify } from "./booking.js";
import { diagnoseServiceM8, readStaffOccupancy } from "./servicem8.js";
import { handleMcp } from "./mcp.js";
import { handleIndexJson } from "./index-json.js";
import { renderMarkdown } from "./markdown.js";
import { isBookableService, SERVICE_LABELS, HORIZON_DAYS, computePrice } from "./booking-config.js";
import { computeSlots } from "./availability.js";
import { loadPageEdits, applyContentEdits, handleContentApi } from "./content-edits.js";
import { normalisePath } from "../assets/js/content-address.js";
import { handleBlogApi } from "./blog-api.js";
import { pathsFromSitemap, scanBatch, extractPageSummary } from "./seo-scan.js";
import { suggest, extractContent, extractMeta, examplePaths } from "./seo-suggest.js";
import { TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX } from "../assets/js/seo-check.js";
import { findGaps, describeGap, fixForGap } from "./seo-gaps.js";
import { fetchAsset, fetchNegotiatedImage } from "./assets.js";
import {
	insights as searchInsights,
	isConfigured as isSearchConsoleConfigured,
	setupMessage as searchConsoleSetupMessage,
	setupSteps as searchConsoleSetupSteps,
} from "./search-console.js";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// canberrabirdcontrol.com.au is a brand-protection domain only --
		// every path funnels to the bird-control page on the main site.
		// It must never serve content of its own (duplicate-site risk).
		if (url.hostname.endsWith("canberrabirdcontrol.com.au")) {
			return Response.redirect("https://www.tcbpestcontrolcanberra.com.au/bird-control", 301);
		}

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
		// Public: request a staff account. Stays pending until an admin approves.
		if (url.pathname === "/api/staff/signup" && request.method === "POST") {
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(request);
		}
		// Forgot-password: the Durable Object creates the one-time token and
		// hands back the recipient + link via `_send`; the Worker performs the
		// actual email send here (the send_email binding is only reliably
		// available in this request context, not inside the DO). Always returns
		// a generic { ok: true } so accounts can't be enumerated.
		if (url.pathname === "/api/staff/forgot" && request.method === "POST") {
			const id = env.CHAT_HUB.idFromName("global");
			const doResp = await env.CHAT_HUB.get(id).fetch(request);
			let data = {};
			try {
				data = await doResp.json();
			} catch {}
			if (data && data._send && data._send.to) {
				const sending = sendPasswordResetEmail(env, data._send.to, data._send.resetUrl, data._send.username).catch(
					(e) => console.error("Password reset email send failed:", e && (e.stack || e.message))
				);
				if (ctx && ctx.waitUntil) ctx.waitUntil(sending);
				else await sending;
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		// Consume a reset token (sets the new password). Handled entirely in the DO.
		if (url.pathname === "/api/staff/reset-with-token" && request.method === "POST") {
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(request);
		}
		// Signed-in staff set their own recovery email. Auth-gated here, with the
		// verified username attached so the Durable Object never trusts the body.
		if (url.pathname === "/api/staff/set-email" && request.method === "POST") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			const forwardUrl = new URL(request.url);
			forwardUrl.searchParams.set("username", session.username);
			const id = env.CHAT_HUB.idFromName("global");
			return env.CHAT_HUB.get(id).fetch(new Request(forwardUrl, request));
		}
		// Staff-only: push a chat lead into ServiceM8. The Durable Object does the
		// dedup + create via the ServiceM8 API (see src/servicem8.js).
		// Staff-only: says what ServiceM8 thinks of our lead notifications --
		// who would be notified, whether the account has an allocation window,
		// and (with ?job=UUID) the raw result of really allocating that job.
		if (url.pathname === "/api/staff/servicem8/diagnose") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			const report = await diagnoseServiceM8(env, url.searchParams.get("job") || "");
			return new Response(JSON.stringify(report, null, 2), {
				status: 200,
				headers: { "content-type": "application/json", "Cache-Control": "no-store" },
			});
		}

		if (url.pathname === "/api/staff/servicem8/create-job" && request.method === "POST") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
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
			// Never let a cached copy of this stand in for a real check.
			const headers = { "content-type": "application/json", "Cache-Control": "no-store" };
			// The dashboard calls this on every load, which makes it the natural
			// place to slide the session forward -- so anyone using the staff
			// chat regularly is never signed out from underneath themselves.
			if (session && shouldRenewSession(session)) {
				headers["Set-Cookie"] = await loginCookieHeader(env, session);
			}
			return new Response(
				JSON.stringify({ authenticated: !!session, username: session ? session.username : null, isAdmin: session ? session.isAdmin : false }),
				{ status: 200, headers }
			);
		}
		// Admin-only: managing other staff accounts. actingUser is attached
		// here (not trusted from the client) so the Durable Object's safety
		// checks -- can't remove yourself, can't remove the last admin -- know
		// who's actually asking.
		if (url.pathname === "/api/staff/users" || url.pathname.startsWith("/api/staff/signup-requests")) {
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
		if (
			url.pathname === "/api/push/subscribe" ||
			url.pathname === "/api/push/unsubscribe" ||
			url.pathname === "/api/push/status" ||
			url.pathname === "/api/push/test"
		) {
			// /status is a GET; the rest are POST-only.
			const readOnly = url.pathname === "/api/push/status";
			if (!readOnly && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
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

		// What people actually searched before they arrived. Read-only, and
		// the only thing in the editor that reports what happened rather than
		// what some check thinks ought to happen.
		if (url.pathname === "/api/seo/search-console") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleSearchConsole(url, env);
		}

		// Drafting a better title or description for a page. Writes nothing --
		// the candidates come back as suggestions and are saved by hand like
		// any other edit.
		if (url.pathname === "/api/seo/suggest") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleSeoSuggest(request, url, env);
		}

		// Site-wide SEO scan. Batched: the browser asks for a slice at a time
		// and shows progress, because reading and checking 134 pages in one
		// invocation is well past what a Worker should attempt at once.
		if (url.pathname === "/api/seo/scan") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleSeoScan(request, url, env);
		}

		// Second half of the same scan: checking that the pages linked to
		// actually load. Separate from /api/seo/scan because it can only run
		// once every page has been read and the full list of destinations is
		// known -- see handleSeoLinks.
		if (url.pathname === "/api/seo/links") {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleSeoLinks(request, url, env);
		}

		// Creating blog posts from the editor -- see src/blog-api.js. Same admin
		// gate as the content API below: this writes to the repository.
		if (url.pathname.startsWith("/api/blog/")) {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleBlogApi(request, url, env, session);
		}

		// Visual editor API: saving, previewing and publishing copy changes
		// made by clicking around the live site. Admin-only -- ordinary staff
		// accounts run the chat dashboard, but this rewrites the public
		// website, so it is held to the same bar as managing staff accounts.
		if (url.pathname.startsWith("/api/content/")) {
			const session = await getStaffSession(request, env);
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (!session.isAdmin) return new Response("Forbidden", { status: 403 });
			return handleContentApi(request, url, env, session);
		}

		// Public online-booking form (/book) -> creates a ServiceM8 Quote job.
		// Protected by a honeypot + strict validation (Turnstile can be layered on
		// later by setting TURNSTILE_SECRET and adding the widget to the form).
		if (url.pathname === "/api/booking" && request.method === "POST") {
			return handleBooking(request, env, ctx);
		}

		// Live slot availability for the online booking widget -- always fresh
		// (never cached: it reflects Phill's real ServiceM8 diary at request time)
		// and fails safe (no slots offered) if occupancy can't be read.
		if (url.pathname === "/api/availability" && request.method === "GET") {
			return handleAvailability(request, env);
		}

		// The /contact enquiry form posts straight here: emails the office,
		// creates a ServiceM8 Quote job and pings staff in the app, then sends
		// the visitor on to /thank-you. See handleContactEnquiry.
		if (url.pathname === "/api/contact" && request.method === "POST") {
			return handleContactEnquiry(request, env, ctx);
		}

		// Public MCP (Model Context Protocol) server -- lets AI agents query
		// suburb coverage, the services list and published starting prices
		// directly instead of guessing from crawled page text. See src/mcp.js.
		if (url.pathname === "/mcp") {
			return handleMcp(request, env, ctx);
		}

		// Typed JSON index of the whole site (services, locations, pricing,
		// pages, MCP info) for agents that want a structured manifest instead
		// of crawling HTML. See src/index-json.js.
		if (url.pathname === "/index.json") {
			return handleIndexJson();
		}

		// Per-page Markdown for agents that prefer plain text over HTML, e.g.
		// "/spider-control.md" renders "/spider-control" as Markdown. See
		// src/markdown.js. Falls through to a normal 404 if the source page
		// doesn't exist.
		if (url.pathname.endsWith(".md")) {
			const sourceUrl = new URL(url.pathname.slice(0, -3) || "/", url);
			const htmlResponse = await fetchAsset(request, sourceUrl, env);
			if (htmlResponse.status === 200 && (htmlResponse.headers.get("content-type") || "").includes("text/html")) {
				return renderMarkdown(htmlResponse, sourceUrl);
			}
			return new Response("Not found", { status: 404 });
		}

		// Hand browsers that can read AVIF the smaller copy of any .webp the
		// pages ask for. See fetchNegotiatedImage; null means this request isn't
		// one of those and the ordinary asset path below handles it.
		const negotiatedImage = await fetchNegotiatedImage(request, url, env);
		if (negotiatedImage) return negotiatedImage;

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

			// Visual editor (see src/content-edits.js). Published copy edits are
			// applied for *everyone*; the editor UI itself is attached only for
			// a signed-in admin.
			//
			// Working out whether someone is an admin costs an HMAC verify, so
			// it is only attempted when a staff cookie is actually present --
			// which is nobody, for essentially all traffic.
			const editorSession = hasStaffCookie(request) ? await getStaffSession(request, env) : null;
			const canEdit = !!(editorSession && editorSession.isAdmin) && !isStaffPage;
			// Preview shows unpublished drafts in place. It is deliberately not
			// sticky: it lives in the query string, so closing the tab or
			// sharing the URL can't leave anyone looking at unpublished copy.
			const previewing = canEdit && url.searchParams.get("preview") === "1";
			// Edit mode serves the page *exactly as the HTML file writes it*,
			// with no overrides applied at all. That is what keeps addressing
			// honest: the editor works out an edit's address by hashing the text
			// it can see, so it has to be looking at the same words the file
			// contains. Were it shown already-edited copy, re-editing the same
			// sentence would mint a second address keyed to the new wording --
			// which the file never matches -- and the change would vanish. The
			// editor re-applies the current values in the browser instead, so
			// what you see is still up to date.
			const editing = canEdit && url.searchParams.get("edit") === "1";
			const contentPath = normalisePath(url.pathname);
			let pageEdits = null;
			if (!editing) {
				try {
					pageEdits = await loadPageEdits(env, contentPath, { includeDrafts: previewing });
				} catch (error) {
					// A copy override failing is never worth failing the page over --
					// the visitor should just see the original wording.
					console.error("Content edits lookup failed:", error && (error.stack || error.message));
				}
			}

			const rewritten = applyContentEdits(new HTMLRewriter(), pageEdits)
				.on('link[rel="canonical"]', {
					element(el) {
						el.setAttribute("href", canonicalUrl);
					},
				})
				.on(".header-actions", {
					element(el) {
						if (!isStaffPage && !editing) el.before(SEARCH_TRIGGER_HTML, { html: true });
					},
				})
				.on("main", {
					element(el) {
						// Skip-link target -- every page's content sits in a single
						// <main>, so this alone gets every page covered.
						el.setAttribute("id", "main-content");
					},
				})
				.on("body", {
					element(el) {
						// Skip-to-content link: applies everywhere (including the staff
						// dashboard), unlike the visitor search/chat widgets below.
						el.prepend(SKIP_LINK_HTML, { html: true });
						// The search overlay and chat bubble are left off in edit
						// mode: both are interactive widgets that would sit on top of
						// the words being edited, and both build their own DOM after
						// load, which is exactly the kind of churn the editor's text
						// walk is better off never seeing.
						if (!isStaffPage && !editing) {
							el.append(SEARCH_OVERLAY_HTML, { html: true });
							el.append(CHAT_WIDGET_HTML, { html: true });
						}
						if (canEdit) el.append(editorLauncherHtml({ editing, previewing }), { html: true });
					},
				})
				.transform(response);

			const finalResponse = withAgentDiscoveryLinks(rewritten);
			if (canEdit) {
				// A page carrying the editor (or showing unpublished drafts) must
				// never be handed to a shared cache, or a visitor could be served
				// the admin's copy of it.
				const headers = new Headers(finalResponse.headers);
				headers.set("Cache-Control", "no-store");
				return new Response(finalResponse.body, { status: finalResponse.status, headers });
			}
			return finalResponse;
		}

		return response;
	},
};

// Advertises machine-readable resources for AI agents/crawlers per RFC 8288
// (Link headers) and RFC 9727 (the "api-catalog" relation): llms.txt as a
// site description, and .well-known/api-catalog as the discovery entrypoint
// listing it alongside the sitemap and blog feed.
//
// This is set here, in code, rather than left to the _headers file's "/"
// rule: fetchAsset() below rewrites "/" to "/index.html" before calling
// env.ASSETS.fetch(), so the request _headers actually sees for the homepage
// never matches a rule keyed on the exact path "/". Any pre-existing Link
// header is dropped first so the two sources can never combine into
// duplicates.
function withAgentDiscoveryLinks(response) {
	const headers = new Headers(response.headers);
	headers.delete("Link");
	headers.append("Link", '</.well-known/api-catalog>; rel="api-catalog"');
	headers.append("Link", '</llms.txt>; rel="describedby"');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
// Shared by handleAvailability and handleBooking's slot re-validation, so the
// two can never compute availability differently. Pads the horizon by two
// days beyond HORIZON_DAYS when reading ServiceM8 occupancy -- computeSlots
// itself stops offering days past the horizon, but the pad keeps the busy-time
// window comfortably clear of the last offered day's slots across a TZ edge.
// Throws whenever readStaffOccupancy does (ServiceM8 read failure) -- callers
// must fail safe (never offer a slot when occupancy is unknown), not swallow it.
async function computeAvailabilityFor(env, service, nowMs) {
	const fromMs = nowMs;
	const toMs = nowMs + (HORIZON_DAYS + 2) * 86400000;
	const occupancy = await readStaffOccupancy(env, fromMs, toMs);
	return computeSlots({ occupancy, service, nowMs });
}

// GET /api/availability?service=<key>[&date=YYYY-MM-DD] -- live slots for the
// online booking widget. Always Cache-Control: no-store (it reflects Phill's
// real ServiceM8 diary at request time); fails safe with a 503 rather than
// showing stale or empty availability if occupancy can't be read.
async function handleAvailability(request, env) {
	const url = new URL(request.url);
	const service = String(url.searchParams.get("service") || "").trim();
	if (!isBookableService(service)) {
		return jsonError(400, "Unknown service.");
	}

	let result;
	try {
		result = await computeAvailabilityFor(env, service, Date.now());
	} catch (e) {
		console.error("Availability read failed:", e && (e.stack || e.message));
		return new Response(
			JSON.stringify({ ok: false, error: "We couldn't load live availability just now — please call us on 02 6105 9771." }),
			{ status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store" } }
		);
	}

	const date = String(url.searchParams.get("date") || "").trim();
	if (date) {
		const day = result.days.find((d) => d.date === date);
		result = { ...result, days: day ? [day] : [] };
	}

	return new Response(JSON.stringify({ ok: true, ...result }), {
		status: 200,
		headers: { "content-type": "application/json", "Cache-Control": "no-store" },
	});
}

// Handle a public booking-form submission: validate, (optionally) verify
// Turnstile, then hand off to the shared booking pipeline in src/booking.js
// (also used by the submit_booking_enquiry MCP tool in src/mcp.js).
//
// Two paths, chosen by whether the client posted a chosen slotStartIso:
//   - present -> scheduled auto-booking: the slot is re-validated against a
//     freshly-recomputed availability (never trust the client -- an
//     already-taken or now-expired slot is caught here), then handed to
//     createBookingAndNotify with opts.slot to lock it in and confirm.
//   - absent  -> the original JS-disabled fallback / lead behaviour, unchanged.
async function handleBooking(request, env, ctx) {
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonError(400, "Invalid request.");
	}

	// Honeypot: real users never fill this hidden field. Silently accept + drop.
	if (body.company) return okJson({ ok: true });

	const name = String(body.name || "").trim();
	const email = String(body.email || "").trim();
	const phone = String(body.phone || "").trim();
	const address = String(body.address || "").trim();
	const service = String(body.service || "").trim();
	const date = String(body.date || "").trim();
	const time = String(body.time || "").trim();
	const message = String(body.message || "").trim();

	const fields = { name, email, phone, address, service, date, time, message };
	const errors = validateBookingFields(fields);
	if (errors.length) return jsonError(400, errors[0]);

	// Optional Turnstile -- only enforced once TURNSTILE_SECRET is configured.
	if (env.TURNSTILE_SECRET) {
		const ok = await verifyTurnstile(env, body.turnstileToken, request);
		if (!ok) return jsonError(400, "Verification failed. Please try again.");
	}

	const slotStartIso = String(body.slotStartIso || "").trim();
	const modifier = String(body.modifier || "").trim();
	const quoteRequested = String(body.quoteRequested || "") === "1";

	// Custom-quote request: no fixed price and no firm appointment time. Create a
	// lead (exactly like the enquiry form) for the owner to price and schedule by
	// hand -- skip the availability/slot path and the pricing entirely.
	if (quoteRequested) {
		const svcLabel = isBookableService(service) ? SERVICE_LABELS[service] : service;
		const quoteFields = {
			...fields,
			service: svcLabel,
			message: [
				message,
				`Customer requested a CUSTOM QUOTE${modifier ? " (" + modifier + ")" : ""} — no fixed price. Please quote and arrange a time.`,
			]
				.filter(Boolean)
				.join("\n"),
		};
		await createBookingAndNotify(env, ctx, quoteFields, "Custom quote request (website /book form)", {
			alertLabel: "New quote request",
			emailLabel: "quote request",
		});
		return okJson({ ok: true, quote: true });
	}

	if (slotStartIso) {
		// Scheduled booking: `service` here is a booking-config service KEY
		// (the widget's <select> uses the key as its value), not free text.
		if (!isBookableService(service)) {
			return jsonError(400, "Please choose a bookable service.");
		}

		// Re-validate the slot server-side -- never trust the client. Recomputing
		// availability from scratch (rather than trusting the posted end time)
		// also catches a slot that's since been taken or has aged past "now".
		let avail;
		try {
			avail = await computeAvailabilityFor(env, service, Date.now());
		} catch (e) {
			console.error("Availability read failed during booking:", e && (e.stack || e.message));
			return jsonError(503, "We couldn't complete your booking — please call us on 02 6105 9771.");
		}
		const matched = avail.days.flatMap((d) => d.slots).find((s) => s.startIso === slotStartIso);
		if (!matched) {
			return jsonError(409, "That time is no longer available — please pick another.");
		}

		// Pricing is authoritative here, server-side -- the front end only ever
		// DISPLAYS a price, it never sends one. `modifier` (read above) picks a
		// fixed price off booking-config.js's PRICING table. (Quote requests were
		// already handled above and never reach this priced slot-booking path.)
		const p = computePrice(service, modifier);
		if (!p.ok) return jsonError(400, "Please choose an option for that service.");
		const pricing = { amount: p.amount, modifierLabel: p.modifierLabel };

		const scheduledFields = { ...fields, service: SERVICE_LABELS[service] };
		const slot = { startIso: matched.startIso, endIso: matched.endIso, serviceKey: service };
		const r = await createBookingAndNotify(env, ctx, scheduledFields, "Online booking (website /book form)", { slot, pricing });

		if (r.conflict) return jsonError(409, "That time was just taken — please pick another.");
		if (r.error) return jsonError(502, "We couldn't complete your booking — please call us on 02 6105 9771.");
		return okJson({ ok: true, booked: true });
	}

	await createBookingAndNotify(env, ctx, fields, "Online booking request (website /book form)");

	return okJson({ ok: true });
}

// The /contact enquiry form, which the form posts to directly -- it used to go
// to Web3Forms, which emailed the office but never touched this Worker, so an
// enquiry never became a ServiceM8 job. Now this endpoint does both.
//
// It's a plain HTML form post, not fetch: no JavaScript is required to send an
// enquiry, and the reply is a 303 back to the thank-you page (the same page
// Web3Forms used to redirect to). A JSON body still gets a JSON reply, which
// keeps the endpoint usable from a script.
//
// The ServiceM8 + email work is handed to waitUntil so a slow ServiceM8 API
// can't hold up that redirect.
async function handleContactEnquiry(request, env, ctx) {
	const contentType = request.headers.get("content-type") || "";
	const wantsJson = contentType.includes("application/json");

	let body;
	if (wantsJson) {
		try {
			body = await request.json();
		} catch {
			return jsonError(400, "Invalid request.");
		}
	} else {
		try {
			const form = await request.formData();
			body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
		} catch {
			return contactError(400, "We couldn't read that submission. Please try again.");
		}
	}

	// botcheck is the form's own honeypot -- real people never fill it in.
	// Accept and drop silently rather than telling a bot it was spotted.
	if (body.botcheck || body.company) {
		return wantsJson ? okJson({ ok: true }) : Response.redirect(new URL("/thank-you", request.url).toString(), 303);
	}

	const fields = {
		name: String(body.name || "").trim(),
		email: String(body.email || "").trim(),
		phone: String(body.phone || "").trim(),
		// The enquiry form doesn't ask for one; the job gets a blank address
		// and staff fill it in when they quote.
		address: "",
		service: String(body.service || "").trim(),
		date: "",
		time: "",
		message: String(body.message || "").trim(),
	};

	const errors = validateEnquiryFields(fields);
	if (errors.length) return wantsJson ? jsonError(400, errors[0]) : contactError(400, errors[0]);

	// Same optional spam gate as /book -- only enforced once TURNSTILE_SECRET
	// is set. Web3Forms did its own filtering, so this is the replacement hook.
	if (env.TURNSTILE_SECRET) {
		const ok = await verifyTurnstile(env, body.turnstileToken || body["cf-turnstile-response"], request);
		if (!ok) {
			const msg = "Verification failed. Please try again.";
			return wantsJson ? jsonError(400, msg) : contactError(400, msg);
		}
	}

	const work = createBookingAndNotify(env, ctx, fields, "Website enquiry (contact form)", {
		alertLabel: "New enquiry",
		emailLabel: "enquiry",
		// The office notification is the whole reason Web3Forms was here, so it
		// has to keep going out. The customer gets an acknowledgement too --
		// worded as an enquiry reply, not a booking confirmation for a time
		// they never picked. Web3Forms never sent them anything at all.
		notifyOffice: true,
		confirmCustomer: true,
	}).catch((e) => console.error("Contact enquiry failed:", e && (e.stack || e.message)));

	if (ctx && ctx.waitUntil) ctx.waitUntil(work);
	else await work;

	if (wantsJson) return okJson({ ok: true });
	return Response.redirect(new URL("/thank-you", request.url).toString(), 303);
}

// A validation failure on a no-JavaScript form post can't be shown inline, so
// this is the fallback: a plain page that says what went wrong and sends them
// back. The browser's own required/type=email checks catch nearly everything
// before it gets here, so this is rare by design.
function contactError(status, messageText) {
	const escaped = String(messageText).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
	);
	const html =
		`<!doctype html><html lang="en-AU"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your enquiry</title>` +
		`<style>body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:3rem 1.5rem;color:#111114;line-height:1.6}` +
		`main{max-width:32rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .75rem}` +
		`a{color:#c41613;font-weight:700}</style></head><body><main>` +
		`<h1>We couldn't send that enquiry</h1><p>${escaped}</p>` +
		`<p><a href="/contact#quote">Go back and try again</a> &mdash; or call us on <a href="tel:0261059771">02 6105 9771</a>.</p>` +
		`</main></body></html>`;
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function verifyTurnstile(env, token, request) {
	if (!token) return false;
	const form = new FormData();
	form.append("secret", env.TURNSTILE_SECRET);
	form.append("response", token);
	const ip = request.headers.get("CF-Connecting-IP");
	if (ip) form.append("remoteip", ip);
	try {
		const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
		const d = await r.json();
		return !!d.success;
	} catch {
		return false;
	}
}

function okJson(obj) {
	return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

function jsonError(status, message) {
	return new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } });
}


// True if the request even carries a staff session cookie. Verifying a
// session costs an HMAC, and the overwhelming majority of traffic is
// logged-out visitors, so this cheap string check keeps that cost off the
// hot path entirely.
function hasStaffCookie(request) {
	return (request.headers.get("Cookie") || "").includes("tcb_staff_session=");
}

// The editor's entry point, added to every page an admin views: a button
// while browsing normally, the full editor once ?edit=1 is on.
//
// data-tcb-injected marks this as Worker-injected markup. The editor's own
// DOM walk skips these subtrees, because HTMLRewriter never re-parses what
// it injects -- so the browser would otherwise count text nodes the Worker
// never saw, and every ordinal after the first injection would disagree.
function editorLauncherHtml({ editing, previewing }) {
	const mode = editing ? "edit" : previewing ? "preview" : "browse";
	return (
		`<div data-tcb-injected data-tcb-editor="root" data-tcb-mode="${mode}">` +
	// The version is bumped once here to get past copies already frozen in
		// browsers by the old immutable rule -- a year-long cache entry cannot be
		// revalidated away, only stepped around with a different URL. The
		// no-cache rule in _headers is what stops it happening again.
		`<link rel="stylesheet" href="/assets/css/editor.css?v=8">` +
		`<script src="/assets/js/editor.js?v=1" type="module"></script>` +
		`</div>`
	);
}

// Off-screen until focused (see .skip-link in assets/css/src/00-base.css) --
// lets keyboard and screen-reader users jump past the header nav instead of
// tabbing through it on every single page. Targets the id="main-content"
// the "main" HTMLRewriter handler above sets on every page's <main>.
const SKIP_LINK_HTML = `<a data-tcb-injected class="skip-link" href="#main-content">Skip to main content</a>`;

// Injected into every page's header, right before the phone/CTA group, via
// HTMLRewriter -- same "fix it once at the edge" approach used above for
// canonical tags. Visible at every breakpoint (it sits outside the
// .main-nav/.header-actions containers that main.css hides on mobile), so it
// doubles as the mobile search entry point next to the hamburger button.
const SEARCH_TRIGGER_HTML = `<button data-tcb-injected type="button" class="search-trigger" data-search-open aria-label="Search the site" title="Search (press /)"><svg aria-hidden="true" class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg></button>`;

// Command-palette style overlay appended once per page, just before </body>.
// assets/js/search.js wires it up and lazy-loads assets/search-index.json
// (regenerate that with `node scripts/build-search-index.js` after adding,
// removing, or retitling a page).
const SEARCH_OVERLAY_HTML = `<div data-tcb-injected class="search-overlay" id="site-search" role="dialog" aria-modal="true" aria-label="Search the site" hidden><div class="search-backdrop" data-search-close></div><div class="search-panel"><div class="search-field"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input type="text" class="search-input" placeholder="Search services, suburbs, articles..." autocomplete="off" aria-label="Search"/><button type="button" class="search-close" data-search-close>Esc</button></div><div class="search-results"></div></div></div><script src="/assets/js/search.js?v=1" defer></script>`;

// Floating chat bubble + panel appended once per page (skipped on the staff
// admin page, which gets its own dashboard UI). assets/js/chat.js wires it
// up and opens a WebSocket to /api/chat/ws, backed by the ChatHub Durable
// Object above.
const CHAT_WIDGET_HTML = `<button data-tcb-injected type="button" class="chat-bubble" data-chat-open aria-label="Chat with us" title="Chat with us"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></button><div data-tcb-injected class="chat-panel" id="site-chat" role="dialog" aria-modal="true" aria-label="Chat with TCB Pest Control" hidden><div class="chat-panel-inner"><div class="chat-header"><div class="chat-header-brand"><span class="chat-header-badge"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg></span><div class="chat-header-text"><span class="chat-header-title">TCB Pest Control</span><span class="chat-header-subtitle">Chat with us</span></div></div><button type="button" class="chat-close" data-chat-close aria-label="Close chat"><span class="chat-close-esc">Esc</span><span class="chat-close-icon">&times;</span></button></div><div class="chat-intake" data-chat-intake><p class="chat-intake-title">Let's chat</p><p class="chat-intake-lead">Tell us who you are and we will get you sorted.</p><form class="form" data-chat-intake-form><div class="field"><label for="chat-name">Name</label><input id="chat-name" name="name" type="text" autocomplete="name" required/></div><div class="field"><label for="chat-email">Email</label><input id="chat-email" name="email" type="email" autocomplete="email" required/></div><div class="field"><label for="chat-phone">Phone</label><input id="chat-phone" name="phone" type="tel" autocomplete="tel" required/></div><div class="form-footer"><button class="btn btn-primary" type="submit">Start chat</button></div></form></div><div class="chat-messages" data-chat-messages hidden><p class="chat-hint">Send us a message and we will reply here as soon as we can.</p></div><form class="chat-input-row" data-chat-form hidden><input type="text" class="chat-input" data-chat-input placeholder="Type a message..." autocomplete="off" aria-label="Message" maxlength="2000" required/><button type="submit" class="btn btn-primary chat-send-icon" aria-label="Send"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></form></div></div><script src="/assets/js/chat.js?v=3" defer></script>`;

// One slice of the site-wide SEO scan. The page list comes from sitemap.xml,
// which is the list Google actually crawls -- a page missing from it is
// invisible whatever its title says, and one listed but gone is worth seeing.
//
// Pages are read through the assets binding rather than over the network, so
// a scan costs no external requests. Published title and description overrides
// are layered on, so the report reflects what a visitor sees rather than what
// the file happens to say.
async function handleSeoScan(request, url, env) {
	const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
	// Deliberately small. The limit that matters is CPU per invocation, not
	// wall time, and a page of this site is around 80KB to parse.
	const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));

	const sitemapResponse = await env.ASSETS.fetch(new Request(new URL("/sitemap.xml", url), request));
	if (sitemapResponse.status !== 200) {
		return new Response(JSON.stringify({ error: "Could not read sitemap.xml." }), {
			status: 502,
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	}
	const paths = pathsFromSitemap(await sitemapResponse.text());

	const batch = await scanBatch({
		paths,
		offset,
		limit,
		fetchPage: (path) => fetchAsset(request, new URL(path, url), env),
		loadEdits: (path) => loadPageEdits(env, path).catch(() => null),
		origin: url.origin,
	});

	return new Response(
		JSON.stringify({
			total: paths.length,
			offset,
			scanned: batch.scanned,
			done: batch.done,
			results: batch.results,
			pages: batch.pages,
		}),
		{ headers: { "content-type": "application/json", "Cache-Control": "no-store" } }
	);
}

// Drafts a title or description for one page.
//
// Grounded in the page's own words, and in the phrases people really searched
// to reach it when Search Console is connected -- a suggestion built from
// what the page says and what worked is worth having; one invented from a
// URL is not. Everything is validated in src/seo-suggest.js before it comes
// back, and arrives in the editor as a draft to accept or ignore.
async function handleSeoSuggest(request, url, env) {
	let body = {};
	try {
		body = await request.json();
	} catch {
		return jsonError(400, "Expected a JSON body.");
	}

	const kind = body.kind === "description" ? "description" : "title";
	const path = typeof body.path === "string" && body.path.startsWith("/") ? normalisePath(body.path) : null;
	if (!path) return jsonError(400, "Which page?");

	// Pristine, like edit mode: the page's own wording, before any override.
	const pageResponse = await fetchAsset(new Request(new URL(path, url), { method: "GET" }), new URL(path, url), env);
	if (pageResponse.status !== 200) return jsonError(404, "That page could not be read.");

	const [summary, content] = await Promise.all([
		extractPageSummary(pageResponse.clone()),
		extractContent(pageResponse),
	]);

	// A published override is what the page currently says, so it is what a
	// suggestion has to improve on.
	const edits = await loadPageEdits(env, path).catch(() => null);
	if (edits) {
		const title = edits.get("m:title");
		const description = edits.get("m:description");
		if (title !== undefined) summary.title = title;
		if (description !== undefined) summary.description = description;
	}

	// Real searches when they are available, and nothing when they are not.
	// The suggestion is worth less without them, which is worth saying, but
	// it is not worth refusing to make.
	let queries = [];
	let gaps = [];
	if (isSearchConsoleConfigured(env)) {
		try {
			const insight = await searchInsights(env, { hostname: url.hostname, path, withRankings: true });
			queries = insight.queries;
			// The one instruction here with evidence behind it rather than
			// judgement: Google already offers this page for these phrases
			// and the page does not use the words.
			//
			// Filtered to the gaps this page should act on. A phrase another
			// page answers better belongs to that page, and writing it into
			// this title would set the two of them competing -- which is the
			// problem the duplicate-title check exists to catch.
			gaps = findGaps(
				queries,
				{ title: summary.title, description: summary.description, h1: content.h1 },
				{ path, rankings: insight.rankings }
			).filter((gap) => gap.verdict === "add");
		} catch {
			// Search Console being unreachable is not a reason to refuse to
			// draft anything -- it just means drafting from the page alone.
		}
	}

	// Writing samples from elsewhere on the site. Describing the house style
	// in words produced copy that could have belonged to any pest controller
	// anywhere; four real examples of it are worth more than any adjective.
	let examples = [];
	try {
		const sitemapResponse = await env.ASSETS.fetch(new Request(new URL("/sitemap.xml", url), { method: "GET" }));
		if (sitemapResponse.status === 200) {
			const paths = pathsFromSitemap(await sitemapResponse.text());
			examples = (
				await Promise.all(
					examplePaths(paths, path).map(async (samplePath) => {
						const sampleUrl = new URL(samplePath, url);
						const response = await fetchAsset(new Request(sampleUrl, { method: "GET" }), sampleUrl, env);
						return response.status === 200 ? extractMeta(response) : null;
					})
				)
			).filter(Boolean);
		}
	} catch {
		// Style samples make the suggestions better; they are not required to
		// produce one, and failing to read them is not worth failing over.
	}

	try {
		const { candidates, rejected } = await suggest(env, {
			kind,
			page: { title: summary.title, description: summary.description, h1: content.h1, body: content.body },
			queries,
			examples,
			gaps,
			steer: typeof body.steer === "string" ? body.steer : "",
			min: kind === "title" ? TITLE_MIN : DESCRIPTION_MIN,
			max: kind === "title" ? TITLE_MAX : DESCRIPTION_MAX,
		});
		return new Response(JSON.stringify({ kind, candidates, rejected, usedSearches: queries.length, usedExamples: examples.length, usedGaps: gaps.length }), {
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	} catch (error) {
		return jsonError(502, `Could not draft a suggestion (${error.message}).`);
	}
}

// Search Console figures for the whole site, or for one page with ?path=.
//
// A 409 rather than a 500 when it is not connected: nothing has gone wrong,
// there is simply a setup step outstanding, and the panel shows the
// instructions instead of an error.
async function handleSearchConsole(url, env) {
	if (!isSearchConsoleConfigured(env)) {
		return new Response(JSON.stringify({ error: searchConsoleSetupMessage(), steps: searchConsoleSetupSteps(), needsSetup: true }), {
			status: 409,
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	}

	const path = url.searchParams.get("path");
	try {
		const wanted = path && path.startsWith("/") ? normalisePath(path) : null;
		const data = await searchInsights(env, { hostname: url.hostname, path: wanted, withRankings: Boolean(wanted) });

		// For a single page, the gap between what Google shows it for and
		// what it says. Needs the page's own wording, so it is only computed
		// when a page was asked about.
		if (wanted) {
			const pageUrl = new URL(wanted, url);
			const response = await fetchAsset(new Request(pageUrl, { method: "GET" }), pageUrl, env);
			if (response.status === 200) {
				const [summary, content] = await Promise.all([
					extractPageSummary(response.clone()),
					extractContent(response),
				]);
				const edits = await loadPageEdits(env, wanted).catch(() => null);
				if (edits) {
					const title = edits.get("m:title");
					const description = edits.get("m:description");
					if (title !== undefined) summary.title = title;
					if (description !== undefined) summary.description = description;
				}
				data.gaps = findGaps(
					data.queries,
					{ title: summary.title, description: summary.description, h1: content.h1 },
					{ path: wanted, rankings: data.rankings }
				).map((gap) => ({ ...gap, sentence: describeGap(gap), fix: fixForGap(gap) }));
			}
		}

		delete data.rankings;
		return new Response(JSON.stringify(data), {
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	} catch (error) {
		// The messages thrown in src/search-console.js already say what to go
		// and change, so they are passed through rather than flattened into
		// "something went wrong".
		return new Response(JSON.stringify({ error: error.message }), {
			status: 502,
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	}
}

// Checks whether a list of internal link destinations actually load.
//
// This cannot be folded into the page scan, because a destination is only
// worth fetching once it is clear nothing else has already confirmed it: of
// the 142 internal destinations on this site, 134 are pages the scan reads
// anyway, and only the remaining eight -- mostly PDFs -- need a request each.
// So the browser finishes the scan, subtracts what it has seen, and posts the
// remainder here.
//
// Redirects count as working. `_redirects` deliberately keeps old URLs alive,
// and reporting those as broken would flag the very thing that stops them
// being broken.
async function handleSeoLinks(request, url, env) {
	let targets = [];
	try {
		const body = await request.json();
		targets = Array.isArray(body.targets) ? body.targets : [];
	} catch {
		return new Response(JSON.stringify({ error: "Expected a JSON body with a list of targets." }), {
			status: 400,
			headers: { "content-type": "application/json", "Cache-Control": "no-store" },
		});
	}

	// Bounded per request for the same reason the page scan is: whatever the
	// browser asks for has to fit in one invocation.
	const wanted = [...new Set(targets.filter((target) => typeof target === "string" && target.startsWith("/")))].slice(0, 40);

	const broken = [];
	for (const target of wanted) {
		try {
			// A fresh GET rather than the incoming POST. Its body has already
			// been read, and a link is followed with a GET or it is not being
			// followed the way a visitor would follow it.
			const targetUrl = new URL(target, url);
			const response = await fetchAsset(new Request(targetUrl, { method: "GET" }), targetUrl, env);
			if (response.status >= 400) broken.push(target);
			// Nothing here reads the body, and an unread one holds the
			// connection open for the rest of the invocation.
			if (response.body) await response.body.cancel().catch(() => {});
		} catch {
			broken.push(target);
		}
	}

	return new Response(JSON.stringify({ checked: wanted.length, broken }), {
		headers: { "content-type": "application/json", "Cache-Control": "no-store" },
	});
}
