// A minimal Model Context Protocol (MCP) server exposed at /mcp, using the
// Streamable HTTP transport (https://modelcontextprotocol.io) in its
// simplest, stateless form: every tool here is a pure, read-only lookup
// against data already published elsewhere on the site, so there's no
// session state to track and no reason to open an SSE stream -- each POST
// gets a single JSON-RPC response back directly.
//
// Lets an AI agent ask "does TCB cover suburb X?" or "what does a general
// pest visit cost?" and get a direct answer instead of having to guess from
// crawled page text. Three of the four tools are static, read-only lookups
// against data already published elsewhere on the site.
//
// The fourth, submit_booking_enquiry, is different: it's a write action that
// creates a real customer + Quote job in ServiceM8 and sends real emails,
// via the same shared pipeline the /book form itself uses (src/booking.js).
// There's no live-availability/calendar system to query here -- ServiceM8
// doesn't expose one cleanly, and the site itself doesn't offer self-service
// slot picking even to a human visitor. This tool mirrors the actual
// process instead: submit an enquiry, staff follow up to confirm timing.

import { validateBookingFields, createBookingAndNotify } from "./booking.js";
import { SITE, SUBURBS, SERVICES, PRICING } from "./content-index.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "tcb-pest-control", version: "1.0.0" };

// Exported so scripts/build-ai-catalog.js can generate the published MCP server
// card from the same definitions the live server serves, rather than restating them.
export const TOOLS = [
	{
		name: "check_suburb_coverage",
		description:
			"Check whether TCB Pest Control services a given Canberra/ACT or Queanbeyan-region (NSW) suburb, and return the URL of that suburb's page if so.",
		inputSchema: {
			type: "object",
			properties: { suburb: { type: "string", description: "Suburb or area name, e.g. 'Kambah' or 'Queanbeyan'." } },
			required: ["suburb"],
		},
	},
	{
		name: "list_services",
		description: "List every pest control service TCB Pest Control offers, with a short description and page URL for each.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_service_pricing",
		description:
			"Get TCB Pest Control's published starting prices. Only General Pest Control, Termite Inspection and Rodent Control have a published starting price -- every other service is quoted for free after a look at the property, and this tool will say so rather than guess a number.",
		inputSchema: {
			type: "object",
			properties: { service: { type: "string", description: "Optional service name to filter to, e.g. 'termite inspection'. Omit to get all published starting prices." } },
		},
	},
	{
		name: "submit_booking_enquiry",
		description:
			"Submit a real pest control booking enquiry to TCB Pest Control -- creates an actual customer and Quote job in TCB's live system, exactly like the /book form on the website. TCB staff follow up by phone or email to confirm timing and provide a written quote before any work begins; this does not book a specific time slot. Only call this when the person has clearly asked to book or request a quote, using their real contact details -- never invent contact details.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Full name" },
				email: { type: "string", description: "Email address" },
				phone: { type: "string", description: "Phone number" },
				address: { type: "string", description: "Service address" },
				service: { type: "string", description: "Which service is needed, e.g. 'General Pest Control' or 'Termite Inspection'" },
				date: { type: "string", description: "Optional preferred date" },
				time: { type: "string", description: "Optional preferred time" },
				message: { type: "string", description: "Optional additional notes" },
			},
			required: ["name", "email", "phone", "address", "service"],
		},
	},
];

function normalize(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

function textResult(text, isError) {
	const result = { content: [{ type: "text", text }] };
	if (isError) result.isError = true;
	return result;
}

function toolCheckSuburbCoverage(args) {
	const raw = String(args?.suburb || "").trim();
	const q = normalize(raw);
	if (!q) return textResult("Please provide a suburb name.", true);

	let match = SUBURBS.find((s) => normalize(s.name) === q || normalize(s.slug) === q);
	if (!match && q.length >= 3) {
		match = SUBURBS.find((s) => normalize(s.name).includes(q));
	}

	if (match) {
		return textResult(`Yes, TCB Pest Control services ${match.name}. Details: ${SITE}${match.url}`);
	}
	return textResult(
		`"${raw}" wasn't found among TCB's ${SUBURBS.length} named suburb pages. TCB Pest Control covers all of Canberra/the ACT plus Queanbeyan-region NSW border suburbs, so this area may still be covered under a neighbouring suburb -- see ${SITE}/locations or call 02 6105 9771 to confirm.`
	);
}

function toolListServices() {
	const lines = SERVICES.map((s) => `- ${s.name}: ${s.description} (${SITE}${s.url})`);
	return textResult(lines.join("\n"));
}

function toolGetServicePricing(args) {
	const q = args?.service ? normalize(args.service) : null;
	let rows = PRICING;
	if (q) {
		rows = PRICING.filter((p) => normalize(p.service).includes(q) || q.includes(normalize(p.service)));
		if (rows.length === 0) {
			return textResult(
				`TCB Pest Control doesn't publish a starting price for "${args.service}". Only General Pest Control (from $249), Termite Inspection (from $289) and Rodent Control (from $249) have a published starting price -- every other service is quoted for free after a look at the property. See ${SITE}/pricing or get a free quote at ${SITE}/book.`
			);
		}
	}
	const lines = rows.map((p) => `- ${p.service}: from $${p.startingPrice} AUD (${SITE}${p.url})`);
	return textResult(
		lines.join("\n") +
			"\n\nThese are starting prices only -- the final price depends on property size, pest pressure and access, and is confirmed in a free written quote before any work begins."
	);
}

async function toolSubmitBookingEnquiry(args, env, ctx) {
	const f = {
		name: String(args?.name || "").trim(),
		email: String(args?.email || "").trim(),
		phone: String(args?.phone || "").trim(),
		address: String(args?.address || "").trim(),
		service: String(args?.service || "").trim(),
		date: String(args?.date || "").trim(),
		time: String(args?.time || "").trim(),
		message: String(args?.message || "").trim(),
	};

	const errors = validateBookingFields(f);
	if (errors.length) return textResult(errors.join(" "), true);

	if (!env || !env.SERVICEM8_API_KEY) {
		return textResult(`Booking submission isn't available right now. Please call 02 6105 9771 or submit the form directly at ${SITE}/book.`, true);
	}

	try {
		await createBookingAndNotify(env, ctx, f, "Booking enquiry submitted via MCP (AI agent)");
	} catch (e) {
		return textResult(`Something went wrong submitting that enquiry. Please call 02 6105 9771 or use ${SITE}/book directly.`, true);
	}

	return textResult(
		`Thanks${f.name ? ", " + f.name : ""} -- your enquiry for ${f.service} has been received. TCB Pest Control will contact you (${f.email || f.phone}) to confirm timing and provide a written quote before any work begins.`
	);
}

async function callTool(name, args, env, ctx) {
	if (name === "check_suburb_coverage") return toolCheckSuburbCoverage(args);
	if (name === "list_services") return toolListServices();
	if (name === "get_service_pricing") return toolGetServicePricing(args);
	if (name === "submit_booking_enquiry") return toolSubmitBookingEnquiry(args, env, ctx);
	return null;
}

function rpcResult(id, result) {
	return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
};

// Handles one JSON-RPC message (never a batch entry that's already been
// unwrapped) and returns either a response object or null for notifications
// (which get no response at all).
async function handleMessage(msg, env, ctx) {
	if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
		return rpcError(msg && typeof msg === "object" ? msg.id ?? null : null, -32600, "Invalid Request");
	}
	const isNotification = !("id" in msg);
	const { id, method, params } = msg;

	if (method === "initialize") {
		const result = { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
		return isNotification ? null : rpcResult(id, result);
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return null;
	}
	if (method === "ping") {
		return isNotification ? null : rpcResult(id, {});
	}
	if (method === "tools/list") {
		return isNotification ? null : rpcResult(id, { tools: TOOLS });
	}
	if (method === "tools/call") {
		const toolName = params && params.name;
		const args = (params && params.arguments) || {};
		const result = await callTool(toolName, args, env, ctx);
		if (isNotification) return null;
		return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${toolName}`);
	}
	return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleMcp(request, env, ctx) {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed. This MCP endpoint only supports POST (stateless Streamable HTTP).", {
			status: 405,
			headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
		});
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")), {
			status: 400,
			headers: { "content-type": "application/json", ...CORS_HEADERS },
		});
	}

	const isBatch = Array.isArray(body);
	const messages = isBatch ? body : [body];
	const responses = (await Promise.all(messages.map((m) => handleMessage(m, env, ctx)))).filter((r) => r !== null);

	if (responses.length === 0) {
		// Every message was a notification -- per the MCP/JSON-RPC spec, no body.
		return new Response(null, { status: 202, headers: CORS_HEADERS });
	}

	const payload = isBatch ? responses : responses[0];
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json", ...CORS_HEADERS },
	});
}
