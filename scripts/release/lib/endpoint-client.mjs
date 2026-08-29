// FLY-1062 PR4 · shared endpoint client for the release/ops scripts.
//
// Every write is a manifest single-object CAS against the endpoint (plan
// §B0-8): read → mutate a deep copy → POST {baseEtag, manifest}; a 412 means
// we lost the race — re-read, RE-JUDGE (the idempotency decision lives in the
// mutate callback, which may conclude "already done" and skip), retry
// bounded. Capability tokens ride env → Authorization header only; they are
// never logged and never enter argv.
import { createHash } from "node:crypto";
import fs from "node:fs";

export const CAS_RETRIES = 8;

export function makeClient({ endpoint, token, log = () => {} }) {
	const base = endpoint.replace(/\/+$/, "");

	async function api(method, path, body, raw = false) {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body !== undefined && !raw
					? { "content-type": "application/json" }
					: {}),
			},
			...(body !== undefined
				? { body: raw ? body : JSON.stringify(body), duplex: "half" }
				: {}),
		});
		return res;
	}

	async function readManifest() {
		const res = await api("GET", "/admin/manifest");
		if (res.status === 404) return { manifest: null, etag: null };
		if (res.status !== 200) {
			throw new Error(`cannot read manifest (HTTP ${res.status})`);
		}
		return { manifest: await res.json(), etag: res.headers.get("etag") };
	}

	// casUpdate <mutate> <describe> — mutate(copy, current) returns:
	//   true  → POST the mutated copy
	//   false → nothing to do (idempotent success — e.g. a rerun found the
	//           state already reached)
	// mutate may also THROW to fail closed (e.g. same id, different tuple).
	async function casUpdate(mutate, describe) {
		for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
			const { manifest, etag } = await readManifest();
			if (!manifest)
				throw new Error(
					`${describe}: no manifest — initialize per runbook first`,
				);
			const copy = structuredClone(manifest);
			if (!(await mutate(copy, manifest)))
				return { manifest, etag, skipped: true };
			const res = await api("POST", "/admin/manifest", {
				baseEtag: etag,
				manifest: copy,
			});
			if (res.status === 200) return { manifest: copy, skipped: false };
			if (res.status === 412) {
				log(
					`${describe}: CAS conflict — re-reading and re-judging (attempt ${attempt + 1})`,
				);
				continue;
			}
			const err = await res.json().catch(() => ({}));
			throw new Error(
				`${describe}: endpoint refused (HTTP ${res.status}) ${err.error ?? ""} ${
					err.violations ? JSON.stringify(err.violations) : ""
				}`,
			);
		}
		throw new Error(`${describe}: CAS retries exhausted`);
	}

	// uploadPayload <ver> <sha> <file> — streamed PUT; 409 (already exists) is
	// TOLERATED (plan §B0-9-3: "upload landed but the response was lost").
	async function uploadPayload(ver, sha, file) {
		const res = await api(
			"PUT",
			`/admin/payload/${encodeURIComponent(ver)}/${sha}`,
			fs.createReadStream(file),
			true,
		);
		if (res.status === 200 || res.status === 409) return res.status;
		const err = await res.json().catch(() => ({}));
		throw new Error(
			`upload ${ver} refused (HTTP ${res.status}): ${err.error ?? "unknown"}`,
		);
	}

	// readbackVerify <ver> <sha> — stream the object back and hash it; the
	// DOWNLOAD path is the identity witness (plan §B0-8 write invariants).
	async function readbackVerify(ver, sha) {
		const res = await api(
			"GET",
			`/admin/payload/${encodeURIComponent(ver)}/${sha}`,
		);
		if (res.status !== 200)
			throw new Error(`readback ${ver} failed (HTTP ${res.status})`);
		const hash = createHash("sha256");
		for await (const chunk of res.body) hash.update(chunk);
		const got = hash.digest("hex");
		if (got !== sha) {
			throw new Error(
				`readback ${ver}: sha256 mismatch (object ${got}, expected ${sha})`,
			);
		}
	}

	// downloadPayload <ver> <sha> <outFile> — verified fetch to a local file.
	async function downloadPayload(ver, sha, outFile) {
		const res = await api(
			"GET",
			`/admin/payload/${encodeURIComponent(ver)}/${sha}`,
		);
		if (res.status !== 200)
			throw new Error(`download ${ver} failed (HTTP ${res.status})`);
		const hash = createHash("sha256");
		const out = fs.createWriteStream(outFile);
		for await (const chunk of res.body) {
			hash.update(chunk);
			out.write(chunk);
		}
		await new Promise((resolve, reject) => {
			out.end((e) => (e ? reject(e) : resolve()));
		});
		const got = hash.digest("hex");
		if (got !== sha) {
			fs.rmSync(outFile, { force: true });
			throw new Error(`download ${ver}: sha256 mismatch (got ${got})`);
		}
	}

	return {
		api,
		readManifest,
		casUpdate,
		uploadPayload,
		readbackVerify,
		downloadPayload,
	};
}

export function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		fs.createReadStream(file)
			.on("data", (c) => hash.update(c))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

export function payloadKeyOf(ver, sha) {
	return `payloads/${ver}/${sha}.tgz`;
}

export function baseOf(ver) {
	return ver.replace(/-beta\.\d+$/, "");
}

// tuple equality for the write-once idempotency judgments (plan §B0-9).
export function tupleMatches(op, { sourceCommit, sha256, objectKey }) {
	return (
		op.sourceCommit === sourceCommit &&
		op.sha256 === sha256 &&
		op.objectKey === objectKey
	);
}

// test-only interruption seam: FW_TEST_ABORT_AFTER=<step> makes a script exit
// right after the named step lands — the crash-injection scenarios of the
// hermetic pipeline suite. Inert (no-op) unless the env var is set.
export function testAbortPoint(step) {
	if (process.env.FW_TEST_ABORT_AFTER === step) {
		console.log(`[test-abort] exiting after step: ${step}`);
		process.exit(42);
	}
}
