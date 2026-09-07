/**
 * FLY-513: global codex binary stability — drift detection guard tests.
 *
 * The companion review gate and codex companion both resolve `codex` via PATH
 * and spawn `codex app-server`. If that global binary is a symlink into a
 * per-Lead, auto-updating CODEX_HOME (e.g. ~/.codex-mufasa), the standalone
 * updater / Lead flip churns it and config-load transiently fails, stalling
 * every runner's codex review gate. This module is PATH-only drift detection
 * (no app-server spawn): classify the resolved binary realpath AND CODEX_HOME.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	checkCodexGlobalHealth,
	classifyCodexGlobal,
	classifyCredential,
	composeCodexHealth,
	createCredentialProbe,
	reportCodexGlobalHealth,
} from "../codex-global-health.js";

const HOME = "/Users/test";
const LEAD_BIN = `${HOME}/.codex-mufasa/packages/standalone/releases/0.142.0-aarch64-apple-darwin/bin/codex`;
const LEAD_BIN_MED3 = `${HOME}/.codex-mufasa-med3/packages/standalone/current/bin/codex`;
const NEUTRAL_BIN = `${HOME}/.local/share/flywheel-codex/0.142.0/bin/codex`;
const DEFAULT_HOME_BIN = `${HOME}/.codex/packages/standalone/0.142.0/bin/codex`;
const HOMEBREW_BIN = "/opt/homebrew/bin/codex";

describe("FLY-2404 classifyCredential (pure)", () => {
	const healthyInput = {
		nowMs: Date.parse("2026-09-06T00:00:00Z"),
		deadlineMs: Date.parse("2026-09-07T00:00:00Z"),
		truth: {
			exists: true,
			regular: true,
			mode: 0o600,
			parseable: true,
			expiresAtMs: Date.parse("2026-09-16T00:00:00Z"),
		},
		homes: [{ home: `${HOME}/runner`, state: "linked" as const }],
	};

	it.each([
		[
			"truth-missing",
			{ truth: { ...healthyInput.truth, exists: false } },
			"severe",
		],
		[
			"truth-not-regular",
			{ truth: { ...healthyInput.truth, regular: false } },
			"severe",
		],
		["truth-mode", { truth: { ...healthyInput.truth, mode: 0o644 } }, "severe"],
		[
			"truth-expired",
			{
				truth: {
					...healthyInput.truth,
					expiresAtMs: healthyInput.nowMs + 4 * 60_000,
				},
			},
			"severe",
		],
		[
			"truth-expiring",
			{
				truth: {
					...healthyInput.truth,
					expiresAtMs: healthyInput.nowMs + 20 * 60_000,
				},
			},
			"warning",
		],
		[
			"link-missing",
			{ homes: [{ home: `${HOME}/runner`, state: "missing" }] },
			"severe",
		],
		[
			"link-drift",
			{ homes: [{ home: `${HOME}/runner`, state: "drift" }] },
			"severe",
		],
	] as const)("classifies %s", (reason, override, severity) => {
		const result = classifyCredential({
			...healthyInput,
			...override,
		} as never);
		expect(result).toMatchObject({ reason, severity });
	});

	it("debounces a torn truth read for one tick and escalates the second", () => {
		const first = classifyCredential({
			...healthyInput,
			truth: { ...healthyInput.truth, parseable: false },
			unparseableConsecutive: 1,
		});
		const second = classifyCredential({
			...healthyInput,
			truth: { ...healthyInput.truth, parseable: false },
			unparseableConsecutive: 2,
		});
		expect(first).toMatchObject({
			reason: "truth-unparseable",
			severity: "warning",
		});
		expect(second).toMatchObject({
			reason: "truth-unparseable",
			severity: "severe",
		});
	});

	it("treats copy-pending as warning before the deadline and severe without one", () => {
		const homes = [{ home: `${HOME}/runner`, state: "copy" as const }];
		expect(classifyCredential({ ...healthyInput, homes }).severity).toBe(
			"warning",
		);
		expect(
			classifyCredential({ ...healthyInput, deadlineMs: undefined, homes })
				.severity,
		).toBe("severe");
	});

	it("uses fixed credential-severe, binary-severe, credential-warning, binary-warning priority", () => {
		const binarySevere = classifyCodexGlobal({
			realPath: null,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		const credentialWarning = classifyCredential({
			...healthyInput,
			homes: [{ home: `${HOME}/runner`, state: "copy" }],
		});
		expect(composeCodexHealth(binarySevere, credentialWarning).reason).toBe(
			"codex-not-found",
		);
		const credentialSevere = classifyCredential({
			...healthyInput,
			homes: [{ home: `${HOME}/runner`, state: "missing" }],
		});
		expect(composeCodexHealth(binarySevere, credentialSevere).reason).toBe(
			"link-missing",
		);
	});
});

describe("FLY-2404 credential probe state", () => {
	const healthyObservation = {
		nowMs: Date.parse("2026-09-06T00:00:00Z"),
		deadlineMs: Date.parse("2026-09-07T00:00:00Z"),
		truth: {
			exists: true,
			regular: true,
			mode: 0o600,
			parseable: true,
			expiresAtMs: Date.parse("2026-09-16T00:00:00Z"),
		},
		homes: [{ home: `${HOME}/runner`, state: "linked" as const }],
	};

	it("shares one in-flight observation across overlapping callers", async () => {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const observe = vi.fn(async () => {
			await barrier;
			return healthyObservation;
		});
		const probe = createCredentialProbe({ observe });

		const first = probe();
		const second = probe();
		expect(first).toBe(second);
		expect(observe).toHaveBeenCalledTimes(1);
		release();
		await expect(first).resolves.toMatchObject({ reason: "healthy" });
	});

	it("debounces unparseable truth across ticks and resets after health", async () => {
		let parseable = false;
		const probe = createCredentialProbe({
			observe: async () => ({
				...healthyObservation,
				truth: { ...healthyObservation.truth, parseable },
			}),
		});
		expect(await probe()).toMatchObject({
			reason: "truth-unparseable",
			severity: "warning",
		});
		expect(await probe()).toMatchObject({
			reason: "truth-unparseable",
			severity: "severe",
		});
		parseable = true;
		expect(await probe()).toMatchObject({ reason: "healthy" });
		parseable = false;
		expect(await probe()).toMatchObject({
			reason: "truth-unparseable",
			severity: "warning",
		});
	});

	it("starts the tear debounce fresh after a structurally unhealthy truth", async () => {
		let truth = {
			...healthyObservation.truth,
			exists: false,
			parseable: false,
		};
		const probe = createCredentialProbe({
			observe: async () => ({ ...healthyObservation, truth }),
		});
		expect(await probe()).toMatchObject({ reason: "truth-missing" });
		truth = { ...healthyObservation.truth, parseable: false };
		expect(await probe()).toMatchObject({
			reason: "truth-unparseable",
			severity: "warning",
		});
	});

	it("uses access-token expiry and observes only managed homes", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2404-health-"));
		try {
			const homeDir = join(root, "home");
			const source = join(homeDir, ".codex");
			const truth = join(source, "auth.json");
			const homesRoot = join(homeDir, ".flywheel", "codex-homes");
			const keyed = join(homesRoot, "agents", "flywheel", "implement");
			const lead = join(homeDir, ".codex-mufasa");
			const extra = join(homeDir, ".flywheel", "raya", "codex-home");
			for (const directory of [source, keyed, lead, extra]) {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
			}
			const expiredIdPayload = Buffer.from(
				JSON.stringify({
					exp: Math.floor(Date.parse("2026-09-05T00:00:00Z") / 1000),
				}),
			).toString("base64url");
			const accessPayload = Buffer.from(
				JSON.stringify({
					exp: Math.floor(Date.parse("2026-09-16T00:00:00Z") / 1000),
				}),
			).toString("base64url");
			writeFileSync(
				truth,
				JSON.stringify({
					tokens: {
						id_token: `e30.${expiredIdPayload}.sig`,
						access_token: `e30.${accessPayload}.sig`,
					},
				}),
			);
			chmodSync(truth, 0o600);
			writeFileSync(
				join(keyed, ".flywheel-agent-home.json"),
				JSON.stringify({ version: 1, project: "flywheel", role: "implement" }),
			);
			for (const managed of [keyed, lead, extra]) {
				symlinkSync(realpathSync(truth), join(managed, "auth.json"));
			}
			const historical = join(homeDir, ".codex-old-qa");
			mkdirSync(historical);
			writeFileSync(join(historical, "auth.json"), "copy");
			const lockNoise = join(
				homesRoot,
				"agents",
				"flywheel",
				".locks",
				"auth.json",
			);
			mkdirSync(join(lockNoise, ".."), { recursive: true });
			writeFileSync(lockNoise, "copy");

			const probe = createCredentialProbe({
				env: {
					FLYWHEEL_CODEX_SOURCE_HOME: source,
					FLYWHEEL_CODEX_HOMES_ROOT: homesRoot,
					FLYWHEEL_CODEX_EXTRA_HOMES: extra,
					FLYWHEEL_CODEX_LINK_DEADLINE: "2026-09-07T00:00:00Z",
				},
				homeDir,
				now: () => Date.parse("2026-09-06T00:00:00Z"),
				targets: [{ projectName: "growth", leadId: "mufasa-lead" }],
				resolveLeadAuthority: async () => ({ codexHome: lead }),
			});
			expect(await probe()).toMatchObject({
				reason: "healthy",
				severity: "ok",
			});

			// The fixtures are structurally realistic but wholly synthetic. Swapping
			// the expiries proves that only access_token controls truth health.
			writeFileSync(
				truth,
				JSON.stringify({
					tokens: {
						id_token: `e30.${accessPayload}.sig`,
						access_token: `e30.${expiredIdPayload}.sig`,
					},
				}),
			);
			expect(await probe()).toMatchObject({
				reason: "truth-expired",
				severity: "severe",
			});
			writeFileSync(
				truth,
				JSON.stringify({
					tokens: {
						id_token: `e30.${expiredIdPayload}.sig`,
						access_token: `e30.${accessPayload}.sig`,
					},
				}),
			);

			unlinkSync(join(keyed, "auth.json"));
			expect(await probe()).toMatchObject({
				reason: "link-missing",
				severity: "severe",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to last_refresh plus ten days when access_token is absent", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "fly2404-health-refresh-fallback-"),
		);
		try {
			const homeDir = join(root, "home");
			const source = join(homeDir, ".codex");
			mkdirSync(source, { recursive: true, mode: 0o700 });
			const expiredIdPayload = Buffer.from(
				JSON.stringify({
					exp: Math.floor(Date.parse("2026-09-05T00:00:00Z") / 1000),
				}),
			).toString("base64url");
			writeFileSync(
				join(source, "auth.json"),
				JSON.stringify({
					last_refresh: "2026-09-02T03:27:28Z",
					tokens: { id_token: `e30.${expiredIdPayload}.sig` },
				}),
			);
			chmodSync(join(source, "auth.json"), 0o600);

			const probe = createCredentialProbe({
				env: { FLYWHEEL_CODEX_SOURCE_HOME: source },
				homeDir,
				now: () => Date.parse("2026-09-06T00:00:00Z"),
			});
			expect(await probe()).toMatchObject({
				reason: "healthy",
				severity: "ok",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["missing tokens", undefined],
		["null tokens", null],
		["empty tokens", {}],
		["malformed id token", { id_token: "not-a-jwt" }],
	])(
		"fails closed for %s instead of trusting last_refresh",
		async (_label, tokens) => {
			const root = mkdtempSync(join(tmpdir(), "fly2404-health-no-tokens-"));
			try {
				const homeDir = join(root, "home");
				const source = join(homeDir, ".codex");
				mkdirSync(source, { recursive: true, mode: 0o700 });
				const credential: Record<string, unknown> = {
					last_refresh: "2026-09-02T03:27:28Z",
				};
				if (tokens !== undefined) credential.tokens = tokens;
				writeFileSync(join(source, "auth.json"), JSON.stringify(credential));
				chmodSync(join(source, "auth.json"), 0o600);

				const probe = createCredentialProbe({
					env: { FLYWHEEL_CODEX_SOURCE_HOME: source },
					homeDir,
					now: () => Date.parse("2026-09-06T00:00:00Z"),
				});
				expect(await probe()).toMatchObject({
					reason: "truth-unparseable",
					severity: "warning",
				});
				expect(await probe()).toMatchObject({
					ok: false,
					reason: "truth-unparseable",
					severity: "severe",
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("fails closed when Lead authority or an explicit extra home is invalid", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2404-health-invalid-"));
		try {
			const homeDir = join(root, "home");
			const source = join(homeDir, ".codex");
			mkdirSync(source, { recursive: true });
			const payload = Buffer.from(
				JSON.stringify({
					exp: Math.floor(Date.parse("2026-09-16T00:00:00Z") / 1000),
				}),
			).toString("base64url");
			writeFileSync(
				join(source, "auth.json"),
				JSON.stringify({
					tokens: {
						id_token: `e30.${payload}.sig`,
						access_token: `e30.${payload}.sig`,
					},
				}),
			);
			chmodSync(join(source, "auth.json"), 0o600);

			const authorityProbe = createCredentialProbe({
				env: { FLYWHEEL_CODEX_SOURCE_HOME: source },
				homeDir,
				targets: [{ projectName: "growth", leadId: "mufasa-lead" }],
				resolveLeadAuthority: async () => {
					throw new Error("authority unavailable");
				},
			});
			expect(await authorityProbe()).toMatchObject({
				reason: "authority-unavailable",
				severity: "severe",
			});

			const extraProbe = createCredentialProbe({
				env: {
					FLYWHEEL_CODEX_SOURCE_HOME: source,
					FLYWHEEL_CODEX_EXTRA_HOMES: join(root, "outside-home"),
				},
				homeDir,
			});
			expect(await extraProbe()).toMatchObject({
				reason: "config-invalid",
				severity: "severe",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("FLY-513 classifyCodexGlobal (pure)", () => {
	it("1. binary in Lead home ~/.codex-mufasa → severe alert (lead-home-binary)", () => {
		const r = classifyCodexGlobal({
			realPath: LEAD_BIN,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: false, alert: true, severity: "severe" });
		expect(r.reason).toBe("lead-home-binary");
		expect(r.detail).toContain(".codex-mufasa");
	});

	it("2. binary in ~/.codex-mufasa-med3 (suffix variant) → severe alert", () => {
		const r = classifyCodexGlobal({
			realPath: LEAD_BIN_MED3,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r.ok).toBe(false);
		expect(r.alert).toBe(true);
		expect(r.reason).toBe("lead-home-binary");
	});

	it("3. binary in neutral ~/.local/share/flywheel-codex → healthy", () => {
		const r = classifyCodexGlobal({
			realPath: NEUTRAL_BIN,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: true, alert: false, severity: "ok" });
		expect(r.reason).toBe("healthy");
	});

	it("4. binary in default ~/.codex → healthy (not falsely matched by .codex-)", () => {
		const r = classifyCodexGlobal({
			realPath: DEFAULT_HOME_BIN,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r.ok).toBe(true);
		expect(r.alert).toBe(false);
		expect(r.reason).toBe("healthy");
	});

	it("5. binary-clean / env-contaminated: CODEX_HOME=~/.codex-mufasa → severe (bad-codex-home)", () => {
		const r = classifyCodexGlobal({
			realPath: NEUTRAL_BIN,
			codexHome: `${HOME}/.codex-mufasa`,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: false, alert: true, severity: "severe" });
		expect(r.reason).toBe("bad-codex-home");
		expect(r.detail).toContain(".codex-mufasa");
	});

	it("6. binary-contaminated / env-clean → severe (lead-home-binary)", () => {
		const r = classifyCodexGlobal({
			realPath: LEAD_BIN,
			codexHome: `${HOME}/.codex`,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("lead-home-binary");
	});

	it("7. CODEX_HOME points at a non-existent dir → severe (missing-codex-home)", () => {
		const r = classifyCodexGlobal({
			realPath: NEUTRAL_BIN,
			codexHome: `${HOME}/.codex-gone`,
			codexHomeExists: false,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: false, alert: true, severity: "severe" });
		// lead-home pattern takes precedence in detail, but missing dir is the
		// concrete failure; either reason is acceptable as long as it alerts.
		expect(["missing-codex-home", "bad-codex-home"]).toContain(r.reason);
	});

	it("8. binary in unknown non-Lead root (Homebrew) → warning, NOT alert (unknown-root)", () => {
		const r = classifyCodexGlobal({
			realPath: HOMEBREW_BIN,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: true, alert: false, severity: "warning" });
		expect(r.reason).toBe("unknown-root");
		expect(r.detail).toContain("/opt/homebrew");
	});

	it("9. default CODEX_HOME (unset) with neutral binary → healthy", () => {
		const r = classifyCodexGlobal({
			realPath: NEUTRAL_BIN,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r.ok).toBe(true);
		expect(r.alert).toBe(false);
	});

	it("10. realPath null (codex not found on PATH) → severe (codex-not-found)", () => {
		const r = classifyCodexGlobal({
			realPath: null,
			codexHome: undefined,
			codexHomeExists: true,
			homedir: HOME,
		});
		expect(r).toMatchObject({ ok: false, alert: true, severity: "severe" });
		expect(r.reason).toBe("codex-not-found");
	});
});

describe("FLY-513 checkCodexGlobalHealth (wrapper, injected deps)", () => {
	const baseDeps = {
		homedir: () => HOME,
		realpath: (_p: string) => NEUTRAL_BIN,
		dirExists: (_p: string) => true,
		resolveExecutable: (_name: string) => `${HOME}/.local/bin/codex`,
	};

	it("11. ignores the retired health-guard bypass and still resolves", () => {
		let resolved = false;
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: { FLYWHEEL_CODEX_HEALTH_GUARD: "0" },
			resolveExecutable: () => {
				resolved = true;
				return `${HOME}/.local/bin/codex`;
			},
		});
		expect(r.ok).toBe(true);
		expect(r.alert).toBe(false);
		expect(r.reason).toBe("healthy");
		expect(resolved).toBe(true);
	});

	it("12. healthy neutral binary → ok, no alert", () => {
		const r = checkCodexGlobalHealth({ ...baseDeps, env: {} });
		expect(r.ok).toBe(true);
		expect(r.alert).toBe(false);
		expect(r.reason).toBe("healthy");
	});

	it("13. resolves into a Lead home → severe alert", () => {
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: {},
			realpath: () => LEAD_BIN,
		});
		expect(r.ok).toBe(false);
		expect(r.alert).toBe(true);
		expect(r.reason).toBe("lead-home-binary");
	});

	it("14. CODEX_HOME from env is read and classified (env contamination)", () => {
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: { CODEX_HOME: `${HOME}/.codex-mufasa` },
			// path-aware: resolve the binary, identity for the (already-real) CODEX_HOME.
			realpath: (p) => (p === `${HOME}/.local/bin/codex` ? NEUTRAL_BIN : p),
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("bad-codex-home");
	});

	it("14b. CODEX_HOME is a SYMLINK into a Lead home → realpath-resolved → bad-codex-home (R1 MEDIUM)", () => {
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: { CODEX_HOME: `${HOME}/codex-home-link` },
			// the symlinked CODEX_HOME resolves into ~/.codex-mufasa; binary is neutral.
			realpath: (p) => {
				if (p === `${HOME}/.local/bin/codex`) return NEUTRAL_BIN;
				if (p === `${HOME}/codex-home-link`) return `${HOME}/.codex-mufasa`;
				return p;
			},
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("bad-codex-home");
		expect(r.detail).toContain(".codex-mufasa");
	});

	it("15. codex not resolvable on PATH → severe (codex-not-found), never throws", () => {
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: {},
			resolveExecutable: () => null,
		});
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("codex-not-found");
	});

	it("16. realpath throws (broken symlink) → severe, swallowed (never throws)", () => {
		const r = checkCodexGlobalHealth({
			...baseDeps,
			env: {},
			realpath: () => {
				throw new Error("ENOENT broken symlink");
			},
		});
		expect(r.ok).toBe(false);
		expect(r.alert).toBe(true);
	});
});

describe("FLY-513 reportCodexGlobalHealth (logs + meta-alert, never throws)", () => {
	const baseDeps = {
		homedir: () => HOME,
		dirExists: (_p: string) => true,
		resolveExecutable: (_name: string) => `${HOME}/.local/bin/codex`,
		logger: () => {},
	};

	it("severe (Lead-home binary) → fires codex_global_unhealthy meta-alert", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const r = await reportCodexGlobalHealth(
			{ notify },
			{ ...baseDeps, env: {}, realpath: () => LEAD_BIN },
		);
		expect(r.alert).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0].reason).toBe("codex_global_unhealthy");
		expect(notify.mock.calls[0][0].body).toContain("lead-home-binary");
	});

	it("healthy → no alert, notify NOT called (byte-compat sentinel)", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const r = await reportCodexGlobalHealth(
			{ notify },
			{ ...baseDeps, env: {}, realpath: () => NEUTRAL_BIN },
		);
		expect(r.ok).toBe(true);
		expect(r.alert).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("unknown-root → warning logged but NO meta-alert (does not page forever)", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const logs: string[] = [];
		const r = await reportCodexGlobalHealth(
			{ notify },
			{
				...baseDeps,
				env: {},
				realpath: () => HOMEBREW_BIN,
				logger: (m) => logs.push(m),
			},
		);
		expect(r.severity).toBe("warning");
		expect(notify).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("WARNING");
	});

	it("notify throwing is swallowed (never throws out of the reporter)", async () => {
		const notify = vi.fn().mockRejectedValue(new Error("discord down"));
		await expect(
			reportCodexGlobalHealth(
				{ notify },
				{ ...baseDeps, env: {}, realpath: () => LEAD_BIN },
			),
		).resolves.toMatchObject({ alert: true });
	});

	it("retired guard env cannot suppress a contaminated-binary alert", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const r = await reportCodexGlobalHealth(
			{ notify },
			{
				...baseDeps,
				env: { FLYWHEEL_CODEX_HEALTH_GUARD: "0" },
				realpath: () => LEAD_BIN,
			},
		);
		expect(r.reason).toBe("lead-home-binary");
		expect(notify).toHaveBeenCalledOnce();
	});

	it("composes credential health and emits reason-specific shared-link remediation", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const credentialProbe = vi.fn().mockResolvedValue(
			classifyCredential({
				nowMs: Date.parse("2026-09-06T00:00:00Z"),
				truth: {
					exists: true,
					regular: true,
					mode: 0o600,
					parseable: true,
					expiresAtMs: Date.parse("2026-09-16T00:00:00Z"),
				},
				homes: [{ home: `${HOME}/runner`, state: "missing" }],
			}),
		);
		const result = await reportCodexGlobalHealth(
			{ notify },
			{
				...baseDeps,
				env: {},
				realpath: () => NEUTRAL_BIN,
				credentialProbe,
			},
		);

		expect(result.reason).toBe("link-missing");
		expect(credentialProbe).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0][0].title).toContain("credential");
		expect(notify.mock.calls[0][0].body).toContain(
			"scripts/codex-home-link-truth.sh",
		);
	});
});
