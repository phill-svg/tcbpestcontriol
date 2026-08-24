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
import {
	runModel,
	preferredModel,
	MODEL_CHOICES,
	modelLabel,
	describeRun,
	NotConfigured,
} from "../src/seo-suggest.js";

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

test("Claude is what suggestions use, with a hand-set escape hatch", () => {
	assert.equal(preferredModel({}), CLAUDE_MODEL);
	assert.equal(preferredModel({ ANTHROPIC_API_KEY: "test" }), CLAUDE_MODEL);
	// SEO_AI_MODEL is the way to point this elsewhere without a deploy, for
	// the case where Claude is unavailable for longer than it is worth
	// waiting out. Nothing in the panel offers it.
	assert.equal(preferredModel({ SEO_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }), "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
});

test("a failed call is a failure, not a quiet downgrade", () => {
	// This used to fall back to Llama on the reasoning that a working button
	// beats an error box. That held while the free models were there anyway.
	// Now that they have been deliberately removed, answering from one would
	// be worse than saying what went wrong -- it would hand over copy from a
	// model somebody chose to delete, under Claude's name.
	const env = {
		ANTHROPIC_API_KEY: "test",
		AI: {
			run: async () => {
				throw new Error("nothing should reach Workers AI");
			},
		},
	};
	// The Claude call cannot succeed from here, so this is the failure path.
	return assert.rejects(() => runModel(env, CLAUDE_MODEL, BODY), (error) => {
		assert.ok(!(error instanceof NotConfigured), "a key is present; this is a runtime failure, not a setup step");
		assert.doesNotMatch(String(error.message), /nothing should reach Workers AI/, "it must not have tried the free model");
		return true;
	});
});

test("the panel is told when the answer came from a different model", () => {
	// The ordinary case: Claude was asked and Claude answered, so there is
	// nothing to explain and nothing is said.
	assert.deepEqual(describeRun(CLAUDE_MODEL, { model: CLAUDE_MODEL }), {
		model: CLAUDE_MODEL,
		label: "Claude Opus 5",
		asked: null,
		fellBack: null,
	});

	// Only reachable by setting SEO_AI_MODEL by hand, but that is exactly when
	// it matters: an answer from something other than Claude has to be
	// visibly from something other than Claude.
	const other = describeRun(CLAUDE_MODEL, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
	assert.equal(other.label, "llama-3.3-70b-instruct-fp8-fast");
	assert.equal(other.asked, "Claude Opus 5");
});

test("whatever answered has a name a person would recognise", () => {
	assert.equal(modelLabel(CLAUDE_MODEL), "Claude Opus 5");
	assert.equal(MODEL_CHOICES.length, 1, "one model, so nothing to choose between");
	// Set by hand: still named rather than blank, because "written by" with
	// nothing after it is worse than the raw id.
	assert.equal(modelLabel("@cf/some/experimental-model"), "experimental-model");
	assert.ok(modelLabel(undefined));
});

test("the setup message says it costs money, before anything is spent", () => {
	// This is the only setting on the site that starts a bill. It should not
	// be possible to switch on without having been told that plainly.
	assert.ok(!isConfigured({}));
	assert.match(setupMessage(), /costs money/i);
	assert.match(setupMessage(), /ANTHROPIC_API_KEY/);
});
