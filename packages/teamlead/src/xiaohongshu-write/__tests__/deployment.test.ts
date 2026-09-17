import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderAuthorityDeployment } from "../deployment.js";

function fixture() {
	const base = "/Library/Application Support/Flywheel/Xhs";
	const state = "/private/var/db/flywheel-xhs";
	const pin = (name: string) => ({
		path: `${base}/${name}`,
		sha256: "a".repeat(64),
	});
	const account = {
		providerInstanceId: "provider-a",
		accountUserId: "account-a",
		accountEpoch: 1,
		providerGeneration: "generation-a",
	};
	const provider = {
		schemaVersion: 1,
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		policyVersion: 1,
		flywheelRevision: "b".repeat(40),
		providerRevision: "c".repeat(40),
		accountBase: account,
		providerBinary: pin("provider"),
		browser: pin("browser"),
		guardian: pin("guardian"),
		boundaryProbe: pin("boundary-probe"),
		ffmpeg: pin("ffmpeg"),
		ffprobe: pin("ffprobe"),
		toolSchemaDigest: "d".repeat(64),
		epochPath: `${state}/epochs`,
		journalPath: `${state}/journal`,
		mediaRoot: `${state}/media`,
		profileRoot: `${state}/profiles`,
		providerSocket: `${state}/transport/provider.sock`,
		authoritySocket: "/private/var/run/xhs-private/authority.sock",
		keyPath: `${state}/keys/permit`,
		keyId: "key-1",
		acceptancePath: `${base}/provider-acceptance.json`,
		acceptancePublicKey: Buffer.alloc(32, 1).toString("base64"),
	};
	const raw = JSON.stringify(provider);
	const policy = {
		schemaVersion: 1,
		enabled: false,
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		ingressGid: 451,
		policyVersion: 1,
		founderConfigVersion: 1,
		flywheelRevision: provider.flywheelRevision,
		providerRevision: provider.providerRevision,
		node: pin("node"),
		entry: pin("entry.js"),
		peerHelper: pin("peer"),
		launcher: pin("launcher"),
		boundaryProbe: provider.boundaryProbe,
		providerConfig: {
			...pin("provider.json"),
			sha256: createHash("sha256").update(raw).digest("hex"),
		},
		stateRoot: state,
		ledgerPath: `${state}/ledger.db`,
		artifactRoot: `${state}/artifacts`,
		botTokenPath: `${state}/keys/bot`,
		permitKeyPath: provider.keyPath,
		authoritySocket: provider.authoritySocket,
		ingressSocket: "/private/var/run/xhs-ingress/request.sock",
		acceptancePath: `${base}/acceptance.json`,
		acceptancePublicKey: provider.acceptancePublicKey,
		keyId: provider.keyId,
		registry: [
			{
				projectId: "project",
				leadId: "lead",
				account,
				founderId: "12345678901234567",
				canonicalFounderId: "12345678901234567",
				botId: "12345678901234568",
				guildId: "12345678901234569",
				channelId: "12345678901234570",
				initialCursor: "12345678901234571",
			},
		],
	};
	return { policy, provider, raw, policyPath: `${base}/authority.json` };
}
it("renders a parseable plist with launchd ownership and separate private provider directory", () => {
	const f = fixture();
	const result = renderAuthorityDeployment(
		JSON.stringify(f.policy),
		f.raw,
		f.policyPath,
	);
	const parsed = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				"import plistlib,json,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))",
			],
			{ input: result.plist, encoding: "utf8" },
		),
	);
	expect(parsed.ProgramArguments).toEqual([
		f.policy.launcher.path,
		f.policy.node.path,
		f.policy.entry.path,
		"--config",
		f.policyPath,
	]);
	expect(parsed).toMatchObject({
		UserName: "_flywheel_xhs",
		GroupName: "_flywheel_xhs",
		Umask: 63,
		ProcessType: "Background",
		Sockets: {
			Authority: {
				SockPathName: f.provider.authoritySocket,
				SockPathOwner: 0,
				SockPathGroup: 450,
				SockPathMode: 432,
				SockPassive: true,
			},
			Ingress: { SockPathGroup: 451, SockPathOwner: 0, SockPathMode: 432 },
		},
	});
	expect(result.directories).toContainEqual({
		path: "/private/var/run/xhs-private",
		uid: 0,
		gid: 450,
		mode: 0o750,
	});
	expect(result.directories).toContainEqual({
		path: "/private/var/db/flywheel-xhs/transport",
		uid: 450,
		gid: 450,
		mode: 0o700,
	});
	expect(result.files).toContainEqual(
		expect.objectContaining({
			path: f.provider.guardian.path,
			sha256: f.provider.guardian.sha256,
			uid: 0,
			mode: 0o755,
		}),
	);
});
it("preserves assembled executable modes and the Node-imported authority entry", () => {
	const f = fixture();
	const result = renderAuthorityDeployment(
		JSON.stringify(f.policy),
		f.raw,
		"/Library/Application Support/Flywheel/Xhs/authority.json",
	);
	for (const pin of [
		f.policy.node,
		f.policy.launcher,
		f.policy.peerHelper,
		f.policy.boundaryProbe,
		f.provider.providerBinary,
		f.provider.browser,
		f.provider.guardian,
		f.provider.ffmpeg,
		f.provider.ffprobe,
	])
		expect(result.files).toContainEqual(
			expect.objectContaining({ path: pin.path, mode: 0o755 }),
		);
	expect(result.files).toContainEqual(
		expect.objectContaining({ path: f.policy.entry.path, mode: 0o644 }),
	);
});

it("rejects unbound provider bytes and conflicting service/root socket directories", () => {
	const f = fixture();
	expect(() =>
		renderAuthorityDeployment(
			JSON.stringify(f.policy),
			`${f.raw} `,
			f.policyPath,
		),
	).toThrow("authority_deployment_unavailable");
	f.provider.providerSocket = "/private/var/run/xhs-private/provider.sock";
	const raw = JSON.stringify(f.provider);
	f.policy.providerConfig.sha256 = createHash("sha256")
		.update(raw)
		.digest("hex");
	expect(() =>
		renderAuthorityDeployment(JSON.stringify(f.policy), raw, f.policyPath),
	).toThrow("authority_deployment_unavailable");
});
it("escapes XML path characters without introducing plist keys", () => {
	const f = fixture();
	f.policy.entry.path =
		"/Library/Application Support/Flywheel/Xhs/a&<entry>.js";
	const result = renderAuthorityDeployment(
		JSON.stringify(f.policy),
		f.raw,
		f.policyPath,
	);
	const parsed = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				"import plistlib,json,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))",
			],
			{ input: result.plist, encoding: "utf8" },
		),
	);
	expect(parsed.ProgramArguments[2]).toBe(f.policy.entry.path);
});

it("writes an exclusive offline bundle and refuses overwrite", () => {
	const f = fixture();
	const root = mkdtempSync(`${realpathSync(tmpdir())}/xhs-deployment-`);
	try {
		const policy = join(root, "policy.json"),
			provider = join(root, "provider.json"),
			output = join(root, "bundle");
		writeFileSync(policy, JSON.stringify(f.policy));
		writeFileSync(provider, f.raw);
		const args = [
			"--import",
			"tsx",
			fileURLToPath(new URL("../deployment-entry.ts", import.meta.url)),
			"--policy-source",
			policy,
			"--provider-source",
			provider,
			"--policy-path",
			f.policyPath,
			"--output-dir",
			output,
		];
		expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toBe(
			"authority_deployment_rendered\n",
		);
		const before = readFileSync(join(output, "requirements.json"), "utf8");
		expect(JSON.parse(before).files).toContainEqual(
			expect.objectContaining({
				path: "/Library/LaunchDaemons/com.flywheel.xhs-authority.plist",
				uid: 0,
				mode: 0o644,
			}),
		);
		expect(() =>
			execFileSync(process.execPath, args, { stdio: "pipe" }),
		).toThrow();
		expect(readFileSync(join(output, "requirements.json"), "utf8")).toBe(
			before,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
