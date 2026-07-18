import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	commandRunsEntrypoint,
	makeSystemPoolRebuildRuntime,
	pidfileProcessMatches,
	quotaHealthOutcomeAllowed,
	resolveClaudeProfileBin,
	resolveQuotaMonitorEntrypoint,
	runtimeTreeSha256,
	validateFly1252Evidence,
} from "../account-heal/quota-pool-rebuild-cli.js";

const CHECKS = {
	candidateExitMapping: true,
	driftMarkerRouting: true,
	postWriteIdentityVerify: true,
	perTickDriftDetection: true,
	notificationRouting: true,
};

describe("Claude profile binary authority", () => {
	it("rejects missing and PATH-resolved profile binaries", () => {
		expect(() => resolveClaudeProfileBin(undefined)).toThrow(
			/FLYWHEEL_CLAUDE_PROFILE_BIN must be absolute/,
		);
		expect(() => resolveClaudeProfileBin("flywheel-claude-profile")).toThrow(
			/FLYWHEEL_CLAUDE_PROFILE_BIN must be absolute/,
		);
	});

	it("accepts an explicitly reviewed absolute profile binary", () => {
		expect(
			resolveClaudeProfileBin("/reviewed/bin/flywheel-claude-profile"),
		).toBe("/reviewed/bin/flywheel-claude-profile");
	});
});

describe("quota-pool-rebuild CLI evidence gate", () => {
	it("emergency stop preserves artifacts when the recorded PID is live but its identity is unprovable", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-emergency-stop-"));
		const stateDir = join(root, "state");
		mkdirSync(stateDir);
		const pidfile = join(stateDir, "quota-monitor.pid");
		const runMarker = join(stateDir, "quota-monitor.running");
		const fakeLaunchctl = join(root, "launchctl");
		writeFileSync(
			pidfile,
			JSON.stringify({
				pid: process.pid,
				uid: process.getuid?.(),
				processStartTime: "unprovable-in-sandbox",
			}),
			{ mode: 0o600 },
		);
		writeFileSync(runMarker, "live\n", { mode: 0o600 });
		writeFileSync(
			fakeLaunchctl,
			'#!/bin/sh\n[ "$1" = print ] && exit 113\nexit 0\n',
			{ mode: 0o755 },
		);
		const envOverrides = {
			FLYWHEEL_QUOTA_PIDFILE: pidfile,
			FLYWHEEL_QUOTA_RUN_MARKER: runMarker,
			FLYWHEEL_QUOTA_LAUNCHCTL_BIN: fakeLaunchctl,
			FLYWHEEL_POOL_REBUILD_TIMEOUT_MS: "200",
		};
		const oldEnv = Object.fromEntries(
			Object.keys(envOverrides).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, envOverrides);
		const paths = {
			journal: join(stateDir, "journal.json"),
			journalLock: join(stateDir, "journal.lock"),
			config: join(stateDir, "quota-monitor.json"),
			configPreimage: join(stateDir, "config-preimage.json"),
			identityMap: join(stateDir, "identity-map.json"),
			poolDir: join(stateDir, "pool"),
			active: join(stateDir, "pool", ".active"),
			claudeJson: join(root, ".claude.json"),
			claudeJsonLock: join(root, ".claude.json.lock"),
			store: join(stateDir, "accounts.json"),
			state: join(stateDir, "monitor-state.json"),
			accountsLock: join(stateDir, "accounts.lock"),
		};
		try {
			await expect(
				makeSystemPoolRebuildRuntime(paths).emergencyStop(),
			).rejects.toThrow(/could not be proved/);
			expect(existsSync(pidfile)).toBe(true);
			expect(existsSync(runMarker)).toBe(true);
		} finally {
			for (const [key, value] of Object.entries(oldEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("refuses an unfrozen monitor config before invoking launchctl bootstrap", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-bootstrap-guard-"));
		const stateDir = join(root, "state");
		mkdirSync(stateDir);
		const config = join(stateDir, "quota-monitor.json");
		const plist = join(root, "quota-monitor.plist");
		const fakeLaunchctl = join(root, "launchctl");
		const launchLog = join(root, "launchctl.log");
		writeFileSync(
			config,
			JSON.stringify({ order: ["school"], trigger5hPct: 90 }),
			{ mode: 0o600 },
		);
		writeFileSync(plist, "fixture\n", { mode: 0o600 });
		writeFileSync(launchLog, "");
		writeFileSync(
			fakeLaunchctl,
			`#!/bin/sh
printf '%s\\n' "$*" >> "${launchLog}"
exit 0
`,
			{ mode: 0o755 },
		);
		const envOverrides = {
			FLYWHEEL_QUOTA_LAUNCHCTL_BIN: fakeLaunchctl,
			FLYWHEEL_QUOTA_PLIST_DEST: plist,
		};
		const oldEnv = Object.fromEntries(
			Object.keys(envOverrides).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, envOverrides);
		const paths = {
			journal: join(stateDir, "journal.json"),
			journalLock: join(stateDir, "journal.lock"),
			config,
			configPreimage: join(stateDir, "config-preimage.json"),
			identityMap: join(stateDir, "identity-map.json"),
			poolDir: join(stateDir, "pool"),
			active: join(stateDir, "pool", ".active"),
			claudeJson: join(root, ".claude.json"),
			claudeJsonLock: join(root, ".claude.json.lock"),
			store: join(stateDir, "accounts.json"),
			state: join(stateDir, "monitor-state.json"),
			accountsLock: join(stateDir, "accounts.lock"),
		};
		try {
			await expect(
				makeSystemPoolRebuildRuntime(paths).bootstrap("monitor"),
			).rejects.toThrow(/frozen threshold/);
			expect(readFileSync(launchLog, "utf8")).toBe("");
		} finally {
			for (const [key, value] of Object.entries(oldEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("requires the reviewed SHA to be deployed and all five FLY-1252 checks true", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-1252-evidence-"));
		const checkout = join(root, "checkout");
		const wrapper = join(
			checkout,
			"scripts",
			"flywheel-quota-monitor-wrapper.sh",
		);
		mkdirSync(join(checkout, "scripts"), { recursive: true });
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const runtimeDir = join(
			checkout,
			"packages",
			"teamlead",
			"dist",
			"account-heal",
		);
		const runtimeEntrypoint = join(runtimeDir, "quota-monitor-cli.js");
		mkdirSync(runtimeDir, { recursive: true });
		writeFileSync(runtimeEntrypoint, "console.log('reviewed runtime');\n");
		writeFileSync(
			join(runtimeDir, "quota-monitor.js"),
			"export const ok = true;\n",
		);
		execFileSync("git", ["init", "-q", checkout]);
		execFileSync("git", ["-C", checkout, "add", "scripts"]);
		execFileSync("git", [
			"-C",
			checkout,
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"fixture",
		]);
		const sha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const path = join(root, "evidence.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				issue: "FLY-1252",
				reviewedSha: sha,
				deployedSha: sha,
				deployedCheckout: checkout,
				runtimeTreeSha256: runtimeTreeSha256(runtimeDir),
				reviewVerdict: "APPROVED",
				checks: CHECKS,
			}),
			{ mode: 0o600 },
		);
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => `node ${runtimeEntrypoint}`,
			}),
		).not.toThrow();
		writeFileSync(wrapper, "#!/bin/sh\n# drift\n", { mode: 0o755 });
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => `node ${runtimeEntrypoint}`,
			}),
		).toThrow(/worktree drift/);
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(runtimeEntrypoint, "console.log('runtime drift');\n");
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => `node ${runtimeEntrypoint}`,
			}),
		).toThrow(/runtime tree/);
		writeFileSync(runtimeEntrypoint, "console.log('reviewed runtime');\n");
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => "node /tmp/unreviewed/quota-monitor-cli.js",
			}),
		).toThrow(/live quota monitor entrypoint/);
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => `tail -f ${runtimeEntrypoint}`,
			}),
		).toThrow(/live quota monitor entrypoint/);

		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				issue: "FLY-1252",
				reviewedSha: sha,
				deployedSha: "0".repeat(40),
				deployedCheckout: checkout,
				reviewVerdict: "APPROVED",
				checks: CHECKS,
			}),
			{ mode: 0o600 },
		);
		expect(() =>
			validateFly1252Evidence(path, sha, {
				resolveLiveWrapper: () => wrapper,
				readLivePidfile: () => ({ pid: 123, processStartTime: "start-123" }),
				isProcessAlive: () => true,
				readProcessStartTime: () => "start-123",
				resolveLiveCommand: () => `node ${runtimeEntrypoint}`,
			}),
		).toThrow(/incomplete/);
	});

	it("requires exact process start-time identity before trusting a pidfile", () => {
		const record = { pid: 123, processStartTime: "original-start" };
		expect(
			pidfileProcessMatches(record, {
				isProcessAlive: () => true,
				readProcessStartTime: () => "reused-pid-start",
			}),
		).toBe(false);
		expect(
			pidfileProcessMatches(record, {
				isProcessAlive: () => true,
				readProcessStartTime: () => "original-start",
			}),
		).toBe(true);
	});

	it("accepts the reviewed runtime only as Node's main script", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-entrypoint-"));
		const entrypoint = join(root, "quota-monitor-cli.js");
		writeFileSync(entrypoint, "// fixture\n");
		expect(commandRunsEntrypoint(`node ${entrypoint}`, entrypoint)).toBe(true);
		expect(commandRunsEntrypoint(`tail -f ${entrypoint}`, entrypoint)).toBe(
			false,
		);
		expect(
			commandRunsEntrypoint(`node -e noop ${entrypoint}`, entrypoint),
		).toBe(false);
	});

	it("uses the explicit deployed monitor dist when a worktree CLI verifies the canonical daemon", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-monitor-dist-"));
		const canonicalEntrypoint = join(root, "flywheel", "quota-monitor-cli.js");
		const worktreeEntrypoint = join(
			root,
			"flywheel-FLY-1182",
			"quota-monitor-cli.js",
		);
		mkdirSync(join(root, "flywheel"));
		mkdirSync(join(root, "flywheel-FLY-1182"));
		writeFileSync(canonicalEntrypoint, "// canonical daemon\n");
		writeFileSync(worktreeEntrypoint, "// reviewed worktree\n");

		const defaultExpected = resolveQuotaMonitorEntrypoint(
			worktreeEntrypoint,
			undefined,
		);
		const deployedExpected = resolveQuotaMonitorEntrypoint(
			worktreeEntrypoint,
			canonicalEntrypoint,
		);

		expect(
			commandRunsEntrypoint(`node ${canonicalEntrypoint}`, defaultExpected),
		).toBe(false);
		expect(
			commandRunsEntrypoint(`node ${canonicalEntrypoint}`, deployedExpected),
		).toBe(true);
		expect(() =>
			resolveQuotaMonitorEntrypoint(worktreeEntrypoint, "relative-monitor.js"),
		).toThrow(/absolute/);
	});

	it("allows identity conflict only under the explicit pre-login health policy", () => {
		expect(quotaHealthOutcomeAllowed("healthy", undefined)).toBe(true);
		expect(quotaHealthOutcomeAllowed("identity_conflict", undefined)).toBe(
			false,
		);
		expect(
			quotaHealthOutcomeAllowed("identity_conflict", {
				allowIdentityConflict: true,
			}),
		).toBe(true);
		expect(
			quotaHealthOutcomeAllowed("blind", { allowIdentityConflict: true }),
		).toBe(false);
		expect(
			quotaHealthOutcomeAllowed("switch_failed", {
				allowIdentityConflict: true,
			}),
		).toBe(false);
	});

	it("rejects wide-mode and symlinked evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1182-1252-evidence-"));
		const real = join(root, "real.json");
		const link = join(root, "link.json");
		writeFileSync(
			real,
			JSON.stringify({
				version: 1,
				issue: "FLY-1252",
				reviewedSha: "a".repeat(40),
				deployedSha: "a".repeat(40),
				deployedCheckout: root,
				reviewVerdict: "APPROVED",
				checks: CHECKS,
			}),
			{ mode: 0o600 },
		);
		chmodSync(real, 0o644);
		expect(() => validateFly1252Evidence(real, "a".repeat(40))).toThrow(
			/owner-only/,
		);
		chmodSync(real, 0o600);
		symlinkSync(real, link);
		expect(() => validateFly1252Evidence(link, "a".repeat(40))).toThrow(
			/owner-only/,
		);
	});
});
