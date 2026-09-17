import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { assembleConfiguration } from "../../../../../scripts/xhs/assemble-config.js";

const trusted = vi.hoisted(() => ({
	raw: "",
	fail: false,
	failRecheck: false,
	failCopy: false,
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: (_path: string, options: { sha256?: string }) => {
		if (trusted.fail || (trusted.failRecheck && options.sha256)) throw Error();
		return Buffer.from(trusted.raw);
	},
}));
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	return {
		...real,
		writeSync: (
			fd: number,
			bytes: Uint8Array,
			offset: number,
			length: number,
		) => {
			if (trusted.failCopy) throw Error("copy failure");
			return real.writeSync(fd, bytes, offset, length);
		},
	};
});
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const base = "/Library/Application Support/Flywheel/Xhs";
	const state = "/private/var/db/flywheel-xhs";
	const pin = (name: string) => ({
		path: `${base}/runtime/${({ "entry.js": "packages/teamlead/dist/xiaohongshu-write/authority-main.js", "boundary-probe": "packages/teamlead/dist/xiaohongshu-write/boundary-probe-entry.js", peer: "xhs-peer-credentials", launcher: "xhs-authority-launcher", provider: "xiaohongshu-provider", guardian: "xhs-browser-guardian" } as Record<string, string>)[name] ?? name}`,
		sha256: createHash("sha256").update("fixture-runtime").digest("hex"),
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
			path: `${base}/provider.json`,
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
function setup() {
	const f = fixture(),
		dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-assemble-`);
	dirs.push(dir);
	const tree = join(dir, "tree"),
		output = join(dir, "output");
	mkdirSync(tree);
	const paths = [
		f.policy.node,
		f.policy.entry,
		f.policy.peerHelper,
		f.policy.launcher,
		f.policy.boundaryProbe,
		f.provider.providerBinary,
		f.provider.browser,
		f.provider.guardian,
		f.provider.ffmpeg,
		f.provider.ffprobe,
	].map((p) => p.path.split("/runtime/")[1]!);
	paths.push(
		"installer-entry.js",
		"xhs-installer-bootstrap",
		"xhs-fixture-principal",
		"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
		"node_modules/better-sqlite3/package.json",
		"node_modules/better-sqlite3/lib/index.js",
		"node_modules/bindings/bindings.js",
		"node_modules/file-uri-to-path/index.js",
		"package.json",
	);
	for (const path of new Set(paths)) {
		const dest = join(tree, path);
		mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
		writeFileSync(dest, "fixture-runtime", {
			mode:
				path === f.policy.entry.path.split("/runtime/")[1] ||
				path.includes("node_modules/") ||
				path === "package.json" ||
				path === "installer-entry.js"
					? 0o644
					: 0o755,
		});
	}
	const qa = {
		schemaVersion: 1,
		targetHostId: "qa-isolated-host-a",
		platform: "darwin",
		architecture: "arm64",
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		modelGid: 20,
		ingressGid: 451,
		acceptancePublicKey: f.policy.acceptancePublicKey,
	};
	trusted.raw = JSON.stringify(qa);
	trusted.fail = false;
	trusted.failRecheck = false;
	trusted.failCopy = false;
	const authority = join(dir, "authority.json"),
		provider = join(dir, "provider.json");
	writeFileSync(authority, JSON.stringify(f.policy));
	writeFileSync(provider, f.raw);
	return { ...f, dir, tree, output, authority, provider, qa };
}
it("builds a complete offline candidate with bound config and measured runtime", () => {
	const f = setup();
	const result = assembleConfiguration(
		f.tree,
		f.authority,
		f.provider,
		"/root/qa-public.json",
		f.output,
	);
	expect(result.hostAcceptance).toBe(false);
	expect(result.configurationComplete).toBe(true);
	const requirements = JSON.parse(
		readFileSync(join(f.output, "requirements.json"), "utf8"),
	);
	expect(requirements.files).toContainEqual(
		expect.objectContaining({
			path: "/Library/Application Support/Flywheel/Xhs/boundary-signing.key",
			uid: 0,
			gid: 0,
			mode: 0o600,
		}),
	);
	expect(requirements.files).toContainEqual(
		expect.objectContaining({
			path: "/Library/Application Support/Flywheel/Xhs/installation.metadata",
			uid: 0,
			gid: 0,
			mode: 0o644,
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		}),
	);
	expect(
		JSON.parse(
			readFileSync(join(f.output, "runtime/fixture-installer.json"), "utf8"),
		),
	).toEqual({
		schemaVersion: 1,
		authorityConfigSha256: createHash("sha256")
			.update(JSON.stringify(f.policy))
			.digest("hex"),
		modelGid: 20,
	});
	const manifest = JSON.parse(
		readFileSync(join(f.output, "install/runtime.manifest.json"), "utf8"),
	);
	expect(manifest.entries).toContainEqual(
		expect.objectContaining({
			path: "fixture-installer.json",
			kind: "file",
			mode: 0o644,
		}),
	);
	expect(readFileSync(join(f.output, "install/authority.json"), "utf8")).toBe(
		JSON.stringify(f.policy),
	);
	expect(existsSync(join(f.output, "install/boundary-signing.key"))).toBe(
		false,
	);
	expect(() =>
		assembleConfiguration(
			f.tree,
			f.authority,
			f.provider,
			"/root/qa-public.json",
			f.output,
		),
	).toThrow("offline_configuration_unavailable");
});
it.each([
	"missing-trust",
	"wrong-key",
	"wrong-host",
	"private-key",
	"enabled",
	"bad-provider",
	"bad-pin",
	"missing-runtime",
	"outside-pin",
	"wrong-mode",
	"secret-config",
])("refuses %s finalization", (mode) => {
	const f = setup();
	if (mode === "missing-trust") trusted.fail = true;
	if (mode === "wrong-key")
		f.qa.acceptancePublicKey = Buffer.alloc(32, 2).toString("base64");
	if (mode === "wrong-host") f.qa.modelUid = 502;
	if (mode === "private-key")
		Object.assign(f.qa, { privateKey: "not accepted" });
	if (mode === "enabled") {
		f.policy.enabled = true;
		writeFileSync(f.authority, JSON.stringify(f.policy));
	}
	if (mode === "bad-provider") writeFileSync(f.provider, "{}");
	if (mode === "bad-pin") writeFileSync(join(f.tree, "node"), "changed");
	if (mode === "outside-pin") {
		f.policy.peerHelper.path = "/outside/runtime/peer";
		writeFileSync(f.authority, JSON.stringify(f.policy));
	}
	if (mode === "wrong-mode") chmodSync(join(f.tree, "node"), 0o644);
	if (mode === "secret-config")
		writeFileSync(
			f.authority,
			JSON.stringify({ ...f.policy, privateKey: "never accepted" }),
		);
	if (mode === "missing-runtime")
		rmSync(join(f.tree, "xhs-installer-bootstrap"));
	trusted.raw = JSON.stringify(f.qa);
	expect(() =>
		assembleConfiguration(
			f.tree,
			f.authority,
			f.provider,
			"/root/qa-public.json",
			f.output,
		),
	).toThrow("offline_configuration_unavailable");
	expect(existsSync(join(f.output, "artifact.json"))).toBe(false);
});
it("the actual CLI rejects model-owned QA bindings before producing output", () => {
	const f = setup(),
		qa = join(f.dir, "qa.json");
	writeFileSync(qa, trusted.raw);
	chmodSync(qa, 0o644);
	const script = fileURLToPath(
		new URL("../../../../../scripts/xhs/assemble-config.ts", import.meta.url),
	);
	const r = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			script,
			"--runtime-tree",
			f.tree,
			"--authority-source",
			f.authority,
			"--provider-source",
			f.provider,
			"--qa-public-bindings",
			qa,
			"--output-dir",
			f.output,
		],
		{ encoding: "utf8", timeout: 10000 },
	);
	expect(r.status).toBe(1);
	expect(r.stderr).toBe("offline_configuration_unavailable\n");
	expect(existsSync(f.output)).toBe(false);
});

it.each(["qa-drift", "copy-failure"])(
	"retains partial output without completion after %s",
	(mode) => {
		const f = setup();
		trusted.failRecheck = mode === "qa-drift";
		trusted.failCopy = mode === "copy-failure";
		expect(() =>
			assembleConfiguration(
				f.tree,
				f.authority,
				f.provider,
				"/root/qa-public.json",
				f.output,
			),
		).toThrow("offline_configuration_unavailable");
		expect(existsSync(f.output)).toBe(true);
		expect(existsSync(join(f.output, "artifact.json"))).toBe(false);
		trusted.failRecheck = false;
		trusted.failCopy = false;
		expect(() =>
			assembleConfiguration(
				f.tree,
				f.authority,
				f.provider,
				"/root/qa-public.json",
				f.output,
			),
		).toThrow("offline_configuration_unavailable");
	},
);
