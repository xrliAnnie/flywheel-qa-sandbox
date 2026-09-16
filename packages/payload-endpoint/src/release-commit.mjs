import {
	deriveVetoBinding,
	ENTITLEMENT_POINTER,
} from "../../release-contract/src/index.mjs";

const fields = [
	"releaseId",
	"betaVersion",
	"betaPayloadSha256",
	"releaseVersion",
	"releasePayloadSha256",
	"sourceCommit",
];
/** B1 commit mutation shared by the CLI and the decision-consuming endpoint.
 * The caller owns authorization, artifact readback, validation and exactly one CAS.
 */
export function applyPreparedReleaseCommit(
	manifest,
	expectedBinding,
	size,
	publishedAt,
) {
	if (
		!expectedBinding ||
		typeof expectedBinding !== "object" ||
		Object.keys(expectedBinding).length !== fields.length ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		typeof publishedAt !== "string" ||
		!Number.isFinite(Date.parse(publishedAt))
	) {
		throw new Error("commit metadata or binding invalid");
	}
	const binding = deriveVetoBinding(manifest, expectedBinding.releaseId);
	if (fields.some((field) => expectedBinding[field] !== binding[field])) {
		throw new Error("commit binding mismatch");
	}
	const pointer = manifest.channels?.[ENTITLEMENT_POINTER.customer];
	if (
		!pointer ||
		typeof pointer !== "object" ||
		Array.isArray(pointer) ||
		Object.hasOwn(manifest.versions, binding.releaseVersion)
	) {
		throw new Error("commit version already used or pointer missing");
	}
	const current = manifest.releaseOps[binding.releaseId];
	manifest.versions[current.ver] = {
		sha256: current.sha256,
		key: current.objectKey,
		size,
		publishedAt,
		channel: "release",
		status: "active",
		sourceCommit: current.sourceCommit,
		releaseId: binding.releaseId,
		derivedFromBeta: current.betaVersion,
		retentionSince: null,
		quarantinedAt: null,
	};
	pointer.latest = current.ver;
	for (const [otherId, other] of Object.entries(manifest.releaseOps)) {
		if (
			otherId !== binding.releaseId &&
			other.kind === "release" &&
			(other.state === "reserved" || other.state === "prepared") &&
			other.ver === current.ver
		) {
			other.state = "abandoned";
		}
	}
	current.state = "committed";
	return current.ver;
}
