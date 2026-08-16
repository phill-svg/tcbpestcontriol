// Drafting through the Claude API rather than Workers AI.
//
// Three things here are worth pinning, and they are the three that would fail
// silently rather than loudly.
//
// The first is `temperature`. The shared request body carries it because
// Workers AI wants it, and this API rejects the whole request if it arrives.
// That failure is loud in production and invisible in a test that only checks
// what came back, so the test below reads what was *sent*.
//
// The second is refusals. A declined request carries no text. Read as an empty
// answer it surfaces as "no suggestions came back", which sends whoever sees
// it looking at the prompt, the validation rules and the page content -- none
// of which are the problem.
//
// The third is the missing key. Falling back to a free model when Claude is
// merely unavailable is right; doing it when Claude was never switched on
// would mean the setting appears to work while doing nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	toRequest,
	textFrom,
	estimateCost,
	runClaude,
	isClaudeModel,
	isConfigured,
	setupMessage,
	CLAUDE_MODEL,
} from "../src/claude-suggest.js";
import { runModel, preferredModel, modelChoices, NotConfigured, DEFAULT_MODEL } from "../src/seo-suggest.js";

// The body seo-suggest.js builds, verbatim -- including the temperature that
// must not survive the trip.
const BODY = {
	messages: [
		{ role: "system", content: "You write page titles." },
		{ role: "user", content: "Write a title for this page." },
	],
	max_tokens: 700,
	temperature: 0.8,
};

// Records what it was asked to send, which is the only way to test a
// request-shaping bug that the response would never reveal.
function recorder(reply = {}) {
	const calls = [];
	return {
		calls,
		beta: {
			messages: {
				create: async (params) => {
					calls.push(params);
					return {
						stop_reason: "end_turn",
						model: CLAUDE_MODEL,
						content: [{ type: "text", text: "A title\nAnother title" }],
						usage: { input_tokens: 1000, output_tokens: 200 },
						...reply,
					};
				},
			},
		},
	};
}

test("the system prompt moves out of the message list", () => {
	// Workers AI takes it as messages[0]; this API takes it as its own
	// parameter, and left in the list it would be rejected as an unknown role.
	const request = toRequest(BODY);
	assert.equal(request.system, "You write page titles.");
	assert.deepEqual(request.messages, [{ role: "user", content: "Write a title for this page." }]);
});

test("temperature never reaches the request", async () => {
	// The one that 400s the whole call. It is in the shared body because
	// Workers AI wants it, so it has to be dropped here rather than at the
	// call site -- and this asserts on what was sent, not what came back.
	const client = recorder();
	await runClaude({ ANTHROPIC_API_KEY: "test" }, BODY, { client });

	const sent = client.calls[0];
	assert.ok(!("temperature" in sent), "temperature would be rejected outright");
	assert.ok(!("top_p" in sent));
	assert.ok(!("top_k" in sent));
});

test("max_tokens leaves room for thinking, rather than passing 700 through", async () => {
	// max_tokens caps thinking and reply together. Handing this model the
	// figure Workers AI is given would spend the budget before the first line
	// of the answer and come back empty.
	const client = recorder();
	await runClaude({ ANTHROPIC_API_KEY: "test" }, BODY, { client });
	assert.ok(client.calls[0].max_tokens > 700);
});

test("a refusal is raised, not read as an empty answer", async () => {
	const client = recorder({
		stop_reason: "refusal",
		stop_details: { category: "other", explanation: "declined" },
		content: [],
	});
	await assert.rejects(
		() => runClaude({ ANTHROPIC_API_KEY: "test" }, BODY, { client }),
		/declined/,
		"an empty content array must not be reported as 'nothing came back'"
	);
});

test("only the text blocks are read back", () => {
	// Thinking blocks arrive alongside the answer, and a naive join would put
	// the model's reasoning into a page title.
	const text = textFrom({
		content: [
			{ type: "thinking", thinking: "Let me consider the character budget." },
			{ type: "text", text: "Termite Treatment Canberra | TCB" },
		],
	});
	assert.equal(text, "Termite Treatment Canberra | TCB");
});

test("cost is counted in dollars, cached input included", () => {
	// A million in and a million out is $5 + $25.
	assert.equal(estimateCost({ input_tokens: 1000000, output_tokens: 1000000 }), 30);
	// Cached reads are cheaper in reality; counting them at full rate makes
	// the figure shown an over-estimate rather than an under-estimate, which
	// is the direction a price quoted to somebody should err.
	assert.ok(estimateCost({ cache_read_input_tokens: 1000000, output_tokens: 0 }) > 0);
	assert.equal(estimateCost({}), 0);
});

test("a missing key is a setup step, not a silent fall back to the free model", async () => {
	// The distinction the whole thing turns on. A rate limit should degrade to
	// a free suggestion; a key that was never added should say so, or the
	// setting looks like it works while doing nothing at all.
	const env = { AI: { run: async () => ({ response: "from llama" }) } };
	await assert.rejects(() => runModel(env, CLAUDE_MODEL, BODY), NotConfigured);
	await assert.rejects(() => runModel(env, CLAUDE_MODEL, BODY), /console\.anthropic\.com/);
});

test("a model id alone says which provider answers", () => {
	assert.ok(isClaudeModel("claude-opus-5"));
	assert.ok(!isClaudeModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
	assert.ok(!isClaudeModel(undefined));
});

test("adding the key is what switches suggestions over", () => {
	assert.equal(preferredModel({}), DEFAULT_MODEL);
	assert.equal(preferredModel({ ANTHROPIC_API_KEY: "test" }), CLAUDE_MODEL);
	// And the way back without deleting it.
	assert.equal(preferredModel({ ANTHROPIC_API_KEY: "test", SEO_AI_MODEL: DEFAULT_MODEL }), DEFAULT_MODEL);
});

test("the paid model is not offered for comparison until it can answer", () => {
	// Otherwise every comparison comes back with one dead column and an error
	// nobody would connect to a key that was never added.
	assert.ok(!modelChoices({}).some((choice) => choice.id === CLAUDE_MODEL));
	assert.ok(modelChoices({ ANTHROPIC_API_KEY: "test" }).some((choice) => choice.id === CLAUDE_MODEL));
	// The free shortlist is unchanged either way.
	assert.equal(modelChoices({}).length, 4);
});

test("the setup message says it costs money, before anything is spent", () => {
	// This is the only setting on the site that starts a bill. It should not
	// be possible to switch on without having been told that plainly.
	assert.ok(!isConfigured({}));
	assert.match(setupMessage(), /costs money/i);
	assert.match(setupMessage(), /ANTHROPIC_API_KEY/);
});
