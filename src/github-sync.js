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

async function call(token, path, options = {}) {
	const response = await fetch(`${API}${path}`, { ...options, headers: headers(token) });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const error = new Error(`GitHub ${options.method || "GET"} ${path} failed (${response.status}): ${detail.slice(0, 300)}`);
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

export function isConfigured(env) {
	return !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
}

// Instructions rather than a bare "not configured", because the person who
// sees this is the one who has to fix it and is probably not a developer.
export const SETUP_MESSAGE =
	"Syncing to code isn't set up yet. It needs a GitHub token: create a fine-grained personal access token with " +
	"'Contents: read and write' on this repository, then add it to the Worker as a secret named GITHUB_TOKEN " +
	"(Cloudflare dashboard -> Workers -> tcbpestreal -> Settings -> Variables and Secrets), and set GITHUB_REPO " +
	"to 'owner/name'. See EDITING-GUIDE.md.";

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
