// Transactional email via Cloudflare Email Sending (the `EMAIL` send_email
// binding in wrangler.jsonc). Sends only from the dedicated sending subdomain
// `mail.tcbpestcontrolcanberra.com.au` -- the root domain runs Google
// Workspace/Gmail and is never used for these automated sends.

const FROM_ADDRESS = "noreply@mail.tcbpestcontrolcanberra.com.au";
const FROM_NAME = "TCB Pest Control";
const REPLY_TO = "phill@tcbpestcontrolcanberra.com.au";
const OFFICE_EMAIL = "office@tcbpestcontrolcanberra.com.au";

// Sends a password-reset link. Throws if the EMAIL binding is missing or the
// send fails, so callers can decide how to surface it.
export async function sendPasswordResetEmail(env, toEmail, resetUrl, username) {
	if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
		throw new Error("EMAIL binding not configured");
	}

	const safeName = String(username || "there");
	const subject = "Reset your TCB Pest Control staff password";
	const text =
		`Hi ${safeName},\n\n` +
		`We received a request to reset your TCB Pest Control staff password.\n\n` +
		`Reset it here (this link expires in 1 hour):\n${resetUrl}\n\n` +
		`If you didn't request this, you can safely ignore this email -- your password won't change.\n\n` +
		`-- TCB Pest Control`;

	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111114;line-height:1.6;max-width:520px">` +
		`<p>Hi ${escapeHtml(safeName)},</p>` +
		`<p>We received a request to reset your <strong>TCB Pest Control</strong> staff password.</p>` +
		`<p style="margin:24px 0"><a href="${escapeAttr(resetUrl)}" style="background:#e5251a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:700;display:inline-block">Reset your password</a></p>` +
		`<p style="color:#5a5a62;font-size:13px">This link expires in 1 hour. If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${escapeHtml(resetUrl)}</span></p>` +
		`<p style="color:#5a5a62;font-size:13px">If you didn't request this, you can safely ignore this email &mdash; your password won't change.</p>` +
		`<p style="margin-top:24px">&mdash; TCB Pest Control</p>` +
		`</div>`;

	// The send_email binding requires plain string addresses (unlike the REST
	// API, which also accepts {address,name} objects and arrays). Passing an
	// object here throws "Incorrect type for the 'email' field on 'EmailAddress'".
	return env.EMAIL.send({
		from: FROM_ADDRESS,
		to: toEmail,
		reply_to: REPLY_TO,
		subject,
		text,
		html,
	});
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
	return escapeHtml(s);
}

// Notifies the office of a new website booking. Includes a link straight to the
// ServiceM8 job when it was created; flags it if ServiceM8 couldn't be reached
// so the lead is never lost. Throws are swallowed by the caller (waitUntil).
export async function sendBookingNotification(env, booking, jobUrl) {
	if (!env.EMAIL || typeof env.EMAIL.send !== "function") return;
	const { name, email, phone, address, service, date, time, message } = booking;
	const preferred = [date, time].filter(Boolean).join(" ");

	const textLines = [
		"New online booking from the website:",
		"",
		`Name:    ${name}`,
		`Phone:   ${phone}`,
		`Email:   ${email}`,
		`Address: ${address}`,
		`Service: ${service}`,
		preferred ? `Preferred: ${preferred}` : "",
		message ? `Notes:   ${message}` : "",
		"",
		jobUrl ? `Open the job in ServiceM8: ${jobUrl}` : "NOTE: could not auto-create in ServiceM8 — please add this job manually.",
	].filter((l) => l !== "");

	const row = (label, value) =>
		`<tr><td style="padding:3px 14px 3px 0;color:#5a5a62;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:3px 0"><strong>${escapeHtml(value)}</strong></td></tr>`;
	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111114;line-height:1.5;max-width:560px">` +
		`<h2 style="font-size:18px;margin:0 0 14px">New online booking</h2>` +
		`<table style="border-collapse:collapse">` +
		row("Name", name) +
		`<tr><td style="padding:3px 14px 3px 0;color:#5a5a62">Phone</td><td style="padding:3px 0"><a href="tel:${escapeAttr(phone)}">${escapeHtml(phone)}</a></td></tr>` +
		`<tr><td style="padding:3px 14px 3px 0;color:#5a5a62">Email</td><td style="padding:3px 0"><a href="mailto:${escapeAttr(email)}">${escapeHtml(email)}</a></td></tr>` +
		row("Address", address) +
		row("Service", service) +
		(preferred ? row("Preferred", preferred) : "") +
		(message ? `<tr><td style="padding:3px 14px 3px 0;color:#5a5a62;vertical-align:top">Notes</td><td style="padding:3px 0">${escapeHtml(message)}</td></tr>` : "") +
		`</table>` +
		(jobUrl
			? `<p style="margin-top:18px"><a href="${escapeAttr(jobUrl)}" style="background:#e5251a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:4px;font-weight:700;display:inline-block">Open job in ServiceM8</a></p>`
			: `<p style="margin-top:16px;color:#c41613"><strong>Could not auto-create in ServiceM8 — please add this job manually.</strong></p>`) +
		`</div>`;

	return env.EMAIL.send({
		from: FROM_ADDRESS,
		to: OFFICE_EMAIL,
		reply_to: email || REPLY_TO,
		subject: `New online booking: ${name}${service ? " — " + service : ""}`,
		text: textLines.join("\n"),
		html,
	});
}

// Instant branded confirmation to the customer who booked.
export async function sendBookingConfirmation(env, booking) {
	if (!env.EMAIL || typeof env.EMAIL.send !== "function" || !booking.email) return;
	const first = String(booking.name || "there").trim().split(/\s+/)[0] || "there";
	const service = booking.service || "";
	const preferred = [booking.date, booking.time].filter(Boolean).join(" ");
	const forWhat = service ? ` for ${service}` : "";
	const whenBit = preferred ? ` (${preferred})` : "";

	const text =
		`Hi ${first},\n\n` +
		`Thanks for booking with TCB Pest Control Canberra! We've received your request${forWhat}${whenBit} and we'll be in touch shortly to confirm your time.\n\n` +
		`Need us sooner? Call 02 6105 9771 (Mon-Sat 8am-5pm).\n\n` +
		`-- TCB Pest Control Canberra`;

	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111114;line-height:1.6;max-width:520px">` +
		`<p>Hi ${escapeHtml(first)},</p>` +
		`<p>Thanks for booking with <strong>TCB Pest Control Canberra</strong>! We've received your request${escapeHtml(forWhat)}${escapeHtml(whenBit)} and we'll be in touch shortly to confirm your time.</p>` +
		`<p style="color:#5a5a62">Need us sooner? Call <a href="tel:0261059771" style="color:#c41613">02 6105 9771</a> (Mon–Sat 8am–5pm).</p>` +
		`<p style="margin-top:22px">&mdash; TCB Pest Control Canberra</p>` +
		`</div>`;

	return env.EMAIL.send({
		from: FROM_ADDRESS,
		to: booking.email,
		reply_to: OFFICE_EMAIL,
		subject: "We've got your booking — TCB Pest Control",
		text,
		html,
	});
}
