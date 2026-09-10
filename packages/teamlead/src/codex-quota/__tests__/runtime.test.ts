import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexQuotaRuntime } from "../runtime.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});
const registry = {
	version: 1 as const,
	primary: "personal" as const,
	profiles: [
		{
			name: "personal" as const,
			email: "personal@example.test",
			role: "primary" as const,
		},
	],
};
const auth = (refresh: string) =>
	JSON.stringify({
		tokens: {
			id_token: `x.${Buffer.from(JSON.stringify({ email: "personal@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "personal" } })).toString("base64url")}.x`,
			refresh_token: refresh,
		},
	});
async function fixture(
	ready: boolean,
	store?: import("../../StateStore.js").StateStore,
) {
	const root = await mkdtemp(join(tmpdir(), "quota-runtime-"));
	roots.push(root);
	const canonicalHome = join(root, "canonical"),
		profilesRoot = join(root, "profiles");
	await mkdir(canonicalHome);
	await mkdir(join(profilesRoot, "personal"), { recursive: true });
	await writeFile(join(canonicalHome, "auth.json"), auth("old"), {
		mode: 0o600,
	});
	await writeFile(join(profilesRoot, "personal", "auth.json"), auth("old"), {
		mode: 0o600,
	});
	const binary = join(root, "fake-codex");
	await writeFile(
		binary,
		`#!${process.execPath}\nconst fs=require('fs');const p=process.env.CODEX_HOME+'/auth.json';const a=JSON.parse(fs.readFileSync(p));a.tokens.refresh_token='fresh';fs.writeFileSync(p,JSON.stringify(a));process.exit(1);`,
		{ mode: 0o700 },
	);
	const collectHomes = vi.fn(async () => ({ complete: ready, homes: [] }));
	const recordInstalling = vi.fn();
	const runtime = new CodexQuotaRuntime({
		canonicalHome,
		profilesRoot,
		stateRoot: join(root, "state"),
		rawBinary: binary,
		registry,
		model: "fixture",
		limitId: "codex",
		collectHomes,
		store:
			store ??
			({ codexQuota: { recordInstalling, getRoot: () => undefined } } as never),
		recover: async () => {},
	});
	return {
		runtime,
		collectHomes,
		recordInstalling,
		profilesRoot,
		canonicalHome,
		binary,
	};
}
it("fresh incomplete host authority prevents any candidate refresh", async () => {
	const f = await fixture(false);
	await expect(f.runtime.observe()).rejects.toThrow("quota_readiness_failed");
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("old");
	await f.runtime.stop();
});
it("a failed reader durably retains rotated candidate bytes before releasing its lease", async () => {
	const f = await fixture(true);
	const observations = await f.runtime.observe();
	expect(observations[0].authHealth).toBe("unknown");
	expect(observations[0].credentialFingerprint).toBe(
		(await import("node:crypto"))
			.createHash("sha256")
			.update(await readFile(join(f.profilesRoot, "personal", "auth.json")))
			.digest("hex"),
	);
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("fresh");
	expect(f.recordInstalling).not.toHaveBeenCalled();
	await f.runtime.stop();
});
it("probe failure never installs and still preserves refreshed candidate credentials", async () => {
	const f = await fixture(true);
	const candidate = {
		profile: "personal",
		accountKey: (await import("../probe.js")).codexQuotaIdentityReader(
			registry,
		)(auth("old")).accountKey,
		observedAt: Date.now(),
		identityVerified: true,
		authHealth: "valid" as const,
		windows: [],
		scopeKnown: true,
	};
	const result = await f.runtime.rotate({ incident_id: "incident" }, candidate);
	expect(result.ok).toBe(false);
	expect(f.recordInstalling).not.toHaveBeenCalled();
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("fresh");
	await f.runtime.stop();
});

it("successful probe journals before canonical rename and installs the proven bytes", async () => {
	const f = await fixture(true);
	await writeFile(
		f.binary,
		`#!${process.execPath}\nconst fs=require('fs');const p=process.env.CODEX_HOME+'/auth.json';const a=JSON.parse(fs.readFileSync(p));a.tokens.refresh_token='proven';fs.writeFileSync(p,JSON.stringify(a));fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');`,
		{ mode: 0o700 },
	);
	let prior = "";
	f.recordInstalling.mockImplementation(() => {
		prior = require("node:fs").readFileSync(
			join(f.canonicalHome, "auth.json"),
			"utf8",
		);
	});
	const candidate = {
		profile: "personal",
		accountKey: (await import("../probe.js")).codexQuotaIdentityReader(
			registry,
		)(auth("old")).accountKey,
		observedAt: Date.now(),
		identityVerified: true,
		authHealth: "valid" as const,
		windows: [],
		scopeKnown: true,
	};
	expect(
		(await f.runtime.rotate({ incident_id: "incident" }, candidate)).ok,
	).toBe(true);
	expect(JSON.parse(prior).tokens.refresh_token).toBe("old");
	expect(f.recordInstalling).toHaveBeenCalledWith(
		expect.objectContaining({ incidentId: "incident", profile: "personal" }),
	);
	expect(
		JSON.parse(await readFile(join(f.canonicalHome, "auth.json"), "utf8"))
			.tokens.refresh_token,
	).toBe("proven");
	await f.runtime.stop();
});
it("reconciliation refuses unrelated canonical bytes and recognizes only journal digests", async () => {
	const f = await fixture(true);
	const { createHash } = await import("node:crypto");
	const digest = (s: string) => createHash("sha256").update(s).digest("hex");
	const identity = (await import("../probe.js")).codexQuotaIdentityReader(
		registry,
	)(auth("old"));
	const material = {
		...identity,
		priorAuthDigest: digest(auth("old")),
		installedAuthDigest: digest(auth("new")),
		recoveryMaterialPath: join(f.profilesRoot, "personal", "auth.json"),
		recordedAt: new Date().toISOString(),
	};
	expect(await f.runtime.reconcileInstallation({}, material)).toBe(
		"rolled_back",
	);
	await writeFile(join(f.canonicalHome, "auth.json"), auth("other"));
	expect(await f.runtime.reconcileInstallation({}, material)).toBe("uncertain");
	await writeFile(join(f.canonicalHome, "auth.json"), auth("new"));
	await writeFile(material.recoveryMaterialPath, auth("new"));
	expect(await f.runtime.reconcileInstallation({}, material)).toBe("installed");
	await f.runtime.stop();
});
it("dispatcher wiring checks current pause on each admission and bypasses unavailable runtime", async () => {
	const { wireCodexQuotaDispatcher } = await import("../runtime.js");
	const dispatcher = {} as Required<
		import("../runtime.js").CodexQuotaDispatcherWiring
	>;
	let paused = false;
	const store = {
		codexQuota: {
			isPaused: () => paused,
			isExecutionPaused: () => paused,
			getRoot: () => ({ generation: 3 }),
		},
	};
	wireCodexQuotaDispatcher(dispatcher, store as never, undefined, "root");
	expect(await dispatcher.beforeCodexDaemonStart("/home", "exec")).toBeNull();
	expect(
		dispatcher.codexQuotaAdmission({ projectName: "p", executionId: "e" }),
	).toBeUndefined();
	const f = await fixture(true);
	wireCodexQuotaDispatcher(dispatcher, store as never, f.runtime, "root");
	expect(
		dispatcher.codexQuotaAdmission({ projectName: "p", executionId: "e" }),
	).toBeUndefined();
	paused = true;
	expect(
		dispatcher.codexQuotaAdmission({ projectName: "p", executionId: "e" }),
	).toEqual({ rootKey: "root", generation: 3 });
	expect(dispatcher.executionQuotaPaused("e")).toBe(true);
	await f.runtime.stop();
});
it("active independent candidate is excluded before any reader or probe", async () => {
	const f = await fixture(true);
	const identity = (await import("../probe.js")).codexQuotaIdentityReader(
		registry,
	)(auth("old"));
	f.collectHomes.mockResolvedValue({
		complete: true,
		homes: [],
		activeUnsharedAccountKeys: [identity.accountKey],
	} as never);
	expect((await f.runtime.observe())[0].authHealth).toBe("in_use_unshared");
	expect(
		await f.runtime.rotate(
			{ incident_id: "i" },
			{
				...identity,
				observedAt: Date.now(),
				identityVerified: true,
				authHealth: "valid",
				scopeKnown: true,
				windows: [],
			},
		),
	).toEqual({ ok: false });
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("old");
	await f.runtime.stop();
});
it("readiness lost after successful probe preserves refreshed bytes and prevents install", async () => {
	const f = await fixture(true);
	await writeFile(
		f.binary,
		`#!${process.execPath}\nconst fs=require('fs');const p=process.env.CODEX_HOME+'/auth.json';const a=JSON.parse(fs.readFileSync(p));a.tokens.refresh_token='proven';fs.writeFileSync(p,JSON.stringify(a));fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'ok');`,
		{ mode: 0o700 },
	);
	f.collectHomes
		.mockResolvedValueOnce({ complete: true, homes: [] })
		.mockResolvedValueOnce({ complete: true, homes: [] })
		.mockResolvedValue({ complete: false, homes: [] });
	const identity = (await import("../probe.js")).codexQuotaIdentityReader(
		registry,
	)(auth("old"));
	expect(
		(
			await f.runtime.rotate(
				{ incident_id: "i" },
				{
					...identity,
					observedAt: Date.now(),
					identityVerified: true,
					authHealth: "valid",
					scopeKnown: true,
					windows: [],
				},
			)
		).ok,
	).toBe(false);
	expect(f.recordInstalling).not.toHaveBeenCalled();
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("proven");
	expect(
		JSON.parse(await readFile(join(f.canonicalHome, "auth.json"), "utf8"))
			.tokens.refresh_token,
	).toBe("old");
	await f.runtime.stop();
});
it("an account lease owned by another reader is unavailable without failing the whole observation batch", async () => {
	const f = await fixture(true);
	const identity = (await import("../probe.js")).codexQuotaIdentityReader(
		registry,
	)(auth("old"));
	const lease = (
		await import("flywheel-claude-runner/bin/codex-account-install.mjs")
	).acquireCodexAccountLease(f.profilesRoot, identity.accountKey);
	try {
		expect((await f.runtime.observe())[0].authHealth).toBe("unknown");
	} finally {
		lease.release();
		await f.runtime.stop();
	}
});

it("a manual canonical identity change advances observed generation without granting recovery proof", async () => {
	const { StateStore } = await import("../../StateStore.js");
	const store = await StateStore.create(":memory:");
	const f = await fixture(true, store);
	try {
		const first = await f.runtime.credential();
		const changed = JSON.parse(auth("manual"));
		changed.tokens.id_token = `x.${Buffer.from(JSON.stringify({ email: "personal@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "manual-account" } })).toString("base64url")}.x`;
		await writeFile(
			join(f.canonicalHome, "auth.json"),
			JSON.stringify(changed),
		);
		const next = await f.runtime.credential();
		expect(next.generation).toBe(first.generation + 1);
		expect(next.accountKey).not.toBe(first.accountKey);
		expect(store.codexQuota.listIncidents()).toEqual([]);
	} finally {
		await f.runtime.stop();
		store.close();
	}
});

it("the active canonical account is never refreshed as an isolated candidate", async () => {
	const identity = (await import("../probe.js")).codexQuotaIdentityReader(
		registry,
	)(auth("old"));
	const f = await fixture(true, {
		codexQuota: {
			recordInstalling: () => {},
			getRoot: () => ({ ...identity, generation: 1, rootKey: "root" }),
		},
	} as never);
	f.collectHomes.mockResolvedValue({
		complete: true,
		homes: [],
		canonicalChainActive: true,
	} as never);
	expect((await f.runtime.observe())[0].authHealth).toBe("in_use_unshared");
	expect(
		JSON.parse(
			await readFile(join(f.profilesRoot, "personal", "auth.json"), "utf8"),
		).tokens.refresh_token,
	).toBe("old");
	await f.runtime.stop();
});

it("constructor failure disables rotation and leaves launch admission available", async () => {
	const { initializeCodexQuotaRuntime, wireCodexQuotaDispatcher } =
		await import("../runtime.js");
	const report = vi.fn();
	const cause = new Error("shared credential migration missing");
	const runtime = await initializeCodexQuotaRuntime(
		() => true,
		() => {
			throw cause;
		},
		report,
	);
	expect(runtime).toBeUndefined();
	expect(report).toHaveBeenCalledWith("quota_runtime_init_failed", cause);
	const dispatcher = {} as Required<
		import("../runtime.js").CodexQuotaDispatcherWiring
	>;
	wireCodexQuotaDispatcher(
		dispatcher,
		{
			codexQuota: { isPaused: () => false, isExecutionPaused: () => false },
		} as never,
		runtime,
		"root",
	);
	expect(
		dispatcher.codexQuotaAdmission({ projectName: "p", executionId: "e" }),
	).toBeUndefined();
	expect(await dispatcher.beforeCodexDaemonStart("/home", "e")).toBeNull();
});
it("flag OFF bypasses construction and binding with zero runtime calls", async () => {
	const { initializeCodexQuotaRuntime, wireCodexQuotaDispatcher } =
		await import("../runtime.js");
	const construct = vi.fn();
	const report = vi.fn();
	expect(
		await initializeCodexQuotaRuntime(() => false, construct, report),
	).toBeUndefined();
	expect(construct).not.toHaveBeenCalled();
	const beforeCodexDaemonStart = vi.fn();
	const quotaRead = vi.fn(() => {
		throw new Error("OFF must not read quota store");
	});
	const dispatcher = {} as Required<
		import("../runtime.js").CodexQuotaDispatcherWiring
	>;
	wireCodexQuotaDispatcher(
		dispatcher,
		{
			get codexQuota() {
				return quotaRead();
			},
		} as never,
		{ beforeCodexDaemonStart } as never,
		"root",
		{ enabled: () => false, report },
	);
	expect(await dispatcher.beforeCodexDaemonStart("/home", "e")).toBeNull();
	expect(
		dispatcher.codexQuotaAdmission({ projectName: "p", executionId: "e" }),
	).toBeUndefined();
	expect(beforeCodexDaemonStart).not.toHaveBeenCalled();
	expect(quotaRead).not.toHaveBeenCalled();
	expect(report).not.toHaveBeenCalled();
});
it("binding failure disables rotation for the launch and reports the cause", async () => {
	const { wireCodexQuotaDispatcher } = await import("../runtime.js");
	const cause = new Error("quota_launch_home_not_shared");
	const report = vi.fn();
	const dispatcher = {} as Required<
		import("../runtime.js").CodexQuotaDispatcherWiring
	>;
	wireCodexQuotaDispatcher(
		dispatcher,
		{
			codexQuota: { isPaused: () => false, isExecutionPaused: () => false },
		} as never,
		{
			beforeCodexDaemonStart: async () => {
				throw cause;
			},
		} as never,
		"root",
		{ enabled: () => true, report },
	);
	expect(await dispatcher.beforeCodexDaemonStart("/home", "e")).toBeNull();
	expect(report).toHaveBeenCalledWith("quota_runtime_bind_failed", cause);
});
it("failure diagnostics preserve code and cause while alerting once per host window", async () => {
	const { createCodexQuotaFailureReporter } = await import("../runtime.js");
	let now = 10;
	const log = vi.fn();
	const alert = vi.fn();
	const options = { host: "host-a", now: () => now, log, alert };
	const first = createCodexQuotaFailureReporter(options);
	first("quota_runtime_init_failed", new Error("migration absent"));
	const second = createCodexQuotaFailureReporter(options);
	second("quota_runtime_bind_failed", new Error("home not shared"));
	expect(log).toHaveBeenCalledTimes(2);
	expect(log.mock.calls[0][0]).toMatchObject({
		code: "quota_runtime_init_failed",
		cause: "migration absent",
		rotation: "disabled",
	});
	expect(alert).toHaveBeenCalledTimes(1);
	createCodexQuotaFailureReporter({ ...options, host: "host-b" })(
		"quota_runtime_init_failed",
		new Error("other"),
	);
	expect(alert).toHaveBeenCalledTimes(2);
	now += 60 * 60 * 1000;
	first("quota_runtime_init_failed", new Error("still absent"));
	expect(alert).toHaveBeenCalledTimes(3);
});

it.each(["before", "during failure", "during success"])(
	"known root pause %s cannot be downgraded to an infrastructure fallback",
	async (timing) => {
		const { StateStore } = await import("../../StateStore.js");
		const { wireCodexQuotaDispatcher } = await import("../runtime.js");
		const store = await StateStore.create(":memory:");
		try {
			const prior = {
				bindingId: "prior",
				executionId: "old",
				runId: null,
				accountKey: "business",
				profile: "business",
				generation: 1,
				credentialRootKey: "root",
				purpose: "runner" as const,
			};
			store.codexQuota.registerBinding(prior);
			const pause = () =>
				store.codexQuota.recordSignal({
					executionId: "old",
					bindingId: "prior",
				});
			if (timing === "before") pause();
			const bind = vi.fn(async () => {
				await Promise.resolve();
				pause();
				if (timing !== "during success")
					throw new Error("quota_installation_pending");
				return { ...prior, bindingId: "new", executionId: "new" };
			});
			const report = vi.fn();
			const dispatcher = {} as Required<
				import("../runtime.js").CodexQuotaDispatcherWiring
			>;
			wireCodexQuotaDispatcher(
				dispatcher,
				store,
				{ beforeCodexDaemonStart: bind } as never,
				"root",
				{ enabled: () => true, report },
			);
			expect(store.codexQuota.isExecutionPaused("new")).toBe(false);
			await expect(
				dispatcher.beforeCodexDaemonStart("/home", "new"),
			).rejects.toThrow("quota_launch_paused");
			expect(bind).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
			expect(report).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	},
);

it("pause-store infrastructure failure keeps the diagnosed legacy launch fallback", async () => {
	const { StateStore } = await import("../../StateStore.js");
	const { wireCodexQuotaDispatcher } = await import("../runtime.js");
	const store = await StateStore.create(":memory:");
	try {
		const cause = new Error("quota storage unavailable");
		vi.spyOn(store, "codexQuota", "get").mockImplementation(() => {
			throw cause;
		});
		const bind = vi.fn();
		const report = vi.fn();
		const dispatcher = {} as Required<
			import("../runtime.js").CodexQuotaDispatcherWiring
		>;
		wireCodexQuotaDispatcher(
			dispatcher,
			store,
			{ beforeCodexDaemonStart: bind } as never,
			"root",
			{ enabled: () => true, report },
		);
		await expect(
			dispatcher.beforeCodexDaemonStart("/home", "new"),
		).resolves.toBeNull();
		expect(bind).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith("quota_runtime_bind_failed", cause);
	} finally {
		store.close();
	}
});

it.each(["success", "typed pause"])(
	"OFF during awaited binding bypasses the %s completion fence",
	async (outcome) => {
		const { StateStore } = await import("../../StateStore.js");
		const { wireCodexQuotaDispatcher } = await import("../runtime.js");
		const { CodexQuotaLaunchPausedError } = await import(
			"../launch-binding.js"
		);
		const store = await StateStore.create(":memory:");
		try {
			let enabled = true;
			const prior = {
				bindingId: "prior",
				executionId: "old",
				runId: null,
				accountKey: "business",
				profile: "business",
				generation: 1,
				credentialRootKey: "root",
				purpose: "runner" as const,
			};
			store.codexQuota.registerBinding(prior);
			const bind = vi.fn(async () => {
				await Promise.resolve();
				store.codexQuota.recordSignal({
					executionId: "old",
					bindingId: "prior",
				});
				enabled = false;
				if (outcome === "typed pause") throw new CodexQuotaLaunchPausedError();
				return { ...prior, bindingId: "new", executionId: "new" };
			});
			const report = vi.fn();
			const dispatcher = {} as Required<
				import("../runtime.js").CodexQuotaDispatcherWiring
			>;
			wireCodexQuotaDispatcher(
				dispatcher,
				store,
				{ beforeCodexDaemonStart: bind } as never,
				"root",
				{ enabled: () => enabled, report },
			);
			await expect(
				dispatcher.beforeCodexDaemonStart("/home", "new"),
			).resolves.toBeNull();
			expect(bind).toHaveBeenCalledOnce();
			expect(report).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	},
);

it("ON preserves a persisted root pause even when runtime construction was unavailable", async () => {
	const { StateStore } = await import("../../StateStore.js");
	const { wireCodexQuotaDispatcher } = await import("../runtime.js");
	const store = await StateStore.create(":memory:");
	try {
		store.codexQuota.registerBinding({
			bindingId: "prior",
			executionId: "old",
			runId: null,
			accountKey: "business",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
			purpose: "runner",
		});
		store.codexQuota.recordSignal({ executionId: "old", bindingId: "prior" });
		const report = vi.fn();
		const dispatcher = {} as Required<
			import("../runtime.js").CodexQuotaDispatcherWiring
		>;
		wireCodexQuotaDispatcher(dispatcher, store, undefined, "root", {
			enabled: () => true,
			report,
		});
		expect(store.codexQuota.isExecutionPaused("new")).toBe(false);
		await expect(
			dispatcher.beforeCodexDaemonStart("/home", "new"),
		).rejects.toThrow("quota_launch_paused");
		expect(report).not.toHaveBeenCalled();
	} finally {
		store.close();
	}
});
