/**
 * FLY-1062 broker PR · minimal endpoint client for the broker's in-process
 * publish executors — a typed port of the CAS/readback subset of
 * `scripts/release/lib/endpoint-client.mjs` (plan §B0-8/§B0-9 semantics are
 * pinned server-side by the payload-endpoint suites; this client only carries
 * them). Lives in-process so the customer-release token NEVER enters a child
 * process, argv, or the filesystem: env → this object's closure → the
 * Authorization header, nothing else.
 */

import { createHash } from "node:crypto";

export const CAS_RETRIES = 8;

export interface ReleaseOp {
	kind: "beta" | "release";
	state: "reserved" | "prepared" | "committed" | "abandoned";
	ver: string;
	betaVersion: string | null;
	sourceCommit: string | null;
	sha256: string | null;
	objectKey: string | null;
	createdAt: string;
}

export interface VersionEntry {
	sha256: string;
	key: string;
	size: number;
	publishedAt: string;
	channel: "beta" | "release";
	status: "active" | "quarantined" | "expired";
	sourceCommit: string;
	releaseId: string;
	derivedFromBeta: string | null;
	retentionSince: string | null;
	quarantinedAt: string | null;
}

export interface EndpointManifest {
	schemaVersion: number;
	channels: Record<string, { latest: string | null }>;
	versions: Record<string, VersionEntry>;
	releaseOps: Record<string, ReleaseOp>;
	releaseLedger: Record<string, { nextBetaN: number }>;
	tombstones: string[];
}

export interface EndpointClient {
	readManifest(): Promise<{
		manifest: EndpointManifest | null;
		etag: string | null;
	}>;
	/** read → mutate a deep copy → CAS POST; mutate returns false for
	 * "already done" (idempotent success) and may throw to fail closed. */
	casUpdate(
		mutate: (copy: EndpointManifest) => boolean,
		describe: string,
	): Promise<void>;
	/** stream the object back and hash it — the download path is the witness. */
	readbackVerify(ver: string, sha: string): Promise<number>;
}

export function makeEndpointClient(opts: {
	endpoint: string;
	token: string;
}): EndpointClient {
	const base = opts.endpoint.replace(/\/+$/, "");
	const token = opts.token;

	async function api(method: string, path: string, body?: unknown) {
		return fetch(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	}

	async function readManifest() {
		const res = await api("GET", "/admin/manifest");
		if (res.status === 404) return { manifest: null, etag: null };
		if (res.status !== 200) {
			throw new Error(`cannot read manifest (HTTP ${res.status})`);
		}
		return {
			manifest: (await res.json()) as EndpointManifest,
			etag: res.headers.get("etag"),
		};
	}

	async function casUpdate(
		mutate: (copy: EndpointManifest) => boolean,
		describe: string,
	): Promise<void> {
		for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
			const { manifest, etag } = await readManifest();
			if (!manifest) throw new Error(`${describe}: no manifest`);
			const copy = structuredClone(manifest);
			if (!mutate(copy)) return; // already in the target state
			const res = await api("POST", "/admin/manifest", {
				baseEtag: etag,
				manifest: copy,
			});
			if (res.status === 200) return;
			if (res.status === 412) continue; // lost the race — re-read, re-judge
			const err = (await res.json().catch(() => ({}))) as {
				error?: string;
				violations?: unknown;
			};
			throw new Error(
				`${describe}: endpoint refused (HTTP ${res.status}) ${err.error ?? ""}${
					err.violations ? ` ${JSON.stringify(err.violations)}` : ""
				}`,
			);
		}
		throw new Error(`${describe}: CAS retries exhausted`);
	}

	async function readbackVerify(ver: string, sha: string): Promise<number> {
		const res = await api(
			"GET",
			`/admin/payload/${encodeURIComponent(ver)}/${sha}`,
		);
		if (!res.ok || !res.body) {
			throw new Error(`readback ${ver} failed (HTTP ${res.status})`);
		}
		const hash = createHash("sha256");
		let size = 0;
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			size += chunk.length;
		}
		const got = hash.digest("hex");
		if (got !== sha) {
			throw new Error(`readback ${ver}: sha256 mismatch (object ${got})`);
		}
		return size;
	}

	return { readManifest, casUpdate, readbackVerify };
}
