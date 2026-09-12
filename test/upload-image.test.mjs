// POST /api/content/upload-image -- putting a picture into the repository.
//
// This route is the only place in the site where bytes the client chose are
// written to the repository, so most of what is worth pinning here is what it
// refuses. Nothing talks to GitHub for real; the stub records what would have
// been committed, which is the only way to prove that a rejected upload wrote
// nothing rather than writing something slightly wrong.
//
// The route touches no database at all -- it writes files, not overrides --
// so unlike the other content routes there is no D1 stub below.

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleContentApi } from "../src/content-edits.js";

const SESSION = { username: "phill", isAdmin: true };
const ENV_BASE = { GITHUB_TOKEN: "test-token", GITHUB_REPO: "owner/repo" };

// What assets/images/manifest.json looks like before the upload. Two entries,
// so a sort has something to get wrong.
const EXISTING = [
	{ path: "/assets/images/ant-control.webp", bytes: 1234 },
	{ path: "/assets/images/zebra.webp", bytes: 4321 },
];

// The build script's exact output format, written out by hand rather than by
// calling JSON.stringify. assets/images/manifest.json is a committed build
// artefact: if the Worker re-emits it in any other shape then the next local
// `npm run build:images` rewrites the whole file, and an unrelated commit
// picks up a thousand-line diff. Re-deriving the format independently is what
// makes this assertion mean something.
function manifestText(images) {
	const entries = images.map((image) => `\t\t{\n\t\t\t"path": ${JSON.stringify(image.path)},\n\t\t\t"bytes": ${image.bytes}\n\t\t}`);
	return `{\n\t"images": [\n${entries.join(",\n")}\n\t]\n}\n`;
}

// A RIFF/WEBP container of the requested size. The header is the only part
// the route looks at; the rest is filler that is deliberately not valid UTF-8
// so that anything decoding these bytes as text shows up as a failure.
function webp(bytes = 64) {
	const body = Buffer.alloc(Math.max(bytes - 12, 0), 0xff);
	const size = Buffer.alloc(4);
	size.writeUInt32LE(body.length + 4, 0);
	return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), body]);
}

// Records the blobs by sha and the tree that ties them to paths. The blob POST
// carries no path -- only content -- so proving "the image went to this path
// and the manifest to that one" needs a distinct sha per blob and the tree
// body to join them back up.
function stubGitHub(manifest = manifestText(EXISTING)) {
	const blobs = new Map();
	const trees = [];
	const commits = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const path = new URL(url).pathname;
		const method = options.method || "GET";
		const body = options.body ? JSON.parse(options.body) : null;
		const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

		if (method === "GET" && path.includes("/contents/")) {
			if (manifest === null) return reply({ message: "Not Found" }, 404);
			return reply({ content: Buffer.from(manifest, "utf8").toString("base64"), sha: "filesha" });
		}
		if (method === "GET" && path.endsWith("/git/ref/heads/main")) return reply({ object: { sha: "headsha" } });
		if (method === "GET" && path.includes("/git/commits/")) return reply({ tree: { sha: "basetree" } });
		if (method === "POST" && path.endsWith("/git/blobs")) {
			const sha = `blob${blobs.size}`;
			// Kept as the raw base64 string. Decoding to utf8 here, as the
			// structure-route stub does, would mangle the image beyond
			// recognition and quietly turn the interesting assertion into a
			// comparison of two piles of replacement characters.
			blobs.set(sha, body.content);
			return reply({ sha });
		}
		if (method === "POST" && path.endsWith("/git/trees")) {
			trees.push(body.tree);
			return reply({ sha: "treesha" });
		}
		if (method === "POST" && path.endsWith("/git/commits")) {
			commits.push(body);
			return reply({ sha: "commitsha" });
		}
		if (method === "PATCH") return reply({ ok: true });
		return reply({ message: `unexpected ${method} ${path}` }, 500);
	};
	return {
		blobs,
		trees,
		commits,
		// path -> the base64 that was committed there.
		written() {
			const files = new Map();
			for (const entry of trees.flat()) files.set(entry.path, blobs.get(entry.sha));
			return files;
		},
		restore: () => (globalThis.fetch = original),
	};
}

async function upload(body, { manifest, env = {}, contentType = "application/json" } = {}) {
	const github = stubGitHub(manifest === undefined ? manifestText(EXISTING) : manifest);
	try {
		const response = await handleContentApi(
			new Request("https://site.test/api/content/upload-image", {
				method: "POST",
				headers: { "content-type": contentType },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
			new URL("https://site.test/api/content/upload-image"),
			{ ...ENV_BASE, ...env },
			SESSION
		);
		return { status: response.status, body: await response.json(), github };
	} finally {
		github.restore();
	}
}

// Nothing at all reached the repository. Both halves matter: a bug that skips
// the blob loop but still builds a commit would sail past a blob-only check,
// and would push an empty commit on every rejected upload.
function assertNothingCommitted(github) {
	assert.equal(github.blobs.size, 0, "no blob may be written");
	assert.equal(github.commits.length, 0, "and no commit may be created");
}

test("a valid upload commits the picture and the manifest together in one commit", async () => {
	// The two files have to travel in the same commit. The manifest is a
	// committed build artefact that the picker fetches as a static file, so an
	// image committed without its manifest entry is invisible to the one thing
	// the upload exists to feed -- and a second commit means a second deploy
	// and a window where the picker lists a file that 404s.
	const image = webp(96);
	const { status, body, github } = await upload({ name: "New Photo.webp", base64: image.toString("base64") });

	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.ok, true);
	assert.equal(body.path, "/assets/images/new-photo.webp", "the .webp on the supplied name must not become part of the slug");

	assert.equal(github.commits.length, 1, "one commit, not two");
	const written = github.written();
	assert.deepEqual([...written.keys()].sort(), ["assets/images/manifest.json", "assets/images/new-photo.webp"]);

	// The committed image must be the bytes that were sent, not a text-encoded
	// impression of them.
	assert.deepEqual([...Buffer.from(written.get("assets/images/new-photo.webp"), "base64")], [...image]);

	// Sorted by path, the new entry spliced between the two that were there,
	// and `bytes` the decoded size rather than the base64 length.
	assert.equal(
		Buffer.from(written.get("assets/images/manifest.json"), "base64").toString("utf8"),
		manifestText([EXISTING[0], { path: "/assets/images/new-photo.webp", bytes: 96 }, EXISTING[1]])
	);
});

test("the response says the picture is not live until the deploy finishes", async () => {
	// The commit lands at once but Cloudflare has to rebuild before the file is
	// served, which takes a minute or two. Without being told, the person who
	// just uploaded sees a broken image and concludes the upload failed.
	const { body } = await upload({ name: "hero", base64: webp().toString("base64") });
	assert.match(body.message, /deploy/i);
});

test("a payload that is not a WebP is refused however it is named", async () => {
	// The trust boundary. Both the name and the bytes come from the client, so
	// the only thing that establishes what the file is is its own header. A PNG
	// committed as .webp would be served with the wrong content type to every
	// visitor, and src/assets.js would try to negotiate an AVIF sibling for it.
	const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\n", "binary"), Buffer.alloc(40, 0)]);
	const { status, body, github } = await upload({ name: "sneaky.webp", base64: png.toString("base64") });

	assert.equal(status, 400);
	assert.match(body.error, /webp/i);
	assertNothingCommitted(github);
});

test("a RIFF container that is not a WebP is refused as well", async () => {
	// RIFF is a generic container -- a .wav starts with it too. Checking only
	// the first four bytes would let one through, which is exactly the sort of
	// half-check that reads as a magic-byte test and is not one.
	const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVE"), Buffer.alloc(40, 0)]);
	const { status, github } = await upload({ name: "audio", base64: wav.toString("base64") });

	assert.equal(status, 400);
	assertNothingCommitted(github);
});

test("a picture over two megabytes is refused before anything is committed", async () => {
	// Every upload costs a commit and a full site redeploy, and the blob sits
	// in the repository's history for good. There is no reason for a photograph
	// on this site to be anywhere near this big.
	const { status, body, github } = await upload({ name: "huge", base64: webp(2 * 1024 * 1024 + 1024).toString("base64") });

	assert.equal(status, 413);
	assert.match(body.error, /too big/i);
	assertNothingCommitted(github);
});

test("uploading over an existing name gets a suffix instead of replacing the picture", async () => {
	// Two people naming a file "logo" a month apart are not asking to replace
	// each other's work, and the older one is probably already referenced from
	// a page. Overwriting would change that page silently.
	const existing = { path: "/assets/images/logo.webp", bytes: 999 };
	const { status, body, github } = await upload(
		{ name: "logo", base64: webp(80).toString("base64") },
		{ manifest: manifestText([existing]) }
	);

	assert.equal(status, 200, JSON.stringify(body));
	assert.match(body.path, /^\/assets\/images\/logo-\d{5}\.webp$/, "five digits, as in tcb-pest-control-logo-03284.webp");
	assert.notEqual(body.path, existing.path);

	const written = github.written();
	assert.ok(written.has(`assets${body.path.slice("/assets".length)}`), "the picture goes to the suffixed path");
	assert.ok(!written.has("assets/images/logo.webp"), "and never to the one already taken");

	// The entry that was already there must survive the rewrite. "logo-NNNNN"
	// sorts before "logo" because "-" is 0x2D and "." is 0x2E -- the same order
	// the build script's plain filename sort produces, which is the point.
	const manifest = JSON.parse(Buffer.from(written.get("assets/images/manifest.json"), "base64").toString("utf8"));
	assert.deepEqual(manifest.images, [{ path: body.path, bytes: 80 }, existing]);
});

test("the same picture uploaded twice under a taken name settles on one file", async () => {
	// The suffix is a hash of the content rather than a random number, so a
	// double-click or a retry converges instead of littering the folder with
	// near-identical copies -- each of which would cost its own deploy.
	const base64 = webp(80).toString("base64");
	const first = await upload({ name: "logo", base64 }, { manifest: manifestText([{ path: "/assets/images/logo.webp", bytes: 999 }]) });

	const second = await upload(
		{ name: "logo", base64 },
		{ manifest: manifestText([{ path: "/assets/images/logo.webp", bytes: 999 }, { path: first.body.path, bytes: 80 }]) }
	);

	assert.equal(second.status, 200);
	assert.equal(second.body.path, first.body.path);
	assertNothingCommitted(second.github);
});

test("a name that cannot be slugged into a filename is refused", async () => {
	const base64 = webp().toString("base64");
	for (const name of ["", "   ", "...", "!!!", "-", "a".repeat(62)]) {
		const { status, github } = await upload({ name, base64 });
		assert.equal(status, 400, `should have refused ${JSON.stringify(name)}`);
		assertNothingCommitted(github);
	}
});

test("a name that tries to climb out of the images folder is flattened, not honoured", async () => {
	// Slugging is what makes the committed path safe: every character that
	// could mean anything to a path -- dots, slashes -- becomes a dash, so
	// there is no traversal left to refuse. Asserting the resulting path rather
	// than a 400 is deliberate; a rejection here would only prove the name was
	// odd, not that a surviving one is harmless.
	const { status, body, github } = await upload({ name: "../../wrangler.jsonc", base64: webp().toString("base64") });

	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.path, "/assets/images/wrangler.webp");
	for (const path of github.written().keys()) {
		assert.match(path, /^assets\/images\/[a-z0-9][a-z0-9-]*\.(webp|json)$/, `${path} escaped the images folder`);
	}
});

test("a request with no picture in it is refused", async () => {
	for (const body of [{}, { name: "photo" }, { base64: webp().toString("base64") }, { name: "photo", base64: 42 }]) {
		const { status, github } = await upload(body);
		assert.equal(status, 400, JSON.stringify(body));
		assertNothingCommitted(github);
	}
});

test("something that is not base64 at all is a bad request, not a crash", async () => {
	// atob throws on malformed input. Left uncaught that is a 500, which reads
	// as "the server is broken" when the truth is "that was not a file".
	const { status, github } = await upload({ name: "photo", base64: "not base64 !!!!" });
	assert.equal(status, 400);
	assertNothingCommitted(github);
});

test("anything but application/json is refused, which is what makes the CSRF argument true", async () => {
	// A cross-site application/json POST is preflighted, so the browser asks
	// permission first. multipart/form-data and text/plain are not -- and
	// request.json() will happily parse a text/plain body that was shaped to
	// look like JSON, so refusing multipart alone would not close the hole.
	const payload = JSON.stringify({ name: "photo", base64: webp().toString("base64") });
	for (const contentType of ["multipart/form-data; boundary=x", "text/plain", "application/x-www-form-urlencoded", ""]) {
		const { status, github } = await upload(payload, { contentType });
		assert.equal(status, 415, `should have refused ${JSON.stringify(contentType)}`);
		assertNothingCommitted(github);
	}
});

test("without a GitHub token it says how to set one up, rather than failing", async () => {
	const { status, body } = await upload({ name: "photo", base64: webp().toString("base64") }, { env: { GITHUB_TOKEN: "" } });
	assert.equal(status, 501);
	assert.ok(body.missing.includes("GITHUB_TOKEN"));
	assert.match(body.error, /GITHUB_TOKEN/);
});

test("an unreadable manifest stops the upload instead of starting a fresh one", async () => {
	// Writing a new manifest containing only the picture just uploaded would
	// delete every existing image from the picker in the same commit. A failed
	// upload is a far better outcome than that.
	const { status, body, github } = await upload({ name: "photo", base64: webp().toString("base64") }, { manifest: null });

	assert.equal(status, 502);
	assert.match(body.error, /image list/i);
	assertNothingCommitted(github);
});
