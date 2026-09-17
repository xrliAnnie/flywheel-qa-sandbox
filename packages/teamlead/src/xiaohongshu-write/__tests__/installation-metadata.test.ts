import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	parseInstallationMetadata,
	renderInstallationMetadata,
} from "../installation-metadata.js";
import { projectNativeManifest } from "../native-manifest.js";

const json = JSON.stringify({
	schemaVersion: 1,
	root: "/Library/Application Support/Flywheel/Xhs/runtime",
	entries: [
		{
			path: "xhs-installer-bootstrap",
			kind: "file",
			mode: 0o755,
			size: 7,
			sha256: "a".repeat(64),
		},
	],
});
it("binds native manifest bytes and bootstrap executable digest without config recursion", () => {
	const raw = renderInstallationMetadata(json);
	expect(parseInstallationMetadata(raw)).toEqual({
		manifestSha256: createHash("sha256")
			.update(projectNativeManifest(json))
			.digest("hex"),
		bootstrapSha256: "a".repeat(64),
	});
});
it("refuses malformed metadata and absent/nonexecutable bootstrap", () => {
	const raw = renderInstallationMetadata(json);
	for (const bad of [
		`${raw}\n`,
		raw.replace("version=1", "version=2"),
		raw.replace("bootstrap_sha256", "bootstrap_policy_sha256"),
		raw.replace(/a{64}/, "A".repeat(64)),
		raw.replace("\n", "\r\n"),
	])
		expect(() => parseInstallationMetadata(bad)).toThrow(
			"installation_metadata_unavailable",
		);
	for (const bad of [
		json.replace("xhs-installer-bootstrap", "other"),
		json.replace('"mode":493', '"mode":420'),
	])
		expect(() => renderInstallationMetadata(bad)).toThrow(
			"installation_metadata_unavailable",
		);
});
