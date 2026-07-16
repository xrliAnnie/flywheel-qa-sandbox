import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureLeaseEpisodeMaterialized,
	LeadLeaseStore,
} from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LeadDualActiveMonitor,
	type LeadScanTarget,
	LeaseAuditOutbox,
	parseLeadProcessTable,
} from "../bridge/lead-dual-active-scan.js";

const CLAUDE_TARGET: LeadScanTarget = {
	projectName: "flywheel",
	leadId: "eng-lead",
	desiredBackend: "claude-code",
};
const CODEX_TARGET: LeadScanTarget = {
	...CLAUDE_TARGET,
	desiredBackend: "codex-app-server",
	carrierDisposition: "carrier_passthrough",
};

const PS_TWO = [
	"101 Thu Jul 16 01:00:00 2026 /opt/bin/claude --agent eng-lead --resume old",
	"202 Thu Jul 16 02:00:00 2026 /opt/bin/claude --agent=eng-lead --resume new",
].join("\n");

describe("FLY-1309 dual-active process parsing", () => {
	it("matches exact Claude executable and both agent spellings", () => {
		const parsed = parseLeadProcessTable(
			[
				PS_TWO,
				"303 Thu Jul 16 03:00:00 2026 /opt/bin/not-claude --agent eng-lead",
				"404 Thu Jul 16 04:00:00 2026 /opt/bin/claude --agent-id eng-lead",
				"505 Thu Jul 16 05:00:00 2026 /opt/bin/claude --prompt=--agent=eng-lead",
				"606 Thu Jul 16 06:00:00 2026 /opt/bin/claude --agent eng-lead-shadow",
			].join("\n"),
		);
		expect(
			parsed
				.filter((row) => row.leadId === "eng-lead")
				.map((row) => [row.pid, row.leadId]),
		).toEqual([
			[101, "eng-lead"],
			[202, "eng-lead"],
		]);
		expect(parsed.find((row) => row.pid === 606)?.leadId).toBe(
			"eng-lead-shadow",
		);
	});
});

describe("FLY-1309 dual-active monitor", () => {
	it("debounces two ticks, emits once, and identifies the later process", async () => {
		const notify = vi.fn(async () => {});
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () => PS_TWO,
			notify,
		});
		await monitor.tick([CLAUDE_TARGET]);
		expect(notify).not.toHaveBeenCalled();
		await monitor.tick([CLAUDE_TARGET]);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			kind: "lead_dual_active",
			leadId: "eng-lead",
			laterPid: 202,
			ambiguousOrder: false,
		});
		await monitor.tick([CLAUDE_TARGET]);
		expect(notify).toHaveBeenCalledOnce();
	});

	it("marks process order ambiguous when launch times tie", async () => {
		const notify = vi.fn(async () => {});
		const tied = PS_TWO.replace("02:00:00", "01:00:00");
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () => tied,
			notify,
		});
		await monitor.tick([CLAUDE_TARGET]);
		await monitor.tick([CLAUDE_TARGET]);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			laterPid: null,
			ambiguousOrder: true,
		});
	});

	it("treats one Claude argv under a desired Codex identity as an intruder", async () => {
		const notify = vi.fn(async () => {});
		const one = PS_TWO.split("\n")[0]!;
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () => one,
			notify,
		});
		await monitor.tick([CODEX_TARGET]);
		await monitor.tick([CODEX_TARGET]);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			kind: "lead_backend_drift",
			laterPid: 101,
			carrierDisposition: "carrier_passthrough",
		});
	});

	it("keeps a healthy desired-Codex identity with zero Claude argv quiet", async () => {
		const notify = vi.fn(async () => {});
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () =>
				"777 Thu Jul 16 03:00:00 2026 /usr/bin/codex app-server",
			notify,
		});
		await monitor.tick([CODEX_TARGET]);
		await monitor.tick([CODEX_TARGET]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not scan when the kill switch is off", async () => {
		const readProcessTable = vi.fn(async () => PS_TWO);
		const monitor = new LeadDualActiveMonitor({
			readProcessTable,
			notify: async () => {},
			enabled: false,
		});
		await monitor.tick([CLAUDE_TARGET]);
		expect(readProcessTable).not.toHaveBeenCalled();
	});

	it("emits one degraded-sensor episode after ten consecutive failures", async () => {
		const notify = vi.fn(async () => {});
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () => {
				throw new Error("ps unavailable");
			},
			notify,
		});
		for (let i = 0; i < 12; i++) await monitor.tick([CLAUDE_TARGET]);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			kind: "lead_dual_active_sensor_degraded",
		});
	});

	it("recovers after two clean ticks and emits exactly one new recurrence", async () => {
		const notify = vi.fn(async () => {});
		const onRecovery = vi.fn(async () => {});
		let snapshot = PS_TWO;
		const monitor = new LeadDualActiveMonitor({
			readProcessTable: async () => snapshot,
			notify,
			onRecovery,
		});
		await monitor.tick([CLAUDE_TARGET]);
		await monitor.tick([CLAUDE_TARGET]);
		snapshot = "";
		await monitor.tick([CLAUDE_TARGET]);
		await monitor.tick([CLAUDE_TARGET]);
		expect(onRecovery).toHaveBeenCalledOnce();
		snapshot = PS_TWO;
		await monitor.tick([CLAUDE_TARGET]);
		await monitor.tick([CLAUDE_TARGET]);
		expect(notify).toHaveBeenCalledTimes(2);
	});
});

describe("FLY-1309 lease audit durable outbox", () => {
	let dir: string;
	let dbPath: string;
	let queueDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-audit-outbox-"));
		dbPath = join(dir, "lease.db");
		queueDir = join(dir, "queue");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function appendRows(): void {
		const store = new LeadLeaseStore(dbPath);
		store.appendAudit({
			leadKey: "flywheel-eng-lead",
			event: "would_block",
			detail: "stale_generation",
			createdAt: "2026-07-16T01:00:00.000Z",
		});
		store.appendAudit({
			leadKey: "flywheel-eng-lead",
			event: "would_block",
			detail: "unbound",
			createdAt: "2026-07-16T01:00:01.000Z",
		});
		store.close();
	}

	it("fsync-materializes one deterministic batch before marking rows", () => {
		appendRows();
		const outbox = new LeaseAuditOutbox({ dbPath, queueDir });
		expect(outbox.materialize()).toMatchObject({ materialized: 1, rows: 2 });
		const files = readdirSync(queueDir);
		expect(files).toHaveLength(1);
		const payload = JSON.parse(readFileSync(join(queueDir, files[0]!), "utf8"));
		expect(payload).toMatchObject({
			eventType: "lead_lease_would_block",
			queuedAt: "2026-07-16T01:00:00.000Z",
			leaseAudit: { rowIds: [1, 2] },
		});
		const verify = new LeadLeaseStore(dbPath);
		expect(verify.listPendingAudit()).toEqual([]);
		verify.close();
	});

	it("recovers rename-before-DB-ack without duplicating the queue file", () => {
		appendRows();
		const crashing = new LeaseAuditOutbox({
			dbPath,
			queueDir,
			afterFileCommit: () => {
				throw new Error("crash after rename");
			},
		});
		expect(() => crashing.materialize()).toThrow("crash after rename");
		expect(readdirSync(queueDir)).toHaveLength(1);
		const verifyPending = new LeadLeaseStore(dbPath);
		expect(verifyPending.listPendingAudit()).toHaveLength(2);
		verifyPending.close();

		const recovered = new LeaseAuditOutbox({ dbPath, queueDir });
		expect(recovered.materialize()).toMatchObject({ materialized: 1, rows: 2 });
		expect(readdirSync(queueDir)).toHaveLength(1);
	});

	it("uses store epoch in batch identity after DB recreation", () => {
		appendRows();
		new LeaseAuditOutbox({ dbPath, queueDir }).materialize();
		const first = readdirSync(queueDir)[0]!;
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		appendRows();
		new LeaseAuditOutbox({ dbPath, queueDir }).materialize();
		const files = readdirSync(queueDir);
		expect(files).toHaveLength(2);
		expect(files).not.toEqual([first, first]);
	});

	it("never skip-acks an existing mismatched batch file", () => {
		appendRows();
		const first = new LeaseAuditOutbox({
			dbPath,
			queueDir,
			afterFileCommit: () => {
				throw new Error("stop");
			},
		});
		expect(() => first.materialize()).toThrow();
		const file = readdirSync(queueDir)[0]!;
		writeFileSync(join(queueDir, file), JSON.stringify({ leaseAudit: {} }));
		expect(() =>
			new LeaseAuditOutbox({ dbPath, queueDir }).materialize(),
		).toThrow(/mismatch|invalid/i);
		const verify = new LeadLeaseStore(dbPath);
		expect(verify.listPendingAudit()).toHaveLength(2);
		verify.close();
		expect(existsSync(join(queueDir, file))).toBe(true);
	});

	it("retention never removes an old unmaterialized audit row", () => {
		appendRows();
		const outbox = new LeaseAuditOutbox({
			dbPath,
			queueDir,
			now: () => new Date("2026-08-16T00:00:00.000Z"),
			afterFileCommit: () => {
				throw new Error("leave rows pending");
			},
		});
		expect(() => outbox.materialize()).toThrow("leave rows pending");
		const verify = new LeadLeaseStore(dbPath);
		expect(verify.listPendingAudit()).toHaveLength(2);
		verify.close();
	});

	it("acknowledges backend-drift audit rows without a second generic alert when the specialized episode is active", () => {
		const episodeDbPath = join(dir, "episodes.db");
		ensureLeaseEpisodeMaterialized({
			env: {
				FLYWHEEL_LEAD_EPISODE_DB: episodeDbPath,
				FLYWHEEL_ALERT_QUEUE_DIR: queueDir,
			},
			sourceFingerprint: "lead_backend_drift:carrier:flywheel-eng-lead",
			kind: "lead_backend_drift",
			payload: {
				leadId: "eng-lead",
				projectName: "flywheel",
				title: "drift",
				body: "drift",
				severity: "severe",
			},
		});
		const specializedFile = readdirSync(queueDir)[0]!;
		const store = new LeadLeaseStore(dbPath);
		store.appendAudit({
			leadKey: "flywheel-eng-lead",
			event: "would_block",
			detail: JSON.stringify({
				reason: "backend_drift:carrier_claim_missing",
				claimedLeadId: "eng-lead",
			}),
		});
		store.close();

		expect(
			new LeaseAuditOutbox({ dbPath, queueDir, episodeDbPath }).materialize(),
		).toMatchObject({ materialized: 1, rows: 1 });
		expect(readdirSync(queueDir)).toEqual([specializedFile]);
		const verify = new LeadLeaseStore(dbPath);
		expect(verify.listPendingAudit()).toEqual([]);
		verify.close();
	});
});
