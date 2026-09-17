import { posix } from "node:path";
import { z } from "zod";

const id = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const installedPath = z
	.string()
	.refine(
		(value) =>
			value.startsWith("/Library/Application Support/Flywheel/Xhs/") &&
			Buffer.byteLength(value) < 1024 &&
			![...value].some((character) => character.charCodeAt(0) < 32) &&
			!value.endsWith("/") &&
			posix.normalize(value) === value,
	);
const pin = z.object({ path: installedPath, sha256: digest }).strict();
const schema = z
	.object({
		serviceUid: id,
		serviceGid: id,
		modelUid: id,
		modelGid: id,
		nonce: digest,
		node: pin,
		boundaryProbe: pin,
	})
	.strict();

/** Serialization only. The root installer must obtain these values from its
 * immutable authority policy and OS identity lookup, then measure every pin.
 * Writing this text never enables authority startup or supplies acceptance. */
export function renderFixtureRunnerPolicy(
	input: z.infer<typeof schema>,
): string {
	try {
		const policy = schema.parse(input);
		if (
			policy.serviceUid === policy.modelUid ||
			policy.serviceGid === 80 ||
			policy.modelGid === policy.serviceGid
		)
			throw Error();
		return [
			"version=1",
			`service_uid=${policy.serviceUid}`,
			`service_gid=${policy.serviceGid}`,
			`model_uid=${policy.modelUid}`,
			`model_gid=${policy.modelGid}`,
			`node=${policy.node.path}`,
			`node_sha256=${policy.node.sha256}`,
			`entry=${policy.boundaryProbe.path}`,
			`entry_sha256=${policy.boundaryProbe.sha256}`,
			`fixture=/private/var/db/flywheel-xhs-qa/${policy.nonce}`,
			"",
		].join("\n");
	} catch {
		throw Error("fixture_policy_unavailable");
	}
}
