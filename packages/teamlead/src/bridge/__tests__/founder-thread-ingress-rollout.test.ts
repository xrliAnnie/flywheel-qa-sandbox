import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	activateFounderThreadIngressRollout,
	FOUNDER_THREAD_INGRESS_ACTIVATION_FILE,
	FOUNDER_THREAD_INGRESS_MARKER_FILE,
	freezeFounderThreadIngressRollout,
	loadFounderThreadIngressRollout,
	resolveFounderThreadIngressEnvironment,
} from "../founder-thread-ingress-rollout.js";

const DISCORD_EPOCH = 1_420_070_400_000;
const snowflakeAt = (ms: number) =>
	(BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();

describe("FLY-2608 founder thread ingress rollout", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function fixture(name: string) {
		const root = mkdtempSync(join(tmpdir(), `fly2608-${name}-`));
		roots.push(root);
		const stateDir = join(root, "state");
		const commRoot = join(root, "comm");
		const teamleadDbPath = join(root, "teamlead.db");
		mkdirSync(stateDir);
		mkdirSync(commRoot);
		writeFileSync(teamleadDbPath, "fixture", { mode: 0o600 });
		return {
			root,
			stateDir,
			environment: resolveFounderThreadIngressEnvironment({
				stateDir,
				commRoot,
				teamleadDbPath,
			}),
		};
	}

	it("freezes and adopts one environment-bound lower bound with mode 0600", () => {
		const { stateDir, environment } = fixture("active");
		const now = Date.parse("2026-09-16T05:00:00.000Z");
		const owners = [
			{
				projectName: "raya",
				leadId: "raya",
				chatChannelId: "1542079099928059987",
			},
		];
		const rolloutAfter = snowflakeAt(now);
		freezeFounderThreadIngressRollout({
			stateDir,
			environment,
			owners,
			rolloutAfter,
			nowMs: now,
		});
		activateFounderThreadIngressRollout({
			stateDir,
			environment,
			currentOwners: owners,
			nowMs: now + 60_000,
			dryRun: { rolloutAfter, automaticReplayBeforeBoundary: 0 },
		});

		expect(
			statSync(join(stateDir, FOUNDER_THREAD_INGRESS_MARKER_FILE)).mode & 0o777,
		).toBe(0o600);
		expect(
			statSync(join(stateDir, FOUNDER_THREAD_INGRESS_ACTIVATION_FILE)).mode &
				0o777,
		).toBe(0o600);
		expect(
			loadFounderThreadIngressRollout({
				stateDir,
				environment,
				currentOwners: owners,
				nowMs: now + 24 * 60 * 60_000,
			}),
		).toMatchObject({ kind: "active", rolloutAfter, owners });
	});

	it("never overwrites a frozen marker", () => {
		const { stateDir, environment } = fixture("exclusive");
		const now = Date.parse("2026-09-16T05:00:00.000Z");
		const owners = [
			{
				projectName: "qa",
				leadId: "raya",
				chatChannelId: "123456789012345678",
			},
		];
		freezeFounderThreadIngressRollout({
			stateDir,
			environment,
			owners,
			rolloutAfter: snowflakeAt(now),
			nowMs: now,
		});
		const markerPath = join(stateDir, FOUNDER_THREAD_INGRESS_MARKER_FILE);
		const before = readFileSync(markerPath, "utf8");
		expect(() =>
			freezeFounderThreadIngressRollout({
				stateDir,
				environment,
				owners,
				rolloutAfter: snowflakeAt(now + 1),
				nowMs: now + 1,
			}),
		).toThrow();
		expect(readFileSync(markerPath, "utf8")).toBe(before);
	});

	it("rejects stale adoption, nonzero historical replay, and marker tampering", () => {
		const { stateDir, environment } = fixture("rejections");
		const now = Date.parse("2026-09-16T05:00:00.000Z");
		const owners = [
			{
				projectName: "qa",
				leadId: "raya",
				chatChannelId: "123456789012345678",
			},
		];
		const rolloutAfter = snowflakeAt(now);
		freezeFounderThreadIngressRollout({
			stateDir,
			environment,
			owners,
			rolloutAfter,
			nowMs: now,
		});
		expect(() =>
			activateFounderThreadIngressRollout({
				stateDir,
				environment,
				currentOwners: owners,
				nowMs: now + 16 * 60_000,
				dryRun: { rolloutAfter, automaticReplayBeforeBoundary: 0 },
			}),
		).toThrow("rollout_marker_stale");
		expect(() =>
			activateFounderThreadIngressRollout({
				stateDir,
				environment,
				currentOwners: owners,
				nowMs: now + 60_000,
				dryRun: { rolloutAfter, automaticReplayBeforeBoundary: 1 },
			}),
		).toThrow("historical_replay_not_zero");

		const markerPath = join(stateDir, FOUNDER_THREAD_INGRESS_MARKER_FILE);
		chmodSync(markerPath, 0o600);
		writeFileSync(markerPath, "{}\n", { mode: 0o600 });
		expect(
			loadFounderThreadIngressRollout({
				stateDir,
				environment,
				currentOwners: owners,
				nowMs: now + 60_000,
			}),
		).toMatchObject({ kind: "inactive", reason: "marker_invalid" });
	});

	it("refuses copied activation artifacts from a different state environment", () => {
		const qa = fixture("qa");
		const production = fixture("production");
		const now = Date.parse("2026-09-16T05:00:00.000Z");
		const owners = [
			{
				projectName: "qa",
				leadId: "raya",
				chatChannelId: "123456789012345678",
			},
		];
		const rolloutAfter = snowflakeAt(now);
		freezeFounderThreadIngressRollout({
			stateDir: qa.stateDir,
			environment: qa.environment,
			owners,
			rolloutAfter,
			nowMs: now,
		});
		activateFounderThreadIngressRollout({
			stateDir: qa.stateDir,
			environment: qa.environment,
			currentOwners: owners,
			nowMs: now + 60_000,
			dryRun: { rolloutAfter, automaticReplayBeforeBoundary: 0 },
		});
		for (const file of [
			FOUNDER_THREAD_INGRESS_MARKER_FILE,
			FOUNDER_THREAD_INGRESS_ACTIVATION_FILE,
		]) {
			writeFileSync(
				join(production.stateDir, file),
				readFileSync(join(qa.stateDir, file)),
				{ mode: 0o600 },
			);
		}
		expect(
			loadFounderThreadIngressRollout({
				stateDir: production.stateDir,
				environment: production.environment,
				currentOwners: owners,
				nowMs: now + 60_000,
			}),
		).toMatchObject({ kind: "inactive", reason: "environment_mismatch" });
	});
});
