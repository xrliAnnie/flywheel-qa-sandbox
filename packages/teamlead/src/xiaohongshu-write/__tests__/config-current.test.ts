import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonical } from "../canonical.js";
import { createAuthorityConfigCurrent } from "../config-current.js";

const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: (path: string, options: { sha256?: string }) => {
		const value = files.get(path);
		if (!value) throw Error("missing");
		if (
			options.sha256 &&
			createHash("sha256").update(value).digest("hex") !== options.sha256
		)
			throw Error("changed");
		return Buffer.from(value);
	},
	readRootReceipt: (path: string) => {
		const value = files.get(path);
		if (!value) throw Error("missing");
		return Buffer.from(value);
	},
}));
it("revalidates policy, provider binding and real signed acceptance on every check", () => {
	files.clear();
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const policy = Buffer.from("root policy"),
		provider = Buffer.from("root provider");
	const digest = (bytes: Buffer) =>
		createHash("sha256").update(bytes).digest("hex");
	const config = {
		configDigest: digest(policy),
		installation: {
			manifestSha256: "1".repeat(64),
			bootstrapSha256: "2".repeat(64),
		},
		serviceUid: 450,
		boundaryProbe: { path: "/root/probe", sha256: "e".repeat(64) },
		providerConfig: { path: "/root/provider", sha256: digest(provider) },
		acceptancePath: "/root/acceptance",
		acceptancePublicKey: publicKey
			.export({ type: "spki", format: "der" })
			.subarray(-32)
			.toString("base64"),
		provider: {
			providerBinary: { sha256: "a".repeat(64) },
			toolSchemaDigest: "b".repeat(64),
		},
	};
	const statement = {
		schemaVersion: 1,
		configDigest: config.configDigest,
		providerBinarySha256: config.provider.providerBinary.sha256,
		toolSchemaDigest: config.provider.toolSchemaDigest,
		probeSha256: config.boundaryProbe.sha256,
		...config.installation,
		passed: true,
		probeKind: "fixture_harness",
		hostAcceptance: false,
		notCovered: [
			"real_claude_context",
			"real_codex_context",
			"real_runner_context",
			"real_login_context",
			"process_authority",
			"privilege_paths",
			"private_transport",
			"headless_service",
			"legacy_cutover",
		],
	};
	const receipt = Buffer.from(
		JSON.stringify({
			statement,
			signature: sign(
				null,
				Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(statement)}`),
				privateKey,
			).toString("base64"),
		}),
	);
	files.set("/root/policy", policy);
	files.set("/root/provider", provider);
	files.set("/root/acceptance", receipt);
	files.set(
		"/Library/Application Support/Flywheel/Xhs/installation.metadata",
		Buffer.from(
			`version=1\nmanifest_sha256=${config.installation.manifestSha256}\nbootstrap_sha256=${config.installation.bootstrapSha256}\n`,
		),
	);
	const check = createAuthorityConfigCurrent("/root/policy", config);
	expect(() => check()).not.toThrow();
	for (const path of files.keys()) {
		const original = files.get(path)!;
		files.set(path, Buffer.from("changed"));
		expect(() => check()).toThrow("authority_configuration_changed");
		files.set(path, original);
	}
	expect(() => check()).not.toThrow();
	const replacement = { ...statement, manifestSha256: "3".repeat(64) };
	files.set(
		"/Library/Application Support/Flywheel/Xhs/installation.metadata",
		Buffer.from(
			`version=1\nmanifest_sha256=${replacement.manifestSha256}\nbootstrap_sha256=${replacement.bootstrapSha256}\n`,
		),
	);
	files.set(
		"/root/acceptance",
		Buffer.from(
			JSON.stringify({
				statement: replacement,
				signature: sign(
					null,
					Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(replacement)}`),
					privateKey,
				).toString("base64"),
			}),
		),
	);
	expect(() => check()).toThrow("authority_configuration_changed");
});
