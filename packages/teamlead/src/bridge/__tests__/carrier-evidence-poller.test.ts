import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hashCarrierInstanceId,
	publishCarrierRuntimeAssertion,
} from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	ConfigSnapshotProvider,
	FleetPoller,
	type FleetProbeDeps,
} from "../fleet-data.js";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const RAW_CLAIM = "runtime-only-carrier-capability";
const IDENTITY_DIGEST = "a".repeat(64);

describe("FLY-1309 FleetPoller carrier evidence single-writer path", () => {
	let dir: string;
	let alive: boolean;
	let env: NodeJS.ProcessEnv;
	let projects: ProjectEntry[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-fleet-carrier-"));
		alive = true;
		env = {
			FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR: join(dir, "assertions"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "evidence.json"),
		};
		projects = [
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					{
						agentId: "codex-lead",
						chatChannel: "1",
						match: { labels: ["codex"] },
						backend: "codex-app-server",
					},
				],
			},
		];
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function makePoller(carrierWiring = true): FleetPoller {
		const deps: FleetProbeDeps = {
			readFile: (path) => readFileSync(path, "utf8"),
			fileExists: existsSync,
			pidAlive: (pid) => alive && pid === 777,
			launchdPrint: async () => ({ loaded: false, pid: 0 }),
			listPanes: async () => [],
			processCommandsOf: async () => [],
			homeDir: () => dir,
			now: () => new Date(NOW),
		};
		return new FleetPoller({
			provider: new ConfigSnapshotProvider(projects, {
				loadProjects: () => projects,
				envPinned: false,
			}),
			legacyBackendOf: () => undefined,
			deps,
			...(carrierWiring
				? {
						carrierEnv: env,
						processAliveWithStart: (pid: number, lstart: string) =>
							alive && pid === 777 && lstart === "carrier-start",
					}
				: {}),
		});
	}

	it("turns an old-but-live per-lead assertion into a fresh full snapshot", async () => {
		publishCarrierRuntimeAssertion({
			env,
			leadKey: "flywheel-codex-lead",
			identityDigest: IDENTITY_DIGEST,
			rawCarrierInstanceId: RAW_CLAIM,
			pid: 777,
			lstart: "carrier-start",
			now: "2025-01-01T00:00:00.000Z",
		});
		expect(existsSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!)).toBe(false);

		await makePoller().collectOnce();

		const raw = readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!, "utf8");
		expect(raw).not.toContain(RAW_CLAIM);
		expect(JSON.parse(raw)).toMatchObject({
			schemaVersion: 1,
			collectedAt: new Date(NOW).toISOString(),
			leads: {
				"flywheel-codex-lead": {
					identityDigest: IDENTITY_DIGEST,
					pid: 777,
					lstart: "carrier-start",
					instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
				},
			},
		});
	});

	it("removes evidence on death or PID reuse instead of preserving a stale entry", async () => {
		publishCarrierRuntimeAssertion({
			env,
			leadKey: "flywheel-codex-lead",
			identityDigest: IDENTITY_DIGEST,
			rawCarrierInstanceId: RAW_CLAIM,
			pid: 777,
			lstart: "carrier-start",
		});
		const poller = makePoller();
		await poller.collectOnce();
		alive = false;
		await poller.collectOnce();

		expect(
			JSON.parse(
				readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!, "utf8"),
			),
		).toMatchObject({ leads: {} });
	});

	it("rejects assertions copied under another canonical identity", async () => {
		const assertionDir = env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR!;
		publishCarrierRuntimeAssertion({
			env,
			leadKey: "other-project-codex-lead",
			identityDigest: IDENTITY_DIGEST,
			rawCarrierInstanceId: RAW_CLAIM,
			pid: 777,
			lstart: "carrier-start",
		});
		writeFileSync(
			join(assertionDir, `${encodeURIComponent("flywheel-codex-lead")}.json`),
			readFileSync(
				join(
					assertionDir,
					`${encodeURIComponent("other-project-codex-lead")}.json`,
				),
			),
		);

		await makePoller().collectOnce();

		expect(
			JSON.parse(
				readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!, "utf8"),
			),
		).toMatchObject({ leads: {} });
	});
});
