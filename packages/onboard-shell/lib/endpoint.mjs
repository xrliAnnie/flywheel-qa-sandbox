// FLY-1062 PR2 · gated endpoint client — key rides ONLY the Authorization
// header, never the URL or any log line. sha256 is verified before a payload
// is ever handed to the installer.
//
// PR2 talks to a STUB endpoint in the tests; the real hosting URL is filled
// in PR3/PR4. The 401 shape (invalid/revoked key) is a first-class result so
// the caller can trigger rotation.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeVersion } from "./config.mjs";

export class EndpointError extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind; // "unauthorized" | "network" | "protocol"
	}
}

// authHeaders <key> — key in Authorization only.
function authHeaders(key) {
	return { Authorization: `Bearer ${key}` };
}

// fetchManifest <endpoint> <key> → {latest, versions:[{ver, sha256}]}.
export async function fetchManifest(endpoint, key, { fetchImpl = fetch } = {}) {
	let res;
	try {
		res = await fetchImpl(`${endpoint}/manifest`, {
			headers: authHeaders(key),
		});
	} catch (e) {
		throw new EndpointError("network", e.message);
	}
	if (res.status === 401 || res.status === 403) {
		throw new EndpointError(
			"unauthorized",
			`endpoint rejected the key (${res.status})`,
		);
	}
	if (!res.ok)
		throw new EndpointError("network", `manifest HTTP ${res.status}`);
	let json;
	try {
		json = await res.json();
	} catch (e) {
		throw new EndpointError("protocol", `manifest not JSON: ${e.message}`);
	}
	if (
		!json ||
		typeof json.latest !== "string" ||
		!Array.isArray(json.versions)
	) {
		throw new EndpointError("protocol", "manifest missing latest/versions");
	}
	// Every version string becomes a filesystem path component + an rmSync
	// target — reject a hostile/corrupt `latest: ".."` or `ver: "../.."` at the
	// boundary so it never reaches the installer (Codex R1#2).
	if (!isSafeVersion(json.latest)) {
		throw new EndpointError(
			"protocol",
			`manifest latest is not a safe version: ${JSON.stringify(json.latest)}`,
		);
	}
	for (const v of json.versions) {
		if (!v || !isSafeVersion(v.ver)) {
			throw new EndpointError(
				"protocol",
				`manifest has an unsafe version entry: ${JSON.stringify(v?.ver)}`,
			);
		}
	}
	return json;
}

// downloadPayload <endpoint> <key> <ver> <expectedSha256> → local tarball path
// in a fresh temp dir. Verifies sha256; on mismatch deletes the temp file and
// throws (zero half-baked bytes leak into the version tree).
export async function downloadPayload(
	endpoint,
	key,
	ver,
	expectedSha,
	{ fetchImpl = fetch } = {},
) {
	let res;
	try {
		res = await fetchImpl(`${endpoint}/payload/${encodeURIComponent(ver)}`, {
			headers: authHeaders(key),
		});
	} catch (e) {
		throw new EndpointError("network", e.message);
	}
	if (res.status === 401 || res.status === 403) {
		throw new EndpointError(
			"unauthorized",
			`endpoint rejected the key (${res.status})`,
		);
	}
	if (!res.ok) throw new EndpointError("network", `payload HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	const got = createHash("sha256").update(buf).digest("hex");
	if (got !== expectedSha) {
		throw new EndpointError(
			"checksum",
			`sha256 mismatch (want ${expectedSha}, got ${got})`,
		);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-onboard-payload-"));
	const file = path.join(dir, `payload-${ver}.tgz`);
	fs.writeFileSync(file, buf);
	return file;
}

// sha256File <path> → hex digest (used by the update/verify path).
export function sha256File(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
