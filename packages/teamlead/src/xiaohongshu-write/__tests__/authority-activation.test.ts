import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { loadAuthorityConfig } from "../authority-config.js";
import { canonical } from "../canonical.js";

const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: (path: string) => {
		const value = files.get(path);
		if (!value) throw Error("missing fixture file");
		return Buffer.from(value);
	},
	readRootReceipt: (path: string) => {
		const value = files.get(path);
		if (!value) throw Error("missing fixture receipt");
		return Buffer.from(value);
	},
}));
vi.mock("../launchd-private-path.js", () => ({
	verifyPrivateAuthoritySocket: () => {},
}));
vi.mock("node:fs", () => ({
	lstatSync: (path: string) => ({
		isDirectory: () => true,
		uid: path.startsWith("/var/db/flywheel-xhs") ? 450 : 0,
		mode: path.startsWith("/var/db/flywheel-xhs") ? 0o700 : 0o755,
	}),
}));
vi.mock("node:child_process", () => ({
	execFile: Object.assign(() => {}, {
		[Symbol.for("nodejs.util.promisify.custom")]: async () => ({
			stdout: "20 451",
		}),
	}),
}));
const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
const argv = process.argv;
afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(process, "execPath", execPath);
	process.argv = argv;
	files.clear();
});
function configuration() {
	const base = "/Library/Application Support/Flywheel/Xhs";
	const state = "/var/db/flywheel-xhs";
	const pin = (name: string) => ({
		path: `${base}/${name}`,
		sha256: "a".repeat(64),
	});
	return {
		schemaVersion: 1,
		enabled: false,
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		ingressGid: 451,
		policyVersion: 1,
		founderConfigVersion: 1,
		flywheelRevision: "b".repeat(40),
		providerRevision: "c".repeat(40),
		node: pin("node"),
		entry: pin("authority-main.js"),
		peerHelper: pin("peer-helper"),
		launcher: pin("authority-launcher"),
		boundaryProbe: pin("boundary-probe"),
		providerConfig: pin("provider.json"),
		stateRoot: state,
		ledgerPath: `${state}/ledger.db`,
		artifactRoot: `${state}/artifacts`,
		botTokenPath: `${state}/keys/card-bot`,
		permitKeyPath: `${state}/keys/permit`,
		authoritySocket: "/var/run/flywheel-xhs/authority.sock",
		ingressSocket: "/var/run/flywheel-xhs-ingress/request.sock",
		acceptancePath: `${base}/acceptance.json`,
		acceptancePublicKey: Buffer.alloc(32, 1).toString("base64"),
		keyId: "key-1",
		registry: [
			{
				projectId: "flywheel",
				leadId: "raya",
				account: {
					providerInstanceId: "xhs-1",
					accountUserId: "account-1",
					accountEpoch: 1,
					providerGeneration: "generation-1",
				},
				founderId: "12345678901234567",
				canonicalFounderId: "12345678901234567",
				botId: "12345678901234568",
				guildId: "12345678901234569",
				channelId: "12345678901234570",
				initialCursor: "12345678901234571",
			},
		],
	};
}

it.each([false, true])(
	"valid fixture signature with enabled=%s cannot grant production activation",
	async (enabled) => {
		const config = configuration();
		config.enabled = enabled;
		const provider = {
			schemaVersion: 1,
			serviceUid: config.serviceUid,
			serviceGid: config.serviceGid,
			modelUid: config.modelUid,
			policyVersion: config.policyVersion,
			flywheelRevision: config.flywheelRevision,
			providerRevision: config.providerRevision,
			accountBase: config.registry[0]!.account,
			providerBinary: config.node,
			browser: config.node,
			boundaryProbe: config.boundaryProbe,
			guardian: {
				path: "/Library/Application Support/Flywheel/Xhs/guardian",
				sha256: "f".repeat(64),
			},
			ffmpeg: config.node,
			ffprobe: config.node,
			toolSchemaDigest: "d".repeat(64),
			epochPath: `${config.stateRoot}/epochs`,
			journalPath: `${config.stateRoot}/journal`,
			mediaRoot: `${config.stateRoot}/media`,
			profileRoot: `${config.stateRoot}/profiles`,
			providerSocket: "/var/run/flywheel-xhs/provider.sock",
			authoritySocket: config.authoritySocket,
			keyPath: config.permitKeyPath,
			keyId: config.keyId,
			acceptancePath:
				"/Library/Application Support/Flywheel/Xhs/provider-acceptance.json",
			acceptancePublicKey: config.acceptancePublicKey,
		};
		const keys = generateKeyPairSync("ed25519");
		config.acceptancePublicKey = Buffer.from(
			keys.publicKey.export({ format: "jwk" }).x!,
			"base64url",
		).toString("base64");
		provider.acceptancePublicKey = config.acceptancePublicKey;
		const raw = Buffer.from(JSON.stringify(config));
		const statement = {
			schemaVersion: 1,
			configDigest: createHash("sha256").update(raw).digest("hex"),
			providerBinarySha256: provider.providerBinary.sha256,
			toolSchemaDigest: provider.toolSchemaDigest,
			probeSha256: config.boundaryProbe.sha256,
			manifestSha256: "1".repeat(64),
			bootstrapSha256: "2".repeat(64),
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
			passed: true,
		};
		files.set("/fixture/authority.json", raw);
		files.set(
			config.providerConfig.path,
			Buffer.from(JSON.stringify(provider)),
		);
		files.set(
			config.acceptancePath,
			Buffer.from(
				JSON.stringify({
					statement,
					signature: sign(
						null,
						Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(statement)}`),
						keys.privateKey,
					).toString("base64"),
				}),
			),
		);
		files.set(
			"/Library/Application Support/Flywheel/Xhs/installation.metadata",
			Buffer.from(
				`version=1\nmanifest_sha256=${statement.manifestSha256}\nbootstrap_sha256=${statement.bootstrapSha256}\n`,
			),
		);
		for (const pin of [
			config.node,
			config.entry,
			config.peerHelper,
			config.launcher,
			provider.providerBinary,
			provider.browser,
			provider.guardian,
			provider.boundaryProbe,
			provider.ffmpeg,
			provider.ffprobe,
		])
			files.set(pin.path, Buffer.from("pinned fixture"));
		vi.spyOn(process, "getuid").mockReturnValue(450);
		vi.spyOn(process, "getgid").mockReturnValue(450);
		vi.spyOn(process, "getgroups").mockReturnValue([450]);
		Object.defineProperty(process, "execPath", {
			...execPath,
			value: config.node.path,
		});
		process.argv = [config.node.path, config.entry.path];
		if (enabled)
			await expect(
				loadAuthorityConfig("/fixture/authority.json"),
			).rejects.toThrow("host_activation_receipt_absent");
		else
			await expect(
				loadAuthorityConfig("/fixture/authority.json"),
			).resolves.toMatchObject({ enabled: false });
	},
);
