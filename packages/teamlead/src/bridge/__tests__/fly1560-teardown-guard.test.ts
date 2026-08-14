import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bridgeDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const teamleadSrcDir = resolve(
	fileURLToPath(new URL("../..", import.meta.url)),
);

/**
 * The enforcement mechanism for the FLY-1570 + FLY-1560 teardowns. It is the ONE
 * place allowed to spell the deleted module and symbol names (§5.1 exemption ②
 * — a guard cannot assert on a name it may not write), which is also why this
 * file's own name carries no family word.
 */
describe("FLY-1570 detection/stuck teardown", () => {
	it("physically removes the detection and stuck chase modules", () => {
		const retired = [
			"runner-receipt-patrol.ts",
			"lead-receipt-patrol.ts",
			"lead-pending-escalation.ts",
			"detection-config-source.ts",
			"detection-escalation-sinks.ts",
			"detection-escalation.ts",
			"detection-gap-scan.ts",
			"detection-reconcile-tick.ts",
			"detection-suspicious.ts",
			"stuck-runner-detector.ts",
			"stuck-escalation.ts",
			"stuck-candidate.ts",
			"stuck-pane-confirm.ts",
			"StuckWatcher.ts",
			"watchdog-judge-assembly.ts",
			"watchdog-judge.ts",
			"notify-digest-expect.ts",
			"workflow-route-reminder-drain.ts",
			"inbox-loop-health-checker.ts",
			"park-watch.ts",
			"legacy-delivery-watchdog-policy.ts",
		];

		expect(
			retired.filter((name) => existsSync(`${bridgeDir}/${name}`)),
		).toEqual([]);
	});

	it("leaves no production assembly for detection escalation or stuck chasing", () => {
		const plugin = readFileSync(`${bridgeDir}/plugin.ts`, "utf8");
		const heartbeat = readFileSync(
			`${teamleadSrcDir}/HeartbeatService.ts`,
			"utf8",
		);

		expect(plugin).not.toMatch(
			/detectionReconcileCohortsTick|notifyLeadFirst|notifyUnprocessed|notifyWakeFailure|listPendingReceiptAlerts|upsertDetectionEscalation|stuckConfirmHolder|createWatchdogJudge/,
		);
		expect(heartbeat).not.toContain("getStuckSessions(");
	});
});

describe("FLY-1560 remaining-family teardown", () => {
	it("physically removes the surviving watchdog-family modules", () => {
		const retired: Array<[string, string]> = [
			[teamleadSrcDir, "RunnerIdleWatchdog.ts"],
			[teamleadSrcDir, "LeadWatchdog.ts"],
			[bridgeDir, "LeadWatchdog.ts"],
			[bridgeDir, "RunnerIdleWatchdog.ts"],
			[`${teamleadSrcDir}/account-heal`, "account-switch-watchdog.ts"],
			[`${teamleadSrcDir}/lead-backends/codex`, "LeadHealthProbe.ts"],
			[teamleadSrcDir, "lead-event-ack-policy.ts"],
			// Renamed (behavior preserved) — the OLD paths must be gone.
			[bridgeDir, "BridgeEventLoopWatchdog.ts"],
			[bridgeDir, "founder-reply-watchdog.ts"],
			[bridgeDir, "watchdog-health.ts"],
			[bridgeDir, "watchdog-minimum-set.ts"],
		];

		expect(
			retired
				.filter(([dir, name]) => existsSync(`${dir}/${name}`))
				.map(([, name]) => name),
		).toEqual([]);
	});

	it("keeps the two renamed survivors — behavior stays, the family name does not", () => {
		// These carry real behavior (launchd KeepAlive depends on the loop guard
		// turning a main-loop hang into a restartable crash; the unreachable
		// reconcile is a genuine data-consistency pass), so a "clean grep" that
		// deleted them would be a regression, not progress.
		expect(existsSync(`${bridgeDir}/BridgeEventLoopGuard.ts`)).toBe(true);
		expect(existsSync(`${bridgeDir}/founder-reply-unreachable.ts`)).toBe(true);
		expect(existsSync(`${bridgeDir}/liveness-manifest.ts`)).toBe(true);
	});

	it("leaves no production wiring for the removed emitters", () => {
		const plugin = readFileSync(`${bridgeDir}/plugin.ts`, "utf8");
		expect(plugin).not.toMatch(
			/LeadWatchdog|RunnerIdleWatchdog|onPollComplete|applyStallWatchdog|accountSwitchWatchdogTick|healthProbe\(|partitionLeadsForPaneWatchdog|paneWatchdogProjects/,
		);
		const runnerStatus = readFileSync(`${bridgeDir}/runner-status.ts`, "utf8");
		expect(runnerStatus).not.toMatch(
			/applyStallWatchdog|STALL_THRESHOLD_MS|stallCache|clearStallCache|stopEviction/,
		);
	});

	it("serves the liveness manifest under the v2 contract, not the legacy key", () => {
		const plugin = readFileSync(`${bridgeDir}/plugin.ts`, "utf8");
		// /health must not resurrect the old key, and the new one must be served.
		expect(plugin).not.toMatch(/\bwatchdogs\s*[,:]/);
		expect(plugin).toContain("{ liveness }");
		const manifest = readFileSync(`${bridgeDir}/liveness-manifest.ts`, "utf8");
		expect(manifest).toContain("schema_version: 2");
		expect(manifest).not.toContain("w4_lead_blocked");
	});

	/**
	 * Codex R2 LOW: an exemption expressed as a pattern is not "exactly the
	 * declared exemptions" — under a regex rule, any future `__tests__` file
	 * could carry `expect(x).not.toContain("y"); // watchdog is alive` and buy
	 * itself a silent pass. So the enforcement exemption is an exact
	 * path → verbatim-line allowlist instead. Every entry must still be present
	 * (asserted below), so a stale exemption fails loudly rather than rotting.
	 */
	const ENFORCEMENT_EXEMPTIONS: Record<string, readonly string[]> = {
		"bridge/__tests__/gate-poller-lead-reconcile.test.ts": [
			'expect(plugin).not.toContain("RunnerIdleWatchdog");',
		],
	};

	/**
	 * The literal-layer acceptance predicate (§5.1 / issue acceptance 1) as an
	 * executable assertion rather than a one-off shell command, so the sweep
	 * cannot silently rot back in. Exemptions are exactly the declared ones:
	 * test fixtures, this guard file itself, and ENFORCEMENT_EXEMPTIONS above.
	 */
	it("has zero family-word residue left in packages/teamlead/src", () => {
		const offenders: string[] = [];
		const seenExemptions = new Set<string>();
		const guardFile = resolve(fileURLToPath(import.meta.url));
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = resolve(dir, entry);
				if (statSync(full).isDirectory()) {
					if (entry === "fixtures" || entry === "node_modules") continue;
					walk(full);
					continue;
				}
				if (!/\.(ts|tsx|js|md)$/.test(entry)) continue;
				if (full === guardFile) continue;
				const relative = full
					.slice(teamleadSrcDir.length + 1)
					.split(sep)
					.join("/");
				const exempt = ENFORCEMENT_EXEMPTIONS[relative] ?? [];
				const text = readFileSync(full, "utf8");
				for (const [index, line] of text.split("\n").entries()) {
					if (!/watchdog/i.test(line)) continue;
					const trimmed = line.trim();
					if (exempt.includes(trimmed)) {
						seenExemptions.add(`${relative}::${trimmed}`);
						continue;
					}
					offenders.push(`${relative}:${index + 1}: ${trimmed}`);
				}
			}
		};
		walk(teamleadSrcDir);
		expect(offenders).toEqual([]);

		// A declared exemption that no longer matches anything is dead bookkeeping
		// — it would quietly widen next time someone edits the list.
		const declared = Object.entries(ENFORCEMENT_EXEMPTIONS).flatMap(
			([file, lines]) => lines.map((line) => `${file}::${line}`),
		);
		expect([...seenExemptions].sort()).toEqual(declared.sort());
	});
});
