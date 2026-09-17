import { createHash } from "node:crypto";
import { projectNativeManifest } from "./native-manifest.js";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Offline serialization only. Root installation and provenance authentication
 * are separate from rendering the policy that the native launcher consumes. */
export function renderBootstrapPolicy(json: string): string {
	const native = projectNativeManifest(json);
	return `version=1\nmanifest_sha256=${sha(native)}\njson_sha256=${sha(json)}\n`;
}
/** The installed caller obtains all three files through root-immutable reads.
 * Verify raw-byte pins AND projection equality before any installer mutation.
 * This pure comparison is not a signature, approval or host acceptance API. */
export function verifyManifestProjection(
	policy: string,
	json: string,
	native: string,
) {
	try {
		if (
			Buffer.byteLength(policy) > 1024 ||
			Buffer.byteLength(json) > 4 * 1024 * 1024 ||
			Buffer.byteLength(native) > 4 * 1024 * 1024
		)
			throw Error();
		const match =
			/^version=1\nmanifest_sha256=([a-f0-9]{64})\njson_sha256=([a-f0-9]{64})\n$/.exec(
				policy,
			);
		// JS '$' also matches before a terminal newline: exact length closes that gap.
		if (
			!match ||
			match[0] !== policy ||
			match[1] !== sha(native) ||
			match[2] !== sha(json) ||
			projectNativeManifest(json) !== native
		)
			throw Error();
		return { manifestSha256: match[1], jsonSha256: match[2] };
	} catch {
		throw Error("installer_manifest_unavailable");
	}
}
