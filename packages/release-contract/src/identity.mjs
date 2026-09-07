import {
	isCleanSemver,
	isHex,
	parsePayloadVersion,
	payloadObjectKey,
} from "./grammar.mjs";

function requireManifestObject(manifest) {
	if (
		manifest === null ||
		typeof manifest !== "object" ||
		Array.isArray(manifest)
	) {
		throw new Error("manifest must be an object");
	}
}

export function deriveBetaCandidate(manifest, betaVersion) {
	requireManifestObject(manifest);
	const parsed = parsePayloadVersion(betaVersion);
	if (!parsed || parsed.kind !== "beta") {
		throw new Error(`beta version is invalid: ${String(betaVersion)}`);
	}
	const entry = manifest.versions?.[betaVersion];
	if (!entry || typeof entry !== "object") {
		throw new Error(`beta candidate ${betaVersion} is missing`);
	}
	if (entry.channel !== "beta") {
		throw new Error(`beta candidate ${betaVersion} must have channel beta`);
	}
	if (entry.status !== "active") {
		throw new Error(`beta candidate ${betaVersion} must be active`);
	}
	if (!isHex(entry.sourceCommit, 40) || !isHex(entry.sha256, 64)) {
		throw new Error(`beta candidate ${betaVersion} has an incomplete identity`);
	}
	return {
		baseVersion: parsed.base,
		betaN: parsed.betaN,
		betaVersion,
		sourceCommit: entry.sourceCommit,
		betaPayloadSha256: entry.sha256,
	};
}

export function deriveReleaseArtifact(manifest, releaseId) {
	requireManifestObject(manifest);
	const operation = manifest.releaseOps?.[releaseId];
	if (!operation || typeof operation !== "object") {
		throw new Error(`release operation ${String(releaseId)} is missing`);
	}
	if (operation.kind !== "release") {
		throw new Error(`release operation ${releaseId} must have kind release`);
	}
	if (operation.state !== "prepared") {
		throw new Error(`release operation ${releaseId} must have state prepared`);
	}
	if (
		!isCleanSemver(operation.ver) ||
		!isHex(operation.sourceCommit, 40) ||
		!isHex(operation.sha256, 64) ||
		typeof operation.objectKey !== "string"
	) {
		throw new Error(
			`release operation ${releaseId} must carry a complete tuple`,
		);
	}
	if (
		operation.objectKey !== payloadObjectKey(operation.ver, operation.sha256)
	) {
		throw new Error(`release operation ${releaseId} has an invalid object key`);
	}
	return {
		releaseId,
		releaseVersion: operation.ver,
		sourceCommit: operation.sourceCommit,
		releasePayloadSha256: operation.sha256,
		objectKey: operation.objectKey,
	};
}

export function deriveVetoBinding(manifest, releaseId) {
	const artifact = deriveReleaseArtifact(manifest, releaseId);
	const betaVersion = manifest.releaseOps[releaseId].betaVersion;
	const candidate = deriveBetaCandidate(manifest, betaVersion);
	if (candidate.baseVersion !== artifact.releaseVersion) {
		throw new Error(
			`veto binding base mismatch: ${candidate.baseVersion} != ${artifact.releaseVersion}`,
		);
	}
	if (candidate.sourceCommit !== artifact.sourceCommit) {
		throw new Error("veto binding sourceCommit mismatch");
	}
	return {
		releaseId,
		betaVersion: candidate.betaVersion,
		betaPayloadSha256: candidate.betaPayloadSha256,
		releaseVersion: artifact.releaseVersion,
		releasePayloadSha256: artifact.releasePayloadSha256,
		sourceCommit: artifact.sourceCommit,
	};
}
