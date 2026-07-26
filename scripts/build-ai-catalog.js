// Regenerates the Agentic Resource Discovery (ARD) files under .well-known/:
//
//   .well-known/ai-catalog.json       the AI Catalog manifest agents look for
//   .well-known/mcp-server-card.json  the MCP server card that manifest points at
//
// Run this after adding, removing or renaming an MCP tool:
//
//   node scripts/build-ai-catalog.js
//
// Both files are derived from src/content-index.js and the TOOLS array in
// src/mcp.js, so the published catalog cannot drift from what /mcp actually
// serves. Like scripts/build-search-index.js this stays a manual,
// rerun-when-needed script rather than something wired into a deploy pipeline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE, SITE_INFO, MCP_INFO } from "../src/content-index.js";
import { TOOLS } from "../src/mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WELL_KNOWN = path.join(__dirname, "..", ".well-known");

// ARD spec version implemented by these files.
const SPEC_VERSION = "1.0";

// Bare host, no scheme or trailing slash -- used for both the did:web identifier
// and the URN namespace. did:web:<host> resolves to https://<host>/.well-known/did.json.
const HOST = new URL(SITE).host;

// Mirrors src/mcp.js: SERVER_INFO and PROTOCOL_VERSION are module-private there,
// so they are restated here. Tool definitions are imported, not restated.
const SERVER_NAME = "tcb-pest-control";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

const CARD_PATH = "/.well-known/mcp-server-card.json";

const serverCard = {
	name: SERVER_NAME,
	version: SERVER_VERSION,
	description: `Model Context Protocol server for ${SITE_INFO.name}. ${SITE_INFO.description}`,
	endpoint: MCP_INFO.endpoint,
	transport: "streamable-http",
	protocolVersion: PROTOCOL_VERSION,
	capabilities: { tools: {} },
	tools: TOOLS,
};

const catalog = {
	specVersion: SPEC_VERSION,
	host: {
		displayName: SITE_INFO.name,
		identifier: `did:web:${HOST}`,
	},
	entries: [
		{
			identifier: `urn:air:${HOST}:mcp:${SERVER_NAME}`,
			displayName: `${SITE_INFO.name} MCP server`,
			type: "application/mcp-server-card+json",
			url: `${SITE}${CARD_PATH}`,
			description:
				"Check whether a Canberra/ACT or Queanbeyan-region suburb is serviced, list pest control services, get published starting prices, and submit a booking enquiry.",
			capabilities: TOOLS.map((tool) => tool.name),
		},
	],
};

// The did:web identifier above has to resolve to something, so publish a minimal
// DID Core document. `id` is the only required property; a service entry points
// back at the site. No key material is claimed.
const didDocument = {
	"@context": ["https://www.w3.org/ns/did/v1"],
	id: `did:web:${HOST}`,
	service: [
		{
			id: `did:web:${HOST}#website`,
			type: "LinkedDomains",
			serviceEndpoint: `${SITE}/`,
		},
		{
			id: `did:web:${HOST}#ai-catalog`,
			type: "AICatalog",
			serviceEndpoint: `${SITE}/.well-known/ai-catalog.json`,
		},
	],
};

function write(name, value) {
	const target = path.join(WELL_KNOWN, name);
	fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
	console.log(`Wrote .well-known/${name}`);
}

write("ai-catalog.json", catalog);
write("mcp-server-card.json", serverCard);
write("did.json", didDocument);

console.log(`Catalog lists ${catalog.entries.length} entry with ${TOOLS.length} MCP tools.`);
