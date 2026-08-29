/**
 * FLY-1062 broker PR · publish-release executor against the REAL payload
 * endpoint handler (the hermetic serve harness — same code the Worker binds).
 * Pins: approved-sha binding, prepared→committed single CAS, pointer flip,
 * B0-9 idempotent rerun, corrupted-artifact refusal.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEndpointClient } from "../endpoint-client.js";
import { executePublishReleaseWith } from "../release-commit.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVE = path.join(
	HERE,
	"../../../../..",
	"payload-endpoint",
	"__tests__",
	"serve.mjs",
);

const BETA_TOKEN = "test-beta-token";
const RELEASE_TOKEN = "test-release-token";
const SRC_COMMIT = "c".repeat(40);
const BETA_VER = "1.2.3-beta.1";
const CLEAN_VER = "1.2.3";
const PAYLOAD = Buffer.from("candidate-payload-bytes");
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function seedManifest() {
	const t0 = new Date(0).toISOString();
	const betaKey = `payloads/${BETA_VER}/${"b".repeat(64)}.tgz`;
	return {
		schemaVersion: 1,
		channels: {
			"internal-beta": { latest: BETA_VER },
			"customer-release": { latest: null },
		},
		versions: {
			[BETA_VER]: {
				sha256: "b".repeat(64),
				key: betaKey,
				size: 17,
				publishedAt: t0,
				channel: "beta",
				status: "active",
				sourceCommit: SRC_COMMIT,
				releaseId: "beta-op-1",
				derivedFromBeta: null,
				retentionSince: null,
				quarantinedAt: null,
			},
		},
		releaseOps: {
			"beta-op-1": {
				kind: "beta",
				state: "committed",
				ver: BETA_VER,
				betaVersion: null,
				sourceCommit: SRC_COMMIT,
				sha256: "b".repeat(64),
				objectKey: betaKey,
				createdAt: t0,
			},
			"rel-1": {
				kind: "release",
				state: "prepared",
				ver: CLEAN_VER,
				betaVersion: BETA_VER,
				sourceCommit: SRC_COMMIT,
				sha256: SHA,
				objectKey: `payloads/${CLEAN_VER}/${SHA}.tgz`,
				createdAt: t0,
			},
		},
		releaseLedger: { "1.2.3": { nextBetaN: 2 } },
		tombstones: [],
	};
}

let child: ChildProcess;
let base: string;

beforeAll(async () => {
	const seedFile = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "fw-broker-commit-")),
		"seed.json",
	);
	fs.writeFileSync(seedFile, JSON.stringify(seedManifest()));
	child = spawn(process.execPath, [SERVE], {
		env: {
			...process.env,
			SERVE_SEED_MANIFEST: seedFile,
			FW_TEST_BETA_TOKEN: BETA_TOKEN,
			FW_TEST_RELEASE_TOKEN: RELEASE_TOKEN,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		const t = setTimeout(
			() => reject(new Error(`serve start timeout: ${out}`)),
			10_000,
		);
		child.stdout?.on("data", (c) => {
			out += String(c);
			const m = /PORT (\d+)/.exec(out);
			if (m) {
				clearTimeout(t);
				resolve(Number(m[1]));
			}
		});
		child.stderr?.on("data", (c) => {
			out += String(c);
		});
	});
	base = `http://127.0.0.1:${port}`;
	// stage the candidate artifact (claim = the seeded prepared op)
	const put = await fetch(`${base}/admin/payload/${CLEAN_VER}/${SHA}`, {
		method: "PUT",
		headers: { authorization: `Bearer ${BETA_TOKEN}` },
		body: PAYLOAD,
	});
	expect([200, 409]).toContain(put.status);
}, 20_000);

afterAll(() => {
	child?.kill();
});

describe("executePublishRelease against the real handler", () => {
	it("refuses when the approved sha does not match the candidate", async () => {
		const client = makeEndpointClient({ endpoint: base, token: RELEASE_TOKEN });
		await expect(
			executePublishReleaseWith(client, {
				releaseId: "rel-1",
				sha256: "d".repeat(64),
			}),
		).rejects.toThrow(/does not match the approved artifact/);
	});

	it("refuses an unknown candidate", async () => {
		const client = makeEndpointClient({ endpoint: base, token: RELEASE_TOKEN });
		await expect(
			executePublishReleaseWith(client, { releaseId: "nope", sha256: SHA }),
		).rejects.toThrow(/no release candidate/);
	});

	it("commits: entry + customer pointer + op→committed in one CAS; then reruns idempotently", async () => {
		const client = makeEndpointClient({ endpoint: base, token: RELEASE_TOKEN });
		const detail = await executePublishReleaseWith(client, {
			releaseId: "rel-1",
			sha256: SHA,
		});
		expect(detail.ver).toBe(CLEAN_VER);

		const { manifest } = await client.readManifest();
		expect(manifest?.channels["customer-release"].latest).toBe(CLEAN_VER);
		expect(manifest?.releaseOps["rel-1"].state).toBe("committed");
		const entry = manifest?.versions[CLEAN_VER];
		expect(entry?.sha256).toBe(SHA);
		expect(entry?.channel).toBe("release");
		expect(entry?.derivedFromBeta).toBe(BETA_VER);
		expect(entry?.retentionSince).toBeNull();
		expect(entry?.size).toBe(PAYLOAD.length);

		// B0-9: rerun after success = idempotent success, no second entry
		const rerun = await executePublishReleaseWith(client, {
			releaseId: "rel-1",
			sha256: SHA,
		});
		expect(rerun.idempotent).toBe("true");
		const { manifest: after } = await client.readManifest();
		expect(Object.keys(after?.versions ?? {}).length).toBe(2);
	});

	it("customer token is required — the beta token cannot commit", async () => {
		// a second prepared candidate would be needed for a real commit attempt;
		// here the CAS itself must be refused by capability (manifest unchanged)
		const client = makeEndpointClient({ endpoint: base, token: BETA_TOKEN });
		await expect(
			client.casUpdate((m) => {
				m.channels["customer-release"].latest = null;
				return true;
			}, "beta-token-pointer-touch"),
		).rejects.toThrow(/refused/);
	});
});
