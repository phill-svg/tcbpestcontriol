// Committing baked-in copy edits straight to GitHub from the Worker.
//
// This is what the editor's "Sync to code" button calls. The alternative was
// a scheduled job that shells out to scripts/sync-content-edits.js, but that
// needs a machine with a clone, a Node install and a way to authenticate --
// three things a one-click button should not depend on. Everything needed to
// do the job already runs here: bakeEdits() is plain JavaScript with no Node
// APIs, and GitHub's Git Data API can build a commit over HTTPS.
//
// One commit is produced for the whole sync rather than one per file, which
// is why this uses the Git Data API (blobs -> tree -> commit -> ref) instead
// of the simpler Contents API.
//
// Requires two pieces of configuration:
//   GITHUB_TOKEN  -- secret; a fine-grained PAT with Contents: read & write
//                    on this repository and nothing else
//   GITHUB_REPO   -- var; "owner/name"

const API = "https://api.github.com";

// GitHub rejects requests without one, and a descriptive value makes the
// source obvious in audit logs.
const USER_AGENT = "tcb-pest-control-site-editor";

function headers(token) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": USER_AGENT,
		"content-type": "application/json",
	};
}

// GitHub's own error bodies are terse and the status alone is ambiguous, so
// the common causes are named. Whoever reads this is trying to work out what
// to change in a settings page, not to debug an API.
function explain(status, path) {
	if (status === 401) return "the GITHUB_TOKEN is not valid (expired, revoked, or mistyped)";
	if (status === 403) return "the GITHUB_TOKEN is valid but lacks 'Contents: read and write' on this repository";
	if (status === 404) {
		return path.includes("/contents/")
			? "that file does not exist on the branch, or the token cannot see this repository"
			: "the repository or branch in GITHUB_REPO could not be found (check the owner/name spelling)";
	}
	if (status === 409 || status === 422) return "the branch moved while the sync was being prepared -- try again";
	return null;
}

async function call(token, path, options = {}) {
	const response = await fetch(`${API}${path}`, { ...options, headers: headers(token) });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const reason = explain(response.status, path);
		const error = new Error(
			reason
				? `GitHub returned ${response.status} -- ${reason}.`
				: `GitHub ${options.method || "GET"} ${path} failed (${response.status}): ${detail.slice(0, 300)}`
		);
		error.status = response.status;
		throw error;
	}
	return response.json();
}

// GitHub hands blob contents back as base64 of the raw bytes. atob gives a
// binary string, one char per byte, which has to go through TextDecoder to
// come back as text -- reading it directly would mangle every non-ASCII
// character, and this site's copy is full of en dashes and curly quotes.
function decodeBase64Utf8(base64) {
	const binary = atob(base64.replace(/\n/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	// Chunked so a large page cannot blow the argument limit on spread.
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

// Which pieces of configuration are absent, so the message can name them.
// Reporting "not set up" when one of the two is already in place sends people
// to re-do the part that was already right.
export function missingConfig(env) {
	const missing = [];
	if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
	if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");
	return missing;
}

export function isConfigured(env) {
	return missingConfig(env).length === 0;
}

// Instructions rather than a bare "not configured", because the person who
// sees this is the one who has to fix it and is probably not a developer.
export function setupMessage(missing) {
	const parts = [`Syncing to code isn't set up yet — the Worker is missing ${missing.join(" and ")}.`];
	if (missing.includes("GITHUB_TOKEN")) {
		parts.push(
			"For GITHUB_TOKEN: create a fine-grained personal access token on GitHub with 'Contents: read and write' on " +
				"this repository, then add it in the Cloudflare dashboard under Workers → tcbpestreal → Settings → " +
				"Variables and Secrets, as type Secret, named exactly GITHUB_TOKEN."
		);
	}
	if (missing.includes("GITHUB_REPO")) {
		parts.push(
			"GITHUB_REPO should already be set in wrangler.jsonc and applied on deploy. If it is missing, the Worker is " +
				"probably running an older deployment — check that the latest push to the main branch finished building, " +
				"or add GITHUB_REPO as a plain text variable with the value 'owner/name'."
		);
	}
	parts.push("See EDITING-GUIDE.md.");
	return parts.join(" ");
}

export function readFile(env, path, branch) {
	const [owner, repo] = String(env.GITHUB_REPO).split("/");
	return call(env.GITHUB_TOKEN, `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
}

// Writes a set of {path, content} files as a single commit on `branch`.
// Returns the new commit's sha and short url.
export async function commitFiles(env, branch, files, message) {
	const [owner, repo] = String(env.GITHUB_REPO).split("/");
	const base = `/repos/${owner}/${repo}`;
	const token = env.GITHUB_TOKEN;

	// Where the branch is right now. Everything below is built on top of this
	// exact commit, so a push that lands in between makes the final ref update
	// fail rather than silently discarding someone else's work.
	const ref = await call(token, `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
	const headSha = ref.object.sha;
	const headCommit = await call(token, `${base}/git/commits/${headSha}`);

	const tree = [];
	for (const file of files) {
		const blob = await call(token, `${base}/git/blobs`, {
			method: "POST",
			body: JSON.stringify({ content: encodeBase64Utf8(file.content), encoding: "base64" }),
		});
		tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
	}

	const newTree = await call(token, `${base}/git/trees`, {
		method: "POST",
		body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
	});

	const commit = await call(token, `${base}/git/commits`, {
		method: "POST",
		body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
	});

	// Not forced: if the branch moved while this was being built, the update
	// is rejected and the caller reports it, rather than overwriting whatever
	// arrived in the meantime.
	await call(token, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
		method: "PATCH",
		body: JSON.stringify({ sha: commit.sha, force: false }),
	});

	return { sha: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}

export { decodeBase64Utf8 };

// Exported for the tests: the status -> plain-English mapping is the part
// worth pinning, and reaching it through a stubbed fetch proves less.
export { explain as explainForTest };
