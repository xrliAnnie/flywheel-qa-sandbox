import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyBoundaryAcceptance } from "../boundary-acceptance.js";
import { renderInstallationMetadata } from "../installation-metadata.js";
import { runInstalledFixture } from "../installer-main.js";
import { renderBootstrapPolicy } from "../installer-manifests.js";
import { projectNativeManifest } from "../native-manifest.js";

const root = "/Library/Application Support/Flywheel/Xhs",
	runtime = `${root}/runtime`;
const f = vi.hoisted(() => ({
	uid: 0,
	files: new Map<string, string>(),
	runs: [] as unknown[],
	saved: [] as unknown[],
	signed: [] as { path: string; raw: string }[],
	changeProvider: false,
	keyMode: 0,
	failSignatureAt: 0,
	failEvidence: false,
	failRun: false,
	changeConfig: false,
	changeMetadata: false,
	failTree: false,
	provider: {
		providerBinary: { path: "", sha256: "" },
		browser: { path: "", sha256: "" },
		guardian: { path: "", sha256: "" },
		boundaryProbe: { path: "", sha256: "" },
		ffmpeg: { path: "", sha256: "" },
		ffprobe: { path: "", sha256: "" },
		toolSchemaDigest: "",
		acceptancePath: "",
		acceptancePublicKey: "",
	},
	config: {
		enabled: false,
		providerConfig: { path: "", sha256: "" },
		acceptancePath: "",
		acceptancePublicKey: "",
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		node: { path: "", sha256: "" },
		peerHelper: { path: "", sha256: "" },
		boundaryProbe: { path: "", sha256: "" },
	},
}));
vi.mock("../authority-config.js", () => ({
	parseAuthorityConfig: () => f.config,
	verifyProviderConfigBinding: () => f.provider,
}));
vi.mock("../trusted-files.js", async () => {
	const { createHash } = await import("node:crypto");
	return {
		readImmutableFile: (
			path: string,
			options: { sha256?: string; mode?: number },
		) => {
			if (path.endsWith("/boundary-signing.key")) f.keyMode = options.mode ?? 0;
			const raw = f.files.get(path);
			if (
				raw === undefined ||
				(options.sha256 &&
					createHash("sha256").update(raw).digest("hex") !== options.sha256)
			)
				throw Error("pin mismatch");
			return Buffer.from(raw);
		},
	};
});
vi.mock("../installed-tree.js", async (original) => ({
	...(await original<typeof import("../installed-tree.js")>()),
	verifyInstalledTree: () => {
		if (f.failTree) throw Error();
		return { root: "/Library/Application Support/Flywheel/Xhs/runtime" };
	},
}));
vi.mock("../fixture-orchestrator.js", () => ({
	runInstallerFixture: async (input: unknown) => {
		f.runs.push(input);
		if (f.failRun) throw Error();
		if (f.changeConfig)
			f.files.set(
				"/Library/Application Support/Flywheel/Xhs/authority.json",
				"changed during probes",
			);
		if (f.changeProvider) f.files.set(f.config.providerConfig.path, "changed");
		if (f.changeMetadata)
			f.files.set(
				"/Library/Application Support/Flywheel/Xhs/installation.metadata",
				"changed during probes",
			);
		return {
			schemaVersion: 1,
			probeKind: "fixture_harness",
			hostAcceptance: false,
			evidence: { test: true },
		};
	},
}));
vi.mock("../fixture-provision.js", () => ({
	persistFixtureSignature: (path: string, raw: string) => {
		if (f.signed.length + 1 === f.failSignatureAt) throw Error("disk failure");
		f.signed.push({ path, raw });
		return createHash("sha256").update(raw).digest("hex");
	},
	persistFixtureObservations: (nonce: string, raw: string) => {
		if (f.failEvidence) throw Error("evidence disk failure");
		f.saved.push({ nonce, raw });
		return "f".repeat(64);
	},
}));
const originalExec = Object.getOwnPropertyDescriptor(process, "execPath")!;
beforeEach(() => {
	f.uid = 0;
	f.files.clear();
	f.runs = [];
	f.saved = [];
	f.signed = [];
	f.changeProvider = false;
	f.keyMode = 0;
	f.failSignatureAt = 0;
	f.failEvidence = false;
	f.failRun = false;
	f.changeConfig = false;
	f.changeMetadata = false;
	f.failTree = false;
	vi.spyOn(process, "getuid").mockImplementation(() => f.uid);
	vi.spyOn(process, "geteuid").mockImplementation(() => f.uid);
	Object.defineProperty(process, "execPath", {
		...originalExec,
		value: `${runtime}/node`,
	});
	const authority = "root-owned authority config",
		installer = JSON.stringify({
			schemaVersion: 1,
			authorityConfigSha256: createHash("sha256")
				.update(authority)
				.digest("hex"),
			modelGid: 20,
		});
	const pin = "b".repeat(64);
	const keys = generateKeyPairSync("ed25519");
	const publicKey = Buffer.from(
		keys.publicKey.export({ format: "jwk" }).x!,
		"base64url",
	).toString("base64");
	f.files.set(
		`${root}/boundary-signing.key`,
		keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	);
	const providerRaw = "root-owned provider config";
	f.config = {
		enabled: false,
		providerConfig: {
			path: `${root}/provider.json`,
			sha256: createHash("sha256").update(providerRaw).digest("hex"),
		},
		acceptancePath: `${root}/acceptance.json`,
		acceptancePublicKey: publicKey,
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		node: { path: `${runtime}/node`, sha256: pin },
		peerHelper: { path: `${runtime}/peer`, sha256: pin },
		boundaryProbe: { path: `${runtime}/probe.js`, sha256: pin },
	};
	f.provider = {
		providerBinary: f.config.node,
		browser: f.config.node,
		guardian: f.config.peerHelper,
		boundaryProbe: f.config.boundaryProbe,
		ffmpeg: f.config.node,
		ffprobe: f.config.node,
		toolSchemaDigest: "c".repeat(64),
		acceptancePath: `${root}/provider-acceptance.json`,
		acceptancePublicKey: publicKey,
	};
	f.files.set(f.config.providerConfig.path, providerRaw);
	const json = JSON.stringify({
		schemaVersion: 1,
		root: runtime,
		entries: [
			"node",
			"installer-entry.js",
			"xhs-fixture-principal",
			"xhs-installer-bootstrap",
			"peer",
			"probe.js",
			"fixture-installer.json",
		].map((path) => ({
			path,
			kind: "file",
			mode: path === "node" || path.startsWith("xhs-") ? 0o555 : 0o644,
			size: 1,
			sha256:
				path === "fixture-installer.json"
					? createHash("sha256").update(installer).digest("hex")
					: pin,
		})),
	});
	f.files.set(`${root}/runtime.manifest.json`, json);
	f.files.set(
		`${root}/installation.metadata`,
		renderInstallationMetadata(json),
	);
	f.files.set(`${root}/runtime.manifest`, projectNativeManifest(json));
	f.files.set(
		`${root}/installer-bootstrap.policy`,
		renderBootstrapPolicy(json),
	);
	f.files.set(`${root}/authority.json`, authority);
	f.files.set(`${runtime}/fixture-installer.json`, installer);
});
afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(process, "execPath", originalExec);
});
it("binds installed pins/config before running once and persisting observations", async () => {
	expect(await runInstalledFixture()).toMatchObject({
		hostAcceptance: false,
		probeKind: "fixture_harness",
		receiptSha256: "f".repeat(64),
	});
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toHaveLength(1);
	expect(f.runs[0]).toMatchObject({
		serviceUid: 450,
		modelUid: 501,
		modelGid: 20,
		principalRunner: { path: `${runtime}/xhs-fixture-principal` },
	});
	expect(JSON.stringify(f.saved)).toContain("authorityConfigSha256");
	const saved = f.saved[0] as { raw: string };
	expect(JSON.parse(saved.raw)).toMatchObject({
		bootstrapSha256: "b".repeat(64),
		manifestSha256: createHash("sha256")
			.update(f.files.get(`${root}/runtime.manifest`)!)
			.digest("hex"),
	});
});
it.each([
	"uid",
	"node",
	"tree",
	"projection",
	"authority",
	"outside-pin",
	"wrong-pin",
	"installation-metadata",
])("rejects %s before mutation", async (mode) => {
	if (mode === "uid") f.uid = 501;
	if (mode === "node")
		Object.defineProperty(process, "execPath", {
			...originalExec,
			value: "/tmp/node",
		});
	if (mode === "tree") f.failTree = true;
	if (mode === "projection") f.files.set(`${root}/runtime.manifest`, "invalid");
	if (mode === "authority") f.files.set(`${root}/authority.json`, "changed");
	if (mode === "outside-pin") f.config.peerHelper.path = "/tmp/peer";
	if (mode === "wrong-pin") f.config.boundaryProbe.sha256 = "c".repeat(64);
	if (mode === "installation-metadata")
		f.files.set(`${root}/installation.metadata`, "changed");
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.runs).toEqual([]);
	expect(f.saved).toEqual([]);
});
it("does not retry or persist success on probe failure", async () => {
	f.failRun = true;
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toEqual([]);
});

it("retains the fixture without a success receipt if authority policy changes during probes", async () => {
	f.changeConfig = true;
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toEqual([]);
});

it("refuses persistence if installation metadata changes during probes", async () => {
	f.changeMetadata = true;
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toEqual([]);
});

it("signs only freshly collected fixture results for both pinned policies", async () => {
	const result = await runInstalledFixture();
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toHaveLength(1);
	expect(f.signed).toHaveLength(2);
	expect(f.keyMode).toBe(0o600);
	expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
	for (const row of f.signed) {
		const configRaw = f.files.get(
			row.path === f.config.acceptancePath
				? `${root}/authority.json`
				: f.config.providerConfig.path,
		)!;
		const metadata = JSON.parse((f.saved[0] as { raw: string }).raw);
		expect(() =>
			verifyBoundaryAcceptance(row.raw, {
				publicKey: f.config.acceptancePublicKey,
				configDigest: createHash("sha256").update(configRaw).digest("hex"),
				providerBinarySha256: f.provider.providerBinary.sha256,
				toolSchemaDigest: f.provider.toolSchemaDigest,
				probeSha256: f.config.boundaryProbe.sha256,
				manifestSha256: metadata.manifestSha256,
				bootstrapSha256: metadata.bootstrapSha256,
			}),
		).not.toThrow();
	}
});
it.each([
	"missing-key",
	"wrong-key",
	"provider-drift",
	"enabled",
	"provider-pin",
])("refuses signatures for %s", async (mode) => {
	if (mode === "missing-key") f.files.delete(`${root}/boundary-signing.key`);
	if (mode === "wrong-key")
		f.config.acceptancePublicKey = Buffer.alloc(32, 3).toString("base64");
	if (mode === "provider-drift") f.changeProvider = true;
	if (mode === "enabled") f.config.enabled = true;
	if (mode === "provider-pin")
		f.provider.browser = {
			path: `${runtime}/unmeasured-browser`,
			sha256: "b".repeat(64),
		};
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.signed).toEqual([]);
});
it("retains the first signature and reports failure if the second publication fails", async () => {
	f.failSignatureAt = 2;
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.signed).toHaveLength(1);
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toHaveLength(1);
});

it("cannot issue signatures after failed evidence persistence", async () => {
	f.failEvidence = true;
	await expect(runInstalledFixture()).rejects.toThrow(
		"installed_fixture_unavailable",
	);
	expect(f.runs).toHaveLength(1);
	expect(f.saved).toEqual([]);
	expect(f.signed).toEqual([]);
	expect(f.keyMode).toBe(0);
});
