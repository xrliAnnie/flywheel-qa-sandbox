/**
 * FLY-1062 broker PR · in-process npm registry client (plan §3 ②/③).
 *
 * `npm publish` is a REGISTRY HTTP PROTOCOL, not a CLI-only ritual — and the
 * npm CLI is a child process, which the GAT must never enter. So the broker
 * speaks the protocol itself: one authenticated PUT of the packument-with-
 * attachment document. The token lives in the caller's memory and travels
 * ONLY as this request's Authorization header.
 *
 * Digest discipline (plan §3 ② / Codex R6#1): we never trust the registry's
 * dist.shasum (sha1) or dist.integrity (sha512) for authorization decisions —
 * equality with the approved artifact is always LOCAL sha256 over the actual
 * tarball bytes (staged file, or bytes re-downloaded from the registry on a
 * 409/exists path).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";

function sha1Hex(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
}

function sha512Integrity(bytes: Buffer): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function sha256HexOf(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function packumentUrl(registryUrl: string, name: string): string {
	const base = registryUrl.replace(/\/+$/, "");
	// scoped names keep the @ but escape the inner slash (npm convention)
	return `${base}/${name.replace("/", "%2f")}`;
}

/** sha256 of the tarball the registry serves for name@version, or null when
 * the version does not exist. Throws on transport/HTTP errors (fail-closed —
 * "unknown" must never read as "absent"). */
export async function fetchPublishedTarballSha256(opts: {
	registryUrl: string;
	name: string;
	version: string;
	token?: string;
}): Promise<string | null> {
	const res = await fetch(packumentUrl(opts.registryUrl, opts.name), {
		headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`registry packument HTTP ${res.status}`);
	const doc = (await res.json()) as {
		versions?: Record<string, { dist?: { tarball?: string } }>;
	};
	const tarballUrl = doc.versions?.[opts.version]?.dist?.tarball;
	if (!tarballUrl) return null;
	const tres = await fetch(tarballUrl, {
		headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
	});
	if (!tres.ok) throw new Error(`registry tarball HTTP ${tres.status}`);
	return sha256HexOf(Buffer.from(await tres.arrayBuffer()));
}

/** One authenticated publish PUT. Returns the HTTP status (200/201 = landed,
 * 403/409 = version conflict for the caller's idempotency judgment).
 *
 * `manifest` is the tarball's FULL package.json (Codex code R1 HIGH): the
 * registry's version document IS the install manifest — dropping fields like
 * `bin` would ship a package `npx` cannot resolve an executable from. The
 * identity fields (_id/name/version/dist) are stamped over it. */
export async function publishTarball(opts: {
	registryUrl: string;
	token: string;
	name: string;
	version: string;
	tarballPath: string;
	manifest: Record<string, unknown>;
}): Promise<number> {
	const bytes = fs.readFileSync(opts.tarballPath);
	const pkgBase = opts.name.split("/").pop();
	const tarballName = `${pkgBase}-${opts.version}.tgz`;
	const base = opts.registryUrl.replace(/\/+$/, "");
	const doc = {
		_id: opts.name,
		name: opts.name,
		"dist-tags": { latest: opts.version },
		versions: {
			[opts.version]: {
				...opts.manifest,
				_id: `${opts.name}@${opts.version}`,
				name: opts.name,
				version: opts.version,
				dist: {
					tarball: `${base}/${opts.name}/-/${tarballName}`,
					shasum: sha1Hex(bytes),
					integrity: sha512Integrity(bytes),
				},
			},
		},
		access: "public",
		_attachments: {
			[tarballName]: {
				content_type: "application/octet-stream",
				data: bytes.toString("base64"),
				length: bytes.length,
			},
		},
	};
	const res = await fetch(packumentUrl(opts.registryUrl, opts.name), {
		method: "PUT",
		headers: {
			authorization: `Bearer ${opts.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(doc),
	});
	return res.status;
}
