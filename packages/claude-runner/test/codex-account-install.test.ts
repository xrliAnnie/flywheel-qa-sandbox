import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
	acquireCodexAccountLease,
	installCodexQuotaCredential,
	withCodexInstallLock,
} from "../bin/codex-account-install.mjs";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const registry = {
	version: 1 as const,
	primary: "personal" as const,
	profiles: [
		{
			name: "school" as const,
			email: "school@example.test",
			role: "manual_backup" as const,
		},
		{
			name: "personal" as const,
			email: "personal@example.test",
			role: "primary" as const,
		},
		{
			name: "business" as const,
			email: "business@example.test",
			role: "manual_backup" as const,
		},
	],
};
const auth = (profile: string, refresh: string) =>
	JSON.stringify({
		tokens: {
			id_token: `x.${Buffer.from(JSON.stringify({ email: `${profile}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: profile } })).toString("base64url")}.x`,
			refresh_token: refresh,
		},
	});
const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "codex-install-"));
	roots.push(root);
	const home = join(root, "home"),
		profilesRoot = join(root, "profiles");
	mkdirSync(home);
	mkdirSync(profilesRoot);
	for (const p of registry.profiles) {
		mkdirSync(join(profilesRoot, p.name));
		writeFileSync(join(profilesRoot, p.name, "auth.json"), auth(p.name, "old"));
	}
	const prior = auth("business", "live"),
		initial = auth("school", "old"),
		fresh = auth("school", "refreshed");
	writeFileSync(join(home, "auth.json"), prior);
	const finalAuthPath = join(root, "final-auth");
	writeFileSync(finalAuthPath, fresh, { mode: 0o600 });
	const calls: unknown[] = [];
	return {
		home,
		profilesRoot,
		profile: "school" as const,
		registry,
		finalAuthPath,
		expectedProfileDigest: digest(initial),
		expectedCanonicalDigest: digest(prior),
		proof: {
			ok: true,
			profile: "school",
			accountKey: digest("school:school"),
			authDigest: digest(fresh),
			at: 1000,
		},
		now: () => 1000,
		recordInstalling: (receipt: unknown) => {
			calls.push(receipt);
		},
		fresh,
		prior,
		calls,
	};
}
it("retains refreshed candidate in same profile before stale canonical abort, outgoing never overwritten", () => {
	const f = fixture();
	const manual = auth("personal", "manual");
	writeFileSync(join(f.home, "auth.json"), manual);
	const result = installCodexQuotaCredential(f);
	expect(result.status).toBe("stale_selection");
	expect(
		readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
	).toBe(f.fresh);
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(manual);
	expect(
		readFileSync(join(f.profilesRoot, "business", "auth.json"), "utf8"),
	).toBe(auth("business", "old"));
	expect(f.calls).toHaveLength(0);
});
it("probe failure writes neither canonical nor profile nor calls installing", () => {
	const f = fixture();
	const result = installCodexQuotaCredential({
		...f,
		proof: { ...f.proof, ok: false },
	});
	expect(result.status).toBe("probe_failed");
	expect(
		readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
	).toBe(auth("school", "old"));
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
	expect(f.calls).toHaveLength(0);
	expect(existsSync(join(f.home, ".codex-quota-recovery"))).toBe(false);
});
it("installs only after durable installing callback and never exports outgoing live auth", () => {
	const f = fixture();
	const result = installCodexQuotaCredential({
		...f,
		recordInstalling: () => {
			expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
			f.calls.push("installing");
		},
	});
	expect(result.status).toBe("installed");
	expect(f.calls).toEqual(["installing"]);
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.fresh);
	expect(statSync(join(f.home, "auth.json")).mode & 0o777).toBe(0o600);
	expect(
		readFileSync(join(f.profilesRoot, "business", "auth.json"), "utf8"),
	).toBe(auth("business", "old"));
});
it("stale proof and callback abort preserve refreshed profile while canonical remains old", () => {
	for (const mode of ["stale", "throw"]) {
		const f = fixture();
		const result = installCodexQuotaCredential({
			...f,
			now: () => (mode === "stale" ? 100_001 : 1000),
			recordInstalling: () => {
				throw new Error("db-abort");
			},
		});
		expect(result.status).not.toBe("installed");
		expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
		expect(
			readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
		).toBe(f.fresh);
	}
});
it("concurrent profile write is never clobbered and final candidate remains recoverable", () => {
	const f = fixture();
	const newer = auth("school", "concurrent");
	writeFileSync(join(f.profilesRoot, "school", "auth.json"), newer);
	const result = installCodexQuotaCredential(f);
	expect(result.status).toBe("candidate_conflict");
	expect(
		readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
	).toBe(newer);
	expect(readFileSync(result.recoveryMaterialPath!, "utf8")).toBe(f.fresh);
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
});
it("canonical rename interruption reports uncertainty with both digests recoverable", () => {
	const f = fixture();
	const result = installCodexQuotaCredential({
		...f,
		afterCanonicalRename: () => {
			throw new Error("abort-after-rename");
		},
	});
	expect(result.status).toBe("install_uncertain");
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.fresh);
	expect(
		readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
	).toBe(f.fresh);
	expect(f.calls).toHaveLength(1);
});
it("shared install lock refuses nested/manual competing owner and releases after throw", () => {
	const f = fixture();
	expect(() =>
		withCodexInstallLock(f.home, () => withCodexInstallLock(f.home, () => {})),
	).toThrow("codex_install_locked");
	expect(() =>
		withCodexInstallLock(f.home, () => {
			throw new Error("abort");
		}),
	).toThrow("abort");
	expect(withCodexInstallLock(f.home, () => 42)).toBe(42);
});

it("manual use and save honor shared root and candidate locks", () => {
	const f = fixture();
	const registryPath = join(f.home, "registry.json");
	writeFileSync(registryPath, JSON.stringify(registry));
	const cli = fileURLToPath(
		new URL("../bin/flywheel-codex-profile.mjs", import.meta.url),
	);
	const invoke = (command: string, name: string) =>
		spawnSync(
			process.execPath,
			[
				cli,
				"--home",
				f.home,
				"--profiles",
				f.profilesRoot,
				"--ledger-root",
				join(f.home, "ledger"),
				"--registry",
				registryPath,
				command,
				name,
			],
			{ encoding: "utf8" },
		);
	withCodexInstallLock(f.home, () => {
		expect(invoke("use", "school").status).toBe(2);
	});
	const lease = acquireCodexAccountLease(
		f.profilesRoot,
		digest("business:business"),
	);
	try {
		expect(invoke("save", "business").status).toBe(2);
	} finally {
		lease.release();
	}
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
});
it("rechecks proof age after durable callback before canonical rename", () => {
	const f = fixture();
	let now = 1000;
	const result = installCodexQuotaCredential({
		...f,
		now: () => now,
		recordInstalling: () => {
			now = 100_001;
		},
	});
	expect(result.status).toBe("stale_selection");
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
	expect(
		readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
	).toBe(f.fresh);
});
it("does not report internal account lock directory as an untracked profile", () => {
	const f = fixture();
	const registryPath = join(f.home, "registry.json");
	writeFileSync(registryPath, JSON.stringify(registry));
	const lease = acquireCodexAccountLease(
		f.profilesRoot,
		digest("school:school"),
	);
	lease.release();
	const cli = fileURLToPath(
		new URL("../bin/flywheel-codex-profile.mjs", import.meta.url),
	);
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"--home",
			f.home,
			"--profiles",
			f.profilesRoot,
			"--ledger-root",
			join(f.home, "ledger"),
			"--registry",
			registryPath,
			"list",
			"--json",
		],
		{ encoding: "utf8" },
	);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout).untracked).toEqual([]);
});
it("recovers account and canonical locks after SIGKILL with recorded process identity", async () => {
	const { spawn } = await import("node:child_process");
	const f = fixture();
	const helper = new URL("../bin/codex-account-install.mjs", import.meta.url)
		.href;
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {acquireCodexAccountLease,withCodexInstallLock} from ${JSON.stringify(helper)};acquireCodexAccountLease(process.argv[1],'school-key');withCodexInstallLock(process.argv[2],()=>{console.log('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`,
			f.profilesRoot,
			f.home,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`premature exit ${code}`)));
	});
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	child.kill("SIGKILL");
	await exited;
	expect(withCodexInstallLock(f.home, () => 42)).toBe(42);
	const lease = acquireCodexAccountLease(f.profilesRoot, "school-key");
	lease.release();
});
it("does not reclaim unknown or live owners merely because metadata is old", () => {
	const f = fixture();
	mkdirSync(join(f.home, ".codex-install.lock"));
	writeFileSync(
		join(f.home, ".codex-install.lock", "owner.json"),
		JSON.stringify({ pid: process.pid, processStartedAt: 1 }),
	);
	expect(() => withCodexInstallLock(f.home, () => {})).toThrow(
		"codex_install_locked",
	);
});
it("only one concurrent contender owns a reclaimed dead lock", async () => {
	const { spawn } = await import("node:child_process");
	const f = fixture();
	const helper = new URL("../bin/codex-account-install.mjs", import.meta.url)
		.href;
	const owner = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {withCodexInstallLock} from ${JSON.stringify(helper)};withCodexInstallLock(process.argv[1],()=>{console.log('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`,
			f.home,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	await new Promise<void>((resolve, reject) => {
		owner.stdout.once("data", () => resolve());
		owner.once("error", reject);
	});
	const dead = new Promise<void>((resolve) =>
		owner.once("exit", () => resolve()),
	);
	owner.kill("SIGKILL");
	await dead;
	const contenders = Array.from(
		{ length: 4 },
		() =>
			new Promise<string>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`import {withCodexInstallLock} from ${JSON.stringify(helper)};try{withCodexInstallLock(process.argv[1],()=>{console.log('winner');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);});}catch{console.log('locked');}`,
						f.home,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let out = "";
				child.stdout.on("data", (chunk) => {
					out += chunk;
				});
				child.once("error", reject);
				child.once("exit", () => resolve(out.trim()));
			}),
	);
	expect(
		(await Promise.all(contenders)).filter((value) => value === "winner"),
	).toHaveLength(1);
});
it("pending child liveness blocks persistence until actual detached child death", async () => {
	const { spawn } = await import("node:child_process");
	const {
		registerCodexCandidateWorkspace,
		markCodexCandidateProcess,
		resolveCodexCandidateRecovery,
	} = await import("../bin/codex-account-install.mjs");
	const f = fixture();
	const lease = acquireCodexAccountLease(f.profilesRoot, f.proof.accountKey);
	registerCodexCandidateWorkspace(lease, {
		authPath: f.finalAuthPath,
		originalAuthDigest: f.expectedProfileDigest,
	});
	writeFileSync(join(f.profilesRoot, "school", "auth.json"), f.fresh);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
		detached: true,
		stdio: "ignore",
	});
	markCodexCandidateProcess(lease, { state: "running", pid: child.pid });
	try {
		expect(() =>
			resolveCodexCandidateRecovery(
				lease,
				join(f.profilesRoot, "school", "auth.json"),
			),
		).toThrow("codex_candidate_process_not_drained");
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => resolve()),
		);
		child.kill("SIGKILL");
		await exited;
		resolveCodexCandidateRecovery(
			lease,
			join(f.profilesRoot, "school", "auth.json"),
		);
		expect(lease.orphanRecovery).toBeNull();
	} finally {
		child.kill("SIGKILL");
		lease.release();
	}
});
it("SIGKILL after refresh recovers the orphan pool through reconstructed helper and passes strict next refresh", async () => {
	const { spawn } = await import("node:child_process");
	const { recoverCodexCandidateCredential } = await import(
		"../bin/codex-account-install.mjs"
	);
	const f = fixture();
	const helper = new URL("../bin/codex-account-install.mjs", import.meta.url)
		.href;
	const authorityPath = join(f.home, "fixture-authority.json");
	writeFileSync(authorityPath, JSON.stringify({ activeToken: "old" }));
	const rotated = auth("school", "rotated");
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {readFileSync,writeFileSync} from 'node:fs';import {acquireCodexAccountLease,registerCodexCandidateWorkspace,markCodexCandidateProcess} from ${JSON.stringify(helper)};const lease=acquireCodexAccountLease(process.argv[1],process.argv[2]);registerCodexCandidateWorkspace(lease,{authPath:process.argv[3],originalAuthDigest:process.argv[4]});const authority=JSON.parse(readFileSync(process.argv[5],'utf8'));const profile=JSON.parse(readFileSync(process.argv[6],'utf8'));if(profile.tokens.refresh_token!==authority.activeToken)throw new Error('invalid_grant');writeFileSync(process.argv[5],JSON.stringify({activeToken:'rotated'}));writeFileSync(process.argv[3],process.argv[7]);markCodexCandidateProcess(lease,{state:'stopped',pid:process.pid});console.log('rotated');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
			f.profilesRoot,
			f.proof.accountKey,
			f.finalAuthPath,
			f.expectedProfileDigest,
			authorityPath,
			join(f.profilesRoot, "school", "auth.json"),
			rotated,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`early exit ${code}`)));
	});
	const dead = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	child.kill("SIGKILL");
	await dead;
	const strictRefresh = () => {
		const profilePath = join(f.profilesRoot, "school", "auth.json");
		const profile = JSON.parse(readFileSync(profilePath, "utf8"));
		const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
		if (profile.tokens.refresh_token !== authority.activeToken)
			throw new Error("invalid_grant");
		writeFileSync(
			authorityPath,
			JSON.stringify({ activeToken: "after-recovery" }),
		);
		writeFileSync(profilePath, auth("school", "after-recovery"));
	};
	expect(strictRefresh).toThrow("invalid_grant");
	const recovered = recoverCodexCandidateCredential({
		profilesRoot: f.profilesRoot,
		profile: "school",
		registry,
		accountKey: f.proof.accountKey,
	});
	expect(recovered.status).toBe("recovered");
	expect(strictRefresh).not.toThrow();
	expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
	expect(
		readFileSync(join(f.profilesRoot, "business", "auth.json"), "utf8"),
	).toBe(auth("business", "old"));
	expect(
		recoverCodexCandidateCredential({
			profilesRoot: f.profilesRoot,
			profile: "school",
			registry,
			accountKey: f.proof.accountKey,
		}).status,
	).toBe("no_pending");
});
it("recovery refuses ambiguous starting/no-pid processes and newer saved pool credentials", async () => {
	const {
		recoverCodexCandidateCredential,
		registerCodexCandidateWorkspace,
		markCodexCandidateProcess,
	} = await import("../bin/codex-account-install.mjs");
	for (const state of ["starting", "running", "stopped"] as const) {
		const f = fixture();
		const lease = acquireCodexAccountLease(f.profilesRoot, f.proof.accountKey);
		registerCodexCandidateWorkspace(lease, {
			authPath: f.finalAuthPath,
			originalAuthDigest: f.expectedProfileDigest,
		});
		markCodexCandidateProcess(lease, { state });
		lease.release();
		expect(
			recoverCodexCandidateCredential({
				profilesRoot: f.profilesRoot,
				profile: "school",
				registry,
				accountKey: f.proof.accountKey,
			}).status,
		).toBe("process_not_drained");
		expect(
			readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
		).toBe(auth("school", "old"));
	}
});
it("persists reader-refreshed auth under held lease and refuses concurrent newer profile", async () => {
	const { spawn } = await import("node:child_process");
	const {
		persistCodexCandidateCredential,
		registerCodexCandidateWorkspace,
		markCodexCandidateProcess,
	} = await import("../bin/codex-account-install.mjs");
	for (const conflict of [false, true]) {
		const f = fixture();
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
			stdio: "ignore",
			detached: true,
		});
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const lease = acquireCodexAccountLease(f.profilesRoot, f.proof.accountKey);
		registerCodexCandidateWorkspace(lease, {
			authPath: f.finalAuthPath,
			originalAuthDigest: f.expectedProfileDigest,
		});
		markCodexCandidateProcess(lease, { state: "stopped", pid: child.pid });
		const newer = auth("school", "newer");
		if (conflict)
			writeFileSync(join(f.profilesRoot, "school", "auth.json"), newer);
		try {
			const result = persistCodexCandidateCredential({
				profilesRoot: f.profilesRoot,
				profile: "school",
				registry,
				accountKey: f.proof.accountKey,
				finalAuthPath: f.finalAuthPath,
				expectedProfileDigest: f.expectedProfileDigest,
				accountLease: lease,
			});
			expect(result.status).toBe(conflict ? "candidate_conflict" : "persisted");
			expect(
				readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
			).toBe(conflict ? newer : f.fresh);
			expect(!!lease.orphanRecovery).toBe(conflict);
			expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe(f.prior);
		} finally {
			lease.release();
		}
	}
});
