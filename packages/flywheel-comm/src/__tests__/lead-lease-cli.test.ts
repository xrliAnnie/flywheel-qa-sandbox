import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLeadLeaseCommand } from "../commands/lead-lease.js";
import { LeadLeaseStore, type ProcessTupleState } from "../lead-lease.js";

describe("flywheel-comm lead-lease", () => {
	const IDENTITY_DIGEST = "a".repeat(64);
	let dir: string;
	let env: Record<string, string>;
	let stdout: string[];
	let stderr: string[];
	let tupleStates: Record<string, ProcessTupleState>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-cli-"));
		mkdirSync(join(dir, ".flywheel"), { recursive: true });
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "test",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		env = {
			FLYWHEEL_STATE_DIR: join(dir, ".flywheel"),
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lease.db"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "lease-episodes.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "mode.json"),
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
		};
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [{ agentId: "eng-lead", summaryRole: "producer" }],
				},
			]),
		);
		stdout = [];
		stderr = [];
		tupleStates = {};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function run(args: string[]): Promise<number> {
		return runLeadLeaseCommand(args, {
			env,
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
			leaseStoreDeps: {
				processTupleState: (pid, start) =>
					tupleStates[`${pid}:${start}`] ?? "dead",
			},
		});
	}

	it("resolves a canonical identity as JSON", async () => {
		expect(await run(["resolve", "--lead", "eng-lead", "--json"])).toBe(0);
		expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
			status: "ok",
			canonicalProject: "flywheel",
			leadKey: "flywheel-eng-lead",
		});
	});

	it("acquires, reports unbound status, binds, and reports bound status", async () => {
		expect(
			await run([
				"acquire",
				"--lead",
				"eng-lead",
				"--project",
				"flywheel",
				"--lead-key",
				"flywheel-eng-lead",
				"--identity-digest",
				IDENTITY_DIGEST,
				"--supervisor-pid",
				String(process.pid),
				"--supervisor-start",
				"supervisor-start",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "acquired",
			generation: 1,
			leadKey: "flywheel-eng-lead",
			supervisorPid: process.pid,
			supervisorStart: "supervisor-start",
			holderPid: process.pid,
			holderStart: "supervisor-start",
		});

		expect(
			await run(["status", "--lead-key", "flywheel-eng-lead", "--json"]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			mode: { mode: "audit_only", source: "default" },
			lease: { generation: 1, boundAt: null },
		});

		expect(
			await run([
				"bind",
				"--lead-key",
				"flywheel-eng-lead",
				"--generation",
				"1",
				"--supervisor-pid",
				String(process.pid),
				"--supervisor-start",
				"supervisor-start",
				"--pane-pid",
				String(process.pid + 1),
				"--pane-start",
				"pane-start",
				"--identity-digest",
				IDENTITY_DIGEST,
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "bound",
			generation: 1,
		});
	});

	it("reports atomic progress and typed verify-bound evidence", async () => {
		expect(
			await run([
				"progress-snapshot",
				"--lead",
				"eng-lead",
				"--project",
				"flywheel",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toEqual({ status: "absent" });

		const store = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB, {
			processAliveWithStart: () => false,
		});
		store.acquire({
			leadKey: "flywheel-eng-lead",
			project: "flywheel",
			leadId: "eng-lead",
			identityDigest: IDENTITY_DIGEST,
			supervisorPid: 100,
			supervisorStart: "supervisor-old",
			acquiredBy: "seed",
			now: "2026-08-03T01:00:00.000Z",
		});
		store.bind({
			leadKey: "flywheel-eng-lead",
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: "supervisor-old",
			identityDigest: IDENTITY_DIGEST,
			panePid: 200,
			paneStart: "holder-old",
			now: "2026-08-03T01:00:01.000Z",
		});
		store.close();

		expect(
			await run([
				"progress-snapshot",
				"--lead",
				"eng-lead",
				"--project",
				"flywheel",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "present",
			rowFormat: "version_valid",
			generation: 1,
			supervisorPid: 100,
			holderPid: 200,
		});

		expect(
			await run([
				"verify-bound",
				"--lead-key",
				"flywheel-eng-lead",
				"--supervisor-pid",
				"999",
				"--supervisor-start",
				"supervisor-old",
				"--holder-pid",
				"200",
				"--holder-start",
				"holder-old",
				"--identity-digest",
				IDENTITY_DIGEST,
				"--json",
			]),
		).toBe(3);
		expect(JSON.parse(stdout.pop() ?? "")).toEqual({
			status: "mismatch",
			reason: "supervisor_mismatch",
		});

		expect(
			await run([
				"verify-bound",
				"--lead-key",
				"flywheel-eng-lead",
				"--supervisor-pid",
				"100",
				"--supervisor-start",
				"supervisor-old",
				"--holder-pid",
				"200",
				"--holder-start",
				"holder-old",
				"--identity-digest",
				IDENTITY_DIGEST,
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toEqual({
			status: "verified",
			generation: 1,
		});
	});

	it("classifies an orphan through the CLI", async () => {
		const holderStart = "holder-live";
		const oldSupervisorPid = 2_000_000_000;
		const seed = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB, {
			processAliveWithStart: () => false,
		});
		seed.acquire({
			leadKey: "flywheel-eng-lead",
			project: "flywheel",
			leadId: "eng-lead",
			identityDigest: IDENTITY_DIGEST,
			supervisorPid: oldSupervisorPid,
			supervisorStart: "supervisor-old",
			acquiredBy: "seed",
		});
		seed.bind({
			leadKey: "flywheel-eng-lead",
			generation: 1,
			expectedSupervisorPid: oldSupervisorPid,
			expectedSupervisorStart: "supervisor-old",
			identityDigest: IDENTITY_DIGEST,
			panePid: process.pid,
			paneStart: holderStart,
		});
		seed.close();

		tupleStates[`${oldSupervisorPid}:supervisor-old`] = "dead";
		tupleStates[`${process.pid}:${holderStart}`] = "alive";
		const newSupervisorStart = "supervisor-new";
		expect(
			await run([
				"acquire",
				"--lead",
				"eng-lead",
				"--project",
				"flywheel",
				"--lead-key",
				"flywheel-eng-lead",
				"--identity-digest",
				IDENTITY_DIGEST,
				"--supervisor-pid",
				String(process.pid),
				"--supervisor-start",
				newSupervisorStart,
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "holder_orphaned",
			generation: 1,
			holderPid: process.pid,
			supervisorPid: oldSupervisorPid,
		});
	});

	it("maps both fail-closed acquire denials to exit 3 without folding statuses", async () => {
		const first = [
			"acquire",
			"--lead",
			"eng-lead",
			"--project",
			"flywheel",
			"--lead-key",
			"flywheel-eng-lead",
			"--identity-digest",
			IDENTITY_DIGEST,
			"--supervisor-pid",
			"100",
			"--supervisor-start",
			"supervisor-old",
			"--json",
		];
		expect(await run(first)).toBe(0);
		stdout.pop();

		const contender = [...first];
		contender[contender.indexOf("--supervisor-pid") + 1] = "101";
		contender[contender.indexOf("--supervisor-start") + 1] = "supervisor-new";
		tupleStates["100:supervisor-old"] = "alive";
		expect(await run(contender)).toBe(3);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "denied_holder_alive",
			generation: 1,
		});

		tupleStates["100:supervisor-old"] = "sensor_error";
		expect(await run(contender)).toBe(3);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "denied_sensor_degraded",
			generation: 1,
		});
	});

	it("maps typed identity drift denials to exit 3", async () => {
		const acquire = [
			"acquire",
			"--lead",
			"eng-lead",
			"--project",
			"flywheel",
			"--lead-key",
			"flywheel-eng-lead",
			"--identity-digest",
			IDENTITY_DIGEST,
			"--supervisor-pid",
			"100",
			"--supervisor-start",
			"supervisor-old",
			"--json",
		];
		expect(await run(acquire)).toBe(0);
		stdout.pop();

		const changed = [...acquire];
		changed[changed.indexOf("--identity-digest") + 1] = "b".repeat(64);
		changed[changed.indexOf("--supervisor-pid") + 1] = "101";
		changed[changed.indexOf("--supervisor-start") + 1] = "supervisor-new";

		tupleStates["100:supervisor-old"] = "alive";
		expect(await run(changed)).toBe(3);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "denied_identity_drift_live",
			generation: 1,
		});

		tupleStates["100:supervisor-old"] = "sensor_error";
		expect(await run(changed)).toBe(3);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "denied_identity_drift_sensor_degraded",
			generation: 1,
		});
	});

	it("sets mode in the independent control file", async () => {
		expect(
			await run(["set-mode", "enforce", "--updated-by", "test", "--json"]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toEqual({
			mode: "enforce",
			source: "file",
		});
	});

	it("has no release command", async () => {
		expect(await run(["release", "--lead-key", "flywheel-eng-lead"])).toBe(2);
		expect(stderr.join("\n")).toContain("unknown lead-lease subcommand");
	});
});
