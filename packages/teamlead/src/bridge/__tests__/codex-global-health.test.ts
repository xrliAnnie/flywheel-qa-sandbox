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
import { describe, expect, it, vi } from "vitest";
import {
	checkCodexGlobalHealth,
	classifyCodexGlobal,
	reportCodexGlobalHealth,
} from "../codex-global-health.js";

const HOME = "/Users/test";
const LEAD_BIN = `${HOME}/.codex-mufasa/packages/standalone/releases/0.142.0-aarch64-apple-darwin/bin/codex`;
const LEAD_BIN_MED3 = `${HOME}/.codex-mufasa-med3/packages/standalone/current/bin/codex`;
const NEUTRAL_BIN = `${HOME}/.local/share/flywheel-codex/0.142.0/bin/codex`;
const DEFAULT_HOME_BIN = `${HOME}/.codex/packages/standalone/0.142.0/bin/codex`;
const HOMEBREW_BIN = "/opt/homebrew/bin/codex";

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
});
