import { createHash } from "node:crypto";
import { parseInstalledTreeManifest } from "./installed-tree.js";
import { projectNativeManifest } from "./native-manifest.js";
import { readImmutableFile } from "./trusted-files.js";

export type InstallationBinding = {
	manifestSha256: string;
	bootstrapSha256: string;
};

export const INSTALLATION_METADATA_PATH =
	"/Library/Application Support/Flywheel/Xhs/installation.metadata";

/** Parsing carries no authority. Callers must authenticate the fixed root file. */
export function parseInstallationMetadata(raw: string): {
	manifestSha256: string;
	bootstrapSha256: string;
} {
	const match =
		/^version=1\nmanifest_sha256=([a-f0-9]{64})\nbootstrap_sha256=([a-f0-9]{64})\n$/.exec(
			raw,
		);
	if (!match || match[0] !== raw || !match[1] || !match[2])
		throw Error("installation_metadata_unavailable");
	return { manifestSha256: match[1], bootstrapSha256: match[2] };
}

/** Metadata lives outside runtime, so adding it cannot change the tree digest. */
export function renderInstallationMetadata(rawJson: string): string {
	try {
		const manifest = parseInstalledTreeManifest(rawJson);
		const bootstrap = manifest.entries.find(
			(entry) => entry.path === "xhs-installer-bootstrap",
		);
		if (!bootstrap || bootstrap.kind !== "file" || !(bootstrap.mode & 0o111))
			throw Error();
		const digest = createHash("sha256")
			.update(projectNativeManifest(rawJson))
			.digest("hex");
		return `version=1\nmanifest_sha256=${digest}\nbootstrap_sha256=${bootstrap.sha256}\n`;
	} catch {
		throw Error("installation_metadata_unavailable");
	}
}

export function readInstallationMetadata(
	expected?: InstallationBinding,
): InstallationBinding {
	const current = parseInstallationMetadata(
		new TextDecoder("utf-8", { fatal: true }).decode(
			readImmutableFile(INSTALLATION_METADATA_PATH, { maxBytes: 1024 }),
		),
	);
	if (
		expected &&
		(current.manifestSha256 !== expected.manifestSha256 ||
			current.bootstrapSha256 !== expected.bootstrapSha256)
	)
		throw Error("installation_metadata_unavailable");
	return current;
}
