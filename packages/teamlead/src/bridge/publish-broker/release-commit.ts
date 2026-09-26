/**
 * FLY-1062 broker PR · publish-release executor — the broker-run form of
 * `payload-promote.mjs commit` (plan PR4-3 / §3): promote an already-PREPARED
 * candidate to customer-release.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO BUILD — structural contract (plan PR4-3): the founder approved the
 * candidate tuple's sha256. Nothing in this file may invoke the packer,
 * inject a version, or unpack/compare trees — the pipeline structure test
 * greps this file for those tokens.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The approval binds (releaseId, sha256): the candidate op's sha256 must equal
 * the approved sha256 LITERALLY, or nothing happens — a candidate swapped
 * after the founder approved can never ship (§3 ②).
 *
 * Idempotency = B0-9: already committed with the same sha → success; the
 * commit itself is ONE manifest CAS (entry + pointer + op→committed).
 */

import { type EndpointClient, makeEndpointClient } from "./endpoint-client.js";

export interface PublishReleaseArgs {
	releaseId: string;
	/** the sha256 the founder approval is bound to */
	sha256: string;
}

export async function executePublishRelease(
	args: PublishReleaseArgs & { endpoint: string; token: string },
): Promise<Record<string, string>> {
	const client = makeEndpointClient({
		endpoint: args.endpoint,
		token: args.token,
	});
	return executePublishReleaseWith(client, args);
}

/** Client-injected form (tests drive it against the hermetic endpoint). */
export async function executePublishReleaseWith(
	client: EndpointClient,
	args: PublishReleaseArgs,
): Promise<Record<string, string>> {
	const { manifest } = await client.readManifest();
	if (!manifest) throw new Error("no manifest — nothing published yet");
	const op = manifest.releaseOps[args.releaseId];
	if (!op || op.kind !== "release") {
		throw new Error(`no release candidate ${args.releaseId}`);
	}
	// the approval binds the artifact — literal equality, fail-closed
	if (op.sha256 !== args.sha256) {
		throw new Error(
			`candidate sha256 does not match the approved artifact (candidate ${op.sha256 ?? "null"})`,
		);
	}
	if (op.state === "committed") {
		return { ver: op.ver, idempotent: "true" }; // B0-9: rerun after success
	}
	if (op.state !== "prepared") {
		throw new Error(`candidate is ${op.state}, must be prepared`);
	}

	// re-verify the EXACT artifact the founder approved (streamed hash) and
	// take the object size for the entry's identity metadata
	const size = await client.readbackVerify(op.ver, args.sha256);

	await client.casUpdate((m) => {
		const cur = m.releaseOps[args.releaseId];
		if (!cur) throw new Error("candidate vanished — fail-closed");
		if (cur.state === "committed") return false;
		if (cur.state !== "prepared") {
			throw new Error(`cannot commit from ${cur.state}`);
		}
		if (cur.sha256 !== args.sha256) {
			throw new Error("candidate tuple changed under commit — fail-closed");
		}
		m.versions[cur.ver] = {
			sha256: cur.sha256,
			key: cur.objectKey as string,
			size,
			publishedAt: new Date().toISOString(), // server re-stamps
			channel: "release",
			status: "active",
			sourceCommit: cur.sourceCommit as string,
			releaseId: args.releaseId,
			derivedFromBeta: cur.betaVersion,
			retentionSince: null,
			quarantinedAt: null,
		};
		const channel = m.channels["customer-release"];
		if (!channel) {
			throw new Error("customer-release channel missing — fail-closed");
		}
		channel.latest = cur.ver;
		cur.state = "committed";
		return true;
	}, "commit-release");

	return { ver: op.ver };
}
