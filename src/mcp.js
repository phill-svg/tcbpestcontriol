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

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "tcb-pest-control", version: "1.0.0" };

// Generated from the site's locations-pest-control-* pages -- keep in sync
// if suburb pages are added or renamed.
const SUBURBS = [{"slug":"acton","name":"Acton","url":"/locations-pest-control-acton"},{"slug":"ainslie","name":"Ainslie","url":"/locations-pest-control-ainslie"},{"slug":"amaroo","name":"Amaroo","url":"/locations-pest-control-amaroo"},{"slug":"aranda","name":"Aranda","url":"/locations-pest-control-aranda"},{"slug":"banks","name":"Banks","url":"/locations-pest-control-banks"},{"slug":"barton","name":"Barton","url":"/locations-pest-control-barton"},{"slug":"belconnen","name":"Belconnen","url":"/locations-pest-control-belconnen"},{"slug":"bonner","name":"Bonner","url":"/locations-pest-control-bonner"},{"slug":"bonython","name":"Bonython","url":"/locations-pest-control-bonython"},{"slug":"braddon","name":"Braddon","url":"/locations-pest-control-braddon"},{"slug":"campbell","name":"Campbell","url":"/locations-pest-control-campbell"},{"slug":"canberra-city","name":"Canberra City","url":"/locations-pest-control-canberra-city"},{"slug":"casey","name":"Casey","url":"/locations-pest-control-casey"},{"slug":"chapman","name":"Chapman","url":"/locations-pest-control-chapman"},{"slug":"civic","name":"Civic","url":"/locations-pest-control-civic"},{"slug":"conder","name":"Conder","url":"/locations-pest-control-conder"},{"slug":"cook","name":"Cook","url":"/locations-pest-control-cook"},{"slug":"crace","name":"Crace","url":"/locations-pest-control-crace"},{"slug":"crestwood","name":"Crestwood","url":"/locations-pest-control-crestwood"},{"slug":"curtin","name":"Curtin","url":"/locations-pest-control-curtin"},{"slug":"deakin","name":"Deakin","url":"/locations-pest-control-deakin"},{"slug":"dickson","name":"Dickson","url":"/locations-pest-control-dickson"},{"slug":"downer","name":"Downer","url":"/locations-pest-control-downer"},{"slug":"duffy","name":"Duffy","url":"/locations-pest-control-duffy"},{"slug":"evatt","name":"Evatt","url":"/locations-pest-control-evatt"},{"slug":"farrer","name":"Farrer","url":"/locations-pest-control-farrer"},{"slug":"fisher","name":"Fisher","url":"/locations-pest-control-fisher"},{"slug":"florey","name":"Florey","url":"/locations-pest-control-florey"},{"slug":"franklin","name":"Franklin","url":"/locations-pest-control-franklin"},{"slug":"fyshwick","name":"Fyshwick","url":"/locations-pest-control-fyshwick"},{"slug":"garran","name":"Garran","url":"/locations-pest-control-garran"},{"slug":"googong","name":"Googong","url":"/locations-pest-control-googong"},{"slug":"gordon","name":"Gordon","url":"/locations-pest-control-gordon"},{"slug":"greenway","name":"Greenway","url":"/locations-pest-control-greenway"},{"slug":"griffith","name":"Griffith","url":"/locations-pest-control-griffith"},{"slug":"gungahlin","name":"Gungahlin","url":"/locations-pest-control-gungahlin"},{"slug":"hackett","name":"Hackett","url":"/locations-pest-control-hackett"},{"slug":"harrison","name":"Harrison","url":"/locations-pest-control-harrison"},{"slug":"hawker","name":"Hawker","url":"/locations-pest-control-hawker"},{"slug":"holder","name":"Holder","url":"/locations-pest-control-holder"},{"slug":"hughes","name":"Hughes","url":"/locations-pest-control-hughes"},{"slug":"inner-north-canberra","name":"Inner North","url":"/locations-pest-control-inner-north-canberra"},{"slug":"inner-south","name":"Inner South","url":"/locations-pest-control-inner-south"},{"slug":"isaacs","name":"Isaacs","url":"/locations-pest-control-isaacs"},{"slug":"isabella-plains","name":"Isabella Plains","url":"/locations-pest-control-isabella-plains"},{"slug":"jerrabomberra","name":"Jerrabomberra","url":"/locations-pest-control-jerrabomberra"},{"slug":"kaleen","name":"Kaleen","url":"/locations-pest-control-kaleen"},{"slug":"kambah","name":"Kambah","url":"/locations-pest-control-kambah"},{"slug":"karabar","name":"Karabar","url":"/locations-pest-control-karabar"},{"slug":"kingston","name":"Kingston","url":"/locations-pest-control-kingston"},{"slug":"latham","name":"Latham","url":"/locations-pest-control-latham"},{"slug":"letchworth","name":"Letchworth","url":"/locations-pest-control-letchworth"},{"slug":"lyneham","name":"Lyneham","url":"/locations-pest-control-lyneham"},{"slug":"macquarie","name":"Macquarie","url":"/locations-pest-control-macquarie"},{"slug":"manuka","name":"Manuka","url":"/locations-pest-control-manuka"},{"slug":"mawson","name":"Mawson","url":"/locations-pest-control-mawson"},{"slug":"mitchell","name":"Mitchell","url":"/locations-pest-control-mitchell"},{"slug":"molonglo-valley","name":"Molonglo Valley","url":"/locations-pest-control-molonglo-valley"},{"slug":"monash","name":"Monash","url":"/locations-pest-control-monash"},{"slug":"narrabundah","name":"Narrabundah","url":"/locations-pest-control-narrabundah"},{"slug":"ngunnawal","name":"Ngunnawal","url":"/locations-pest-control-ngunnawal"},{"slug":"oconnor","name":"O'Connor","url":"/locations-pest-control-oconnor"},{"slug":"omalley","name":"O'Malley","url":"/locations-pest-control-omalley"},{"slug":"oxley","name":"Oxley","url":"/locations-pest-control-oxley"},{"slug":"page","name":"Page","url":"/locations-pest-control-page"},{"slug":"palmerston","name":"Palmerston","url":"/locations-pest-control-palmerston"},{"slug":"parkes","name":"Parkes","url":"/locations-pest-control-parkes"},{"slug":"pearce","name":"Pearce","url":"/locations-pest-control-pearce"},{"slug":"phillip","name":"Phillip","url":"/locations-pest-control-phillip"},{"slug":"queanbeyan-west","name":"Queanbeyan West","url":"/locations-pest-control-queanbeyan-west"},{"slug":"queanbeyan","name":"Queanbeyan","url":"/locations-pest-control-queanbeyan"},{"slug":"reid","name":"Reid","url":"/locations-pest-control-reid"},{"slug":"scullin","name":"Scullin","url":"/locations-pest-control-scullin"},{"slug":"stirling","name":"Stirling","url":"/locations-pest-control-stirling"},{"slug":"symonston","name":"Symonston","url":"/locations-pest-control-symonston"},{"slug":"the-angle","name":"The Angle","url":"/locations-pest-control-the-angle"},{"slug":"tuggeranong","name":"Tuggeranong","url":"/locations-pest-control-tuggeranong"},{"slug":"turner","name":"Turner","url":"/locations-pest-control-turner"},{"slug":"wamboin","name":"Wamboin","url":"/locations-pest-control-wamboin"},{"slug":"wanniassa","name":"Wanniassa","url":"/locations-pest-control-wanniassa"},{"slug":"waramanga","name":"Waramanga","url":"/locations-pest-control-waramanga"},{"slug":"watson","name":"Watson","url":"/locations-pest-control-watson"},{"slug":"weston-creek","name":"Weston Creek","url":"/locations-pest-control-weston-creek"},{"slug":"woden","name":"Woden Valley","url":"/locations-pest-control-woden"}];

// Mirrors the Services section of /llms.txt.
const SERVICES = [
	{ name: "Residential Pest Control", url: "/residential", description: "General home pest control plans and one-off treatments." },
	{ name: "Commercial Pest Control", url: "/commercial", description: "Pest management for businesses, retail, hospitality and strata." },
	{ name: "Pests We Treat", url: "/pests-we-treat", description: "Overview of every pest type serviced." },
	{ name: "Termite Treatment & Inspection", url: "/termite-treatment", description: "Termite inspections, barriers and treatment." },
	{ name: "Pre-Purchase Inspections", url: "/pre-purchase-inspection", description: "AS 4349.3 timber pest inspections for property purchases." },
	{ name: "Rodent Control", url: "/rodent-control", description: "Rat and mouse baiting and proofing." },
	{ name: "Ant Control", url: "/pest-control-for-ants", description: "Ant treatment for homes and businesses." },
	{ name: "Spider Control", url: "/spider-control", description: "Spider treatment including redbacks and funnel-webs." },
	{ name: "Bee Control", url: "/bees", description: "Bee removal and hive relocation; wasp nest removal." },
	{ name: "Cockroach Control", url: "/cockroach-control", description: "German and American cockroach treatment." },
	{ name: "Flea Control", url: "/flea-control", description: "Flea treatment for homes and pets' environments." },
	{ name: "Silverfish Control", url: "/silverfish-control", description: "Silverfish treatment." },
	{ name: "Bird Control", url: "/bird-control", description: "Bird proofing and deterrents." },
	{ name: "Possum Control", url: "/possum-control", description: "Possum removal and exclusion." },
	{ name: "Stored Product Pest Control", url: "/stored-product-pest-control", description: "Pantry and stored-product pest treatment." },
	{ name: "General Pest Control", url: "/general-pest-control", description: "One-visit, inside-and-out seasonal treatment." },
	{ name: "Bed Bug Treatment", url: "/bed-bug-treatment-canberra", description: "Bed bug identification and treatment." },
	{ name: "Carpenter Ants", url: "/carpenter-ants", description: "Carpenter ant identification and treatment." },
	{ name: "Earwig Control", url: "/earwig-control", description: "Earwig treatment." },
	{ name: "Ladybug Control", url: "/ladybug-control", description: "Ladybug/ladybird treatment." },
	{ name: "Millipede Control", url: "/millipede-control", description: "Millipede treatment." },
	{ name: "Mosquito Control", url: "/mosquito-control", description: "Mosquito treatment." },
	{ name: "Mud Wasp Control", url: "/mud-wasp-control", description: "Mud wasp treatment." },
	{ name: "Slater Control", url: "/slater-control", description: "Slater (woodlouse) treatment." },
];

// Only these three services have a published *starting* price (see
// /pricing). Everything else is quoted for free after a look at the job --
// this tool must never invent a number for those.
const PRICING = [
	{ service: "General Pest Control", url: "/general-pest-control", startingPrice: 249 },
	{ service: "Termite Inspection", url: "/termite-treatment", startingPrice: 289 },
	{ service: "Rodent Control", url: "/rodent-control", startingPrice: 249 },
];

const SITE = "https://www.tcbpestcontrolcanberra.com.au";

const TOOLS = [
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
