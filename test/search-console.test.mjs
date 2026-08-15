// Search Console: the parts that can be wrong without anyone noticing.
//
// Most of this module is HTTP calls to Google, which a test can only fake.
// What is worth pinning is everything around them, because each of these has
// a failure mode that looks like an answer rather than an error: a reporting
// window that asks for days Google has no data for yet returns zero rows and
// reads as "nobody found you"; the wrong property returns real numbers for
// the wrong site; and a shortlist with a bad threshold is confidently useless.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pickSite, reportingWindow, opportunities, totals, missingConfig, setupMessage } from "../src/search-console.js";
import { pemToDer, readServiceAccount, signedAssertion } from "../src/google-auth.js";

test("the window stops short of the days Google has no data for", () => {
	// Search Console lags two to three days. Asking to yesterday returns an
	// empty row set, which is indistinguishable from a site nobody visits.
	const window = reportingWindow(new Date("2026-08-15T00:00:00Z"));
	assert.equal(window.endDate, "2026-08-12");
	assert.equal(window.startDate, "2026-07-16");
	assert.equal(window.days, 28);
});

test("the window is 28 whole days, across a month boundary", () => {
	const window = reportingWindow(new Date("2026-03-02T00:00:00Z"));
	const days = (new Date(window.endDate) - new Date(window.startDate)) / 86400000 + 1;
	assert.equal(days, 28, "an off-by-one here silently changes every number in the panel");
});

test("a domain property is preferred over a URL-prefix one", () => {
	// A domain property covers www and bare, http and https. A URL-prefix
	// property covers exactly its prefix -- so picking the prefix when both
	// exist quietly drops whatever traffic arrives at the other form.
	const entries = [
		{ siteUrl: "https://www.tcbpestcontrolcanberra.com.au/" },
		{ siteUrl: "sc-domain:tcbpestcontrolcanberra.com.au" },
	];
	assert.equal(pickSite(entries, "www.tcbpestcontrolcanberra.com.au"), "sc-domain:tcbpestcontrolcanberra.com.au");
});

test("a URL-prefix property is used when that is all there is", () => {
	const entries = [{ siteUrl: "https://www.tcbpestcontrolcanberra.com.au/" }];
	assert.equal(pickSite(entries, "www.tcbpestcontrolcanberra.com.au"), "https://www.tcbpestcontrolcanberra.com.au/");
});

test("the bare domain matches when the site is served from www", () => {
	const entries = [{ siteUrl: "https://tcbpestcontrolcanberra.com.au/" }];
	assert.equal(pickSite(entries, "www.tcbpestcontrolcanberra.com.au"), "https://tcbpestcontrolcanberra.com.au/");
});

test("somebody else's property is never picked", () => {
	// The worst outcome available here: real numbers, confidently displayed,
	// about a different website.
	const entries = [{ siteUrl: "sc-domain:someoneelse.com.au" }, { siteUrl: "https://example.com/" }];
	assert.equal(pickSite(entries, "www.tcbpestcontrolcanberra.com.au"), null);
	assert.equal(pickSite([], "www.tcbpestcontrolcanberra.com.au"), null);
});

test("totals are computed, not taken on trust", () => {
	const rows = [
		{ clicks: 10, impressions: 1000, ctr: 0.01, position: 5 },
		{ clicks: 5, impressions: 500, ctr: 0.01, position: 8 },
	];
	const result = totals(rows);
	assert.equal(result.clicks, 15);
	assert.equal(result.impressions, 1500);
	assert.equal(result.ctr, 0.01);
	assert.equal(totals([]).ctr, 0, "an empty set must not divide by zero");
});

const PAGES = [
	// Shown constantly, barely clicked: the case worth surfacing.
	{ key: "/termite-treatment", clicks: 10, impressions: 4000, ctr: 0.0025, position: 6 },
	// Doing fine.
	{ key: "/spider-control", clicks: 200, impressions: 2000, ctr: 0.1, position: 3 },
	// Below average, but on so little traffic that rewriting it wins nothing.
	{ key: "/earwig-control", clicks: 1, impressions: 60, ctr: 0.0166, position: 9 },
];

test("the shortlist is pages where a rewrite would actually pay", () => {
	const { missed } = opportunities({ pages: PAGES, siteCtr: 0.05 });
	assert.equal(missed.length, 1);
	assert.equal(missed[0].key, "/termite-treatment");
	assert.ok(missed[0].missedClicks > 100);
});

test("a page nobody sees is left off the shortlist", () => {
	// Its click-through is below average, but "below average on sixty
	// impressions" is noise, and a list padded with noise stops being read.
	const { missed } = opportunities({ pages: PAGES, siteCtr: 0.05 });
	assert.ok(!missed.some((page) => page.key === "/earwig-control"));
});

test("a page doing well is not reported as an opportunity", () => {
	const { missed } = opportunities({ pages: PAGES, siteCtr: 0.05 });
	assert.ok(!missed.some((page) => page.key === "/spider-control"));
});

test("a site with no data produces no shortlist rather than an empty verdict", () => {
	const empty = opportunities({ pages: [], queries: [], siteCtr: 0 });
	assert.deepEqual(empty.missed, []);
	assert.deepEqual(empty.nearlyThere, []);
});

test("the near-miss list is the top of page two, not page one", () => {
	const queries = [
		{ key: "pest control canberra", clicks: 90, impressions: 900, ctr: 0.1, position: 2 },
		{ key: "termite inspection canberra", clicks: 2, impressions: 400, ctr: 0.005, position: 11 },
		{ key: "wasp nest removal canberra", clicks: 0, impressions: 120, ctr: 0, position: 9 },
		{ key: "pest control sydney", clicks: 0, impressions: 300, ctr: 0, position: 45 },
		{ key: "some rare phrase", clicks: 0, impressions: 4, ctr: 0, position: 12 },
	];
	const { nearlyThere } = opportunities({ queries, siteCtr: 0.05 });
	assert.deepEqual(nearlyThere.map((entry) => entry.key), ["termite inspection canberra", "wasp nest removal canberra"]);
});

test("not being connected is reported as a setup step, with the step that gets missed", () => {
	assert.deepEqual(missingConfig({}), ["GOOGLE_SERVICE_ACCOUNT"]);
	assert.deepEqual(missingConfig({ GOOGLE_SERVICE_ACCOUNT: "{}" }), []);
	// Creating the key is the obvious half; sharing the property with it is
	// the half that is easy to skip, and nothing works without it.
	assert.match(setupMessage(), /Users and permissions/);
	assert.match(setupMessage(), /GOOGLE_SERVICE_ACCOUNT/);
});

test("a wrong or damaged key is named for what it is", () => {
	assert.throws(() => readServiceAccount("not json at all"), /whole downloaded file/);
	assert.throws(() => readServiceAccount(JSON.stringify({ type: "authorized_user" })), /service account key/);
	assert.throws(() => readServiceAccount(JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com" })), /private_key/);
	assert.throws(() => readServiceAccount(""), /No service account key/);
});

test("an OAuth client ID is recognised as the wrong turn it is", () => {
	// This one happened. "Create credentials" lists OAuth client ID above
	// service account, and the file it downloads is JSON with a client_id in
	// it -- close enough to look right. It contains no email of any kind, so
	// the instruction to "find the client_email" sends people looking for
	// something that was never in the file.
	const oauthClient = JSON.stringify({
		web: {
			client_id: "199708213829-example.apps.googleusercontent.com",
			project_id: "tcb-website-505616",
			token_uri: "https://oauth2.googleapis.com/token",
			client_secret: "not-a-real-secret",
		},
	});
	assert.throws(() => readServiceAccount(oauthClient), /OAuth client ID, not a service account key/);
	// The message has to say where to go instead, not just what is wrong.
	assert.throws(() => readServiceAccount(oauthClient), /Create credentials → Service account/);
	// A desktop-app client downloads under "installed" rather than "web".
	assert.throws(() => readServiceAccount(JSON.stringify({ installed: { client_id: "x" } })), /OAuth client ID/);
});

test("the sign-in assertion is a real RS256 JWT that verifies against its key", async () => {
	// The part with no visible failure mode. A malformed or wrongly signed
	// assertion comes back from Google as "invalid_grant", which reads exactly
	// like a key that has been revoked -- so the setup instructions would get
	// blamed for a signing bug. Signing with a generated key here and
	// verifying it with the matching public key settles which is which.
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"]
	);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;

	const assertion = await signedAssertion(
		{ client_email: "tcb-editor@example.iam.gserviceaccount.com", private_key: pem },
		"https://www.googleapis.com/auth/webmasters.readonly",
		1_755_000_000
	);

	const [header, claims, signature] = assertion.split(".");
	assert.equal(assertion.split(".").length, 3);

	const decode = (part) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
	assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });

	const payload = decode(claims);
	assert.equal(payload.iss, "tcb-editor@example.iam.gserviceaccount.com");
	assert.equal(payload.aud, "https://oauth2.googleapis.com/token", "the wrong audience is rejected without explanation");
	assert.equal(payload.scope, "https://www.googleapis.com/auth/webmasters.readonly");
	assert.equal(payload.iat, 1_755_000_000);
	assert.equal(payload.exp - payload.iat, 3600, "Google refuses assertions valid for longer than an hour");

	const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		pair.publicKey,
		raw,
		new TextEncoder().encode(`${header}.${claims}`)
	);
	assert.equal(verified, true, "the signature must cover exactly the header and claims that were sent");

	// And a signature that does not match must not verify, or the check above
	// proves nothing.
	const tampered = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		pair.publicKey,
		raw,
		new TextEncoder().encode(`${header}.${claims}x`)
	);
	assert.equal(tampered, false);
});

test("a private key survives being pasted with escaped newlines", () => {
	// Pasting the JSON through anything that escapes newlines is the most
	// common way to end up with a key that looks right and cannot be read.
	const body = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";
	const pem = `-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----\\n`;
	const der = pemToDer(pem);
	assert.ok(der instanceof Uint8Array);
	assert.equal(der.length, atob(body).length);
	assert.throws(() => pemToDer("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"), /empty/);
});
