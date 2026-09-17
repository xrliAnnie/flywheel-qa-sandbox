import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	renderBootstrapPolicy,
	verifyManifestProjection,
} from "../installer-manifests.js";
import { projectNativeManifest } from "../native-manifest.js";

const json = JSON.stringify({
	schemaVersion: 1,
	root: "/Library/Application Support/Flywheel/Xhs/runtime",
	entries: [
		{
			path: "entry.js",
			kind: "file",
			mode: 0o644,
			size: 1,
			sha256: "a".repeat(64),
		},
	],
});
const native = projectNativeManifest(json);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
it("pins both exact representations in native fixed policy grammar", () => {
	const policy = renderBootstrapPolicy(json);
	expect(policy).toBe(
		`version=1\nmanifest_sha256=${sha(native)}\njson_sha256=${sha(json)}\n`,
	);
	expect(verifyManifestProjection(policy, json, native)).toEqual({
		manifestSha256: sha(native),
		jsonSha256: sha(json),
	});
});
it.each([
	"json-bytes",
	"native-bytes",
	"policy-extra",
	"policy-crlf",
	"policy-case",
	"projection",
])("rejects %s mismatch", (mode) => {
	let policy = renderBootstrapPolicy(json),
		j = json,
		n = native;
	if (mode === "json-bytes") j += "\n";
	if (mode === "native-bytes") n = n.replace("entry.js", "entry2.js");
	if (mode === "policy-extra") policy += "passed=true\n";
	if (mode === "policy-crlf") policy = policy.replaceAll("\n", "\r\n");
	if (mode === "policy-case") policy = policy.toUpperCase();
	if (mode === "projection") {
		n = n.replace("entry.js", "entry2.js");
		policy = `version=1\nmanifest_sha256=${sha(n)}\njson_sha256=${sha(j)}\n`;
	}
	expect(() => verifyManifestProjection(policy, j, n)).toThrow(
		"installer_manifest_unavailable",
	);
});
