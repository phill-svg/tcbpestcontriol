// Renders every transactional email the site sends into one HTML page, so you
// can see exactly what a customer sees without waiting for a real booking.
//
//   npm run preview:email
//
// Cloudflare Email Sending keeps no sent folder, so the templates are otherwise
// only visible once they have already gone out to someone. This imports the
// real functions from src/email.js and stubs the `EMAIL` binding to capture the
// message instead of sending it -- so what you see here is the actual payload,
// not a copy of the markup that could drift out of step.
//
// Output goes to .wrangler/ on purpose: `assets.directory` in wrangler.jsonc is
// the whole repository, so a preview written to the repo root would be uploaded
// as a public page with sample customer details on it. .wrangler is both
// gitignored and listed in .assetsignore.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sendBookingConfirmation, sendBookingNotification, sendPasswordResetEmail } from "../src/email.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = process.argv[2] ? resolve(process.argv[2]) : resolve(REPO_ROOT, ".wrangler/email-preview.html");

// Obviously-fake details. This file is committed and the preview it writes may
// be opened by anyone with the repo, so it must never carry a real customer's
// name, address or phone number.
const SAMPLE = {
	name: "Sample Customer",
	email: "sample.customer@example.com",
	phone: "0400 000 000",
	address: "1 Example Street, Braddon ACT 2612",
	service: "General Pest Control",
	message: "Ants in the kitchen, mostly around the dishwasher.",
};

const CONFIRMED_TIME = "Tuesday 9 September 2026, 9:00 AM";
const JOB_URL = "https://go.servicem8.com/job?uuid=00000000-0000-0000-0000-000000000000";

// Each case mirrors a real path through src/booking.js. `who` says whose inbox
// it lands in, since that is the thing worth being sure about.
const CASES = [
	{
		title: "Customer — booking confirmed, fixed price",
		who: "Customer",
		note: "The /book form, slot locked in and priced. This is the common case.",
		send: (env) => sendBookingConfirmation(env, { ...SAMPLE, confirmedTime: CONFIRMED_TIME, priceLine: "$220 inc GST" }, "booking"),
	},
	{
		title: "Customer — booking confirmed, custom quote",
		who: "Customer",
		note: "Same, for a service we price on inspection rather than off the list.",
		send: (env) =>
			sendBookingConfirmation(env, { ...SAMPLE, confirmedTime: CONFIRMED_TIME, priceLine: "Custom quote requested" }, "booking"),
	},
	{
		title: "Customer — booking received, time not locked in",
		who: "Customer",
		note: "The customer picked a preference but no slot was reserved, so this promises a follow-up rather than confirming a time.",
		send: (env) => sendBookingConfirmation(env, { ...SAMPLE, date: "2026-09-09", time: "morning" }, "booking"),
	},
	{
		title: "Customer — contact form enquiry",
		who: "Customer",
		note: "The /contact form. No date, no price -- just a promise to reply within one business day.",
		send: (env) => sendBookingConfirmation(env, { ...SAMPLE }, "enquiry"),
	},
	{
		title: "Office — new online booking",
		who: "Office",
		note: "What office@ gets alongside the blind copy of the customer's confirmation.",
		send: (env) =>
			sendBookingNotification(env, { ...SAMPLE, confirmedTime: CONFIRMED_TIME, priceLine: "$220 inc GST" }, JOB_URL, "booking"),
	},
	{
		title: "Office — booking with a ServiceM8 warning",
		who: "Office",
		note: "The partial-failure path: the booking is made, but something needs doing by hand.",
		send: (env) =>
			sendBookingNotification(
				env,
				{
					...SAMPLE,
					confirmedTime: CONFIRMED_TIME,
					priceLine: "$220 inc GST",
					warning: "⚠ Booking created but auto-scheduling failed — set the time in ServiceM8 manually.",
				},
				null,
				"booking",
			),
	},
	{
		title: "Staff — password reset",
		who: "Staff",
		note: "Not a booking email, but it goes out from the same sender and is worth eyeballing.",
		send: (env) => sendPasswordResetEmail(env, "staff@example.com", "https://www.tcbpestcontrolcanberra.com.au/staff-chat/reset?token=SAMPLE", "Sample Staffer"),
	},
];

// Captures the payload the template would have handed to Cloudflare.
async function capture(send) {
	const sent = [];
	await send({ EMAIL: { send: (msg) => (sent.push(msg), Promise.resolve({ messageId: "preview" })) } });
	if (!sent.length) throw new Error("template sent nothing -- a guard clause bailed out early");
	return sent[0];
}

function escapeHtml(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function addresses(value) {
	return (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
}

function section(c, msg) {
	// The HTML body goes in a sandboxed iframe via srcdoc so the email's own
	// styles cannot leak into this page (or the other way round) -- what you see
	// in the frame is what a mail client renders.
	const header = (label, value) =>
		value ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : "";
	return (
		`<section>` +
		`<h2>${escapeHtml(c.title)} <span class="who who-${c.who.toLowerCase()}">${escapeHtml(c.who)}</span></h2>` +
		`<p class="note">${escapeHtml(c.note)}</p>` +
		`<table class="headers">` +
		header("From", msg.from) +
		header("To", addresses(msg.to)) +
		header("Bcc", addresses(msg.bcc)) +
		header("Reply-To", addresses(msg.reply_to)) +
		header("Subject", msg.subject) +
		`</table>` +
		`<div class="panes">` +
		`<div class="pane"><h3>HTML</h3><iframe sandbox srcdoc="${escapeHtml(msg.html || "")}"></iframe></div>` +
		`<div class="pane"><h3>Plain text</h3><pre>${escapeHtml(msg.text || "")}</pre></div>` +
		`</div>` +
		`</section>`
	);
}

const messages = [];
for (const c of CASES) messages.push([c, await capture(c.send)]);

const page =
	`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
	`<meta name="viewport" content="width=device-width,initial-scale=1">` +
	`<title>TCB email preview</title><style>` +
	`body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;margin:0;padding:28px;background:#f4f4f6;color:#111114}` +
	`h1{font-size:22px;margin:0 0 6px}` +
	`.lede{color:#5a5a62;margin:0 0 26px;max-width:70ch}` +
	`section{background:#fff;border:1px solid #e2e2e7;border-radius:8px;padding:18px 20px;margin-bottom:22px}` +
	`h2{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:10px}` +
	`.who{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:99px;background:#ececf1;color:#5a5a62}` +
	`.who-customer{background:#fdeceb;color:#c41613}` +
	`.note{color:#5a5a62;font-size:13px;margin:0 0 14px;max-width:70ch}` +
	`table.headers{border-collapse:collapse;font-size:13px;margin-bottom:14px}` +
	`table.headers th{text-align:left;font-weight:400;color:#5a5a62;padding:2px 14px 2px 0;white-space:nowrap;vertical-align:top}` +
	`table.headers td{padding:2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}` +
	`.panes{display:flex;gap:16px;flex-wrap:wrap}` +
	`.pane{flex:1 1 340px;min-width:0}` +
	`h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5a5a62;margin:0 0 6px}` +
	`iframe{width:100%;height:340px;border:1px solid #e2e2e7;border-radius:4px;background:#fff}` +
	`pre{margin:0;height:340px;overflow:auto;background:#fafafc;border:1px solid #e2e2e7;border-radius:4px;padding:12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}` +
	`</style></head><body>` +
	`<h1>What the customer sees</h1>` +
	`<p class="lede">Rendered from <code>src/email.js</code> on ${escapeHtml(new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" }))} (Sydney). ` +
	`Sample details only &mdash; no real customer data. Re-run <code>npm run preview:email</code> after changing a template.</p>` +
	messages.map(([c, msg]) => section(c, msg)).join("") +
	`</body></html>`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, page);
console.log(`Wrote ${messages.length} emails to ${OUT_PATH}`);
for (const [c, msg] of messages) console.log(`  ${c.who.padEnd(8)} ${msg.subject}`);
