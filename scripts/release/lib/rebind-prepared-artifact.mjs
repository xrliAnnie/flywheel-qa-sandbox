import { createHash } from "node:crypto";
import {
	deriveVetoBinding,
	payloadObjectKey,
	validateManifest,
} from "../../../packages/release-contract/src/index.mjs";
import { isReleaseId } from "./release-id.mjs";

function requireValid(value) {
	if (!value) throw Error("rebind artifact identity or state invalid");
}
function sourceBinding(manifest, input) {
	requireValid(manifest && validateManifest(manifest).length === 0);
	const op = manifest.releaseOps[input.sourceReleaseId];
	requireValid(op?.kind === "release" && op.state === "abandoned");
	// Only this disposable validation copy is made prepared; the old durable op
	// remains abandoned throughout both CAS operations.
	const copy = structuredClone(manifest);
	copy.releaseOps[input.sourceReleaseId].state = "prepared";
	const binding = deriveVetoBinding(copy, input.sourceReleaseId);
	requireValid(
		createHash("sha256").update(JSON.stringify(binding)).digest("hex") ===
			input.sourceBindingDigest,
	);
	requireValid(
		!Object.hasOwn(manifest.versions, binding.releaseVersion) &&
			!manifest.tombstones.includes(op.objectKey),
	);
	const target = manifest.releaseOps[input.releaseId];
	if (target)
		requireValid(
			["reserved", "prepared"].includes(target.state) &&
				target.kind === "release" &&
				target.ver === binding.releaseVersion &&
				target.betaVersion === binding.betaVersion &&
				target.sourceCommit === binding.sourceCommit &&
				target.sha256 === binding.releasePayloadSha256 &&
				target.objectKey === op.objectKey,
		);
	return binding;
}
export async function rebindPreparedArtifact(client, input) {
	requireValid(
		input &&
			Object.keys(input).length === 3 &&
			isReleaseId(input.sourceReleaseId) &&
			isReleaseId(input.releaseId) &&
			input.releaseId !== input.sourceReleaseId &&
			typeof input.sourceBindingDigest === "string" &&
			/^[a-f0-9]{64}$/.test(input.sourceBindingDigest),
	);
	const { manifest } = await client.readManifest();
	const binding = sourceBinding(manifest, input);
	await client.readbackVerify(
		binding.releaseVersion,
		binding.releasePayloadSha256,
	);
	await client.casUpdate(
		(m, _current, { serverNowMs }) => {
			sourceBinding(m, input);
			if (m.releaseOps[input.releaseId]) return false;
			m.releaseOps[input.releaseId] = {
				kind: "release",
				state: "reserved",
				ver: binding.releaseVersion,
				betaVersion: binding.betaVersion,
				sourceCommit: binding.sourceCommit,
				sha256: binding.releasePayloadSha256,
				objectKey: payloadObjectKey(
					binding.releaseVersion,
					binding.releasePayloadSha256,
				),
				createdAt: new Date(serverNowMs).toISOString(),
			};
			return true;
		},
		"reserve-rebound-artifact",
		{ requireServerTime: true },
	);
	// The new live claim now protects these bytes from ordinary cleanup. Recheck
	// after reservation as well, including when recovering an interrupted rebind.
	const { size } = await client.readbackVerify(
		binding.releaseVersion,
		binding.releasePayloadSha256,
	);
	await client.casUpdate((m) => {
		sourceBinding(m, input);
		const target = m.releaseOps[input.releaseId];
		requireValid(target);
		if (target.state === "prepared") return false;
		target.state = "prepared";
		return true;
	}, "prepare-rebound-artifact");
	const { manifest: prepared } = await client.readManifest();
	sourceBinding(prepared, input);
	return { binding: deriveVetoBinding(prepared, input.releaseId), size };
}
