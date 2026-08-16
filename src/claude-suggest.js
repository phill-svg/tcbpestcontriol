// Drafting through the Claude API instead of Workers AI.
//
// Everything else about suggestions stays exactly as it was. The prompt is the
// same prompt, the house-style examples are the same examples, and -- this is
// the part that matters -- the invention checks in src/seo-suggest.js run over
// what comes back from here identically to what comes back from Workers AI. A
// better model is not a reason to trust it about whether this business holds a
// licence, so nothing about that changes.
//
// What changes is only who writes the draft, and that this one costs money per
// click. Both of those are surfaced: the panel says which model answered and
// what the call actually cost, because "a cent or two" is a very different
// thing to be told after the fact than before.

import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-opus-5";

// Anything on this provider rather than Workers AI. The two are told apart by
// the model id alone, so a single `model` string still identifies a run all
// the way from the button through to the reply.
export const isClaudeModel = (model) => String(model || "").startsWith("claude-");

// Per million tokens, for the running cost shown in the panel. Kept here next
// to the model id so the two move together -- a figure quoted from memory in a
// comment somewhere else would be wrong within a year and nobody would notice.
const INPUT_PER_MILLION = 5;
const OUTPUT_PER_MILLION = 25;

// Short, constrained writing: six one-line options inside a character budget.
// Low effort is the right setting for that, and it is also the cheap one --
// thinking bills at the output rate, so effort is the main dial on what a
// click costs. Thinking is left on rather than disabled because disabling it
// on this model is the documented way to get stray tags in the output, and
// stray tags here would land in a page title.
const EFFORT = "low";

// Room for the thinking and the six lines together, which is what max_tokens
// caps. The 700 that Workers AI is asked for would truncate mid-thought here
// and hand back nothing, so the neutral body's figure is deliberately ignored.
const MAX_TOKENS = 4000;

export function missingConfig(env) {
	return env.ANTHROPIC_API_KEY ? [] : ["ANTHROPIC_API_KEY"];
}

export function isConfigured(env) {
	return missingConfig(env).length === 0;
}

// Instructions rather than a bare "not configured", for the same reason the
// Search Console ones are: the person who has to go and do this is not a
// developer, and "ANTHROPIC_API_KEY is unset" tells them nothing they can act
// on. The billing sentence is not padding -- this is the one setting on the
// site that starts costing money, and it should not be possible to switch on
// without having been told so plainly.
export function setupSteps() {
	return [
		"Go to console.anthropic.com and sign in, or create an account.",
		"Under Billing, add a payment method and buy some credit. Ten dollars lasts a long time at a cent or two per click.",
		"Under API keys, click Create key, give it any name, and copy the key it shows you. It is only shown once.",
		"In the Cloudflare dashboard: Workers → tcbpestreal → Settings → Variables and Secrets. Add a Secret named exactly ANTHROPIC_API_KEY and paste the key in as the value.",
	];
}

export function setupMessage() {
	return [
		"Claude isn't connected yet. It takes about five minutes, once, and unlike everything else here it costs money to run — roughly a cent or two each time you ask for suggestions.",
		...setupSteps().map((step, index) => `${index + 1}. ${step}`),
		"Once the key is saved, suggestions come from Claude automatically. Delete the secret to go back to the free models.",
	].join(" ");
}

// Workers AI takes the system prompt as the first entry in `messages`; the
// Messages API takes it as its own parameter. Splitting it here rather than
// building a second prompt keeps buildPrompt() the single description of what
// this thing is asked to write -- otherwise the two would drift, and the one
// that drifted would be the one nobody was reading.
//
// `temperature` is dropped rather than translated. Workers AI wants it; this
// model rejects the request outright if it is sent.
export function toRequest(body = {}) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n");
	return {
		system,
		messages: messages
			.filter((message) => message.role !== "system")
			.map((message) => ({ role: message.role, content: message.content })),
	};
}

// The reply's text, ignoring the thinking blocks that arrive alongside it.
export function textFrom(message) {
	return (message?.content || [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// Dollars, to a sensible number of places. Returned as a number so the panel
// can format it; the panel shows cents, because every figure here is small
// enough that dollars would read as zero.
export function estimateCost(usage = {}) {
	const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
	const output = usage.output_tokens || 0;
	return (input * INPUT_PER_MILLION + output * OUTPUT_PER_MILLION) / 1000000;
}

// `client` is injectable so the request shape can be tested without a key and
// without a network -- which is the only way to pin the two things most likely
// to break silently here: that `temperature` never reaches this API, and that
// a refusal is noticed before anybody reads the content.
export async function runClaude(env, body, { client } = {}) {
	const anthropic = client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
	const { system, messages } = toRequest(body);

	const message = await anthropic.beta.messages.create({
		model: CLAUDE_MODEL,
		max_tokens: MAX_TOKENS,
		output_config: { effort: EFFORT },
		// A declined request is re-run on another model inside the same call
		// rather than coming back empty. Worth having for the same reason the
		// Workers AI fallback is: a button that does nothing is the worst
		// outcome available, and copy about killing pests is exactly the sort
		// of thing a safety classifier looks at twice.
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default",
		system,
		messages,
	});

	// Before the content is read, not after. A refusal carries no text, and
	// treating it as an empty answer would surface as "no suggestions" -- which
	// reads as a bug and sends you looking in the wrong place entirely.
	if (message.stop_reason === "refusal") {
		const detail = message.stop_details?.explanation || "no explanation given";
		throw new Error(`Claude declined to write this one (${detail}).`);
	}

	return {
		result: { response: textFrom(message) },
		usage: message.usage,
		cost: estimateCost(message.usage),
		// The fallback may have answered instead, and if it did, the panel
		// should say so rather than crediting the model that was asked.
		servedBy: message.model,
	};
}
