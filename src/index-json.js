// A typed JSON index of the site for agents that want a structured manifest
// instead of crawling HTML -- mirrors the /index.json convention some
// agent-visibility templates use. Built entirely from src/content-index.js,
// the same data the MCP tools use, so this can never disagree with them.
import { SITE_INFO, SERVICES, PRICING, SUBURBS, PAGES, MCP_INFO } from "./content-index.js";

export function handleIndexJson() {
	const body = {
		site: SITE_INFO,
		services: SERVICES,
		pricing: PRICING,
		locations: SUBURBS,
		pages: PAGES,
		mcp: MCP_INFO,
	};
	return new Response(JSON.stringify(body, null, 2), {
		status: 200,
		headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
	});
}
