// Transactional email via Cloudflare Email Sending (the `EMAIL` send_email
// binding in wrangler.jsonc). Sends only from the dedicated sending subdomain
// `mail.tcbpestcontrolcanberra.com.au` -- the root domain runs Google
// Workspace/Gmail and is never used for these automated sends.

const FROM_ADDRESS = "noreply@mail.tcbpestcontrolcanberra.com.au";
const FROM_NAME = "TCB Pest Control";
const REPLY_TO = "phill@tcbpestcontrolcanberra.com.au";

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
