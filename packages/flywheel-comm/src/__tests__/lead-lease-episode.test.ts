import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureLeaseEpisodeMaterialized,
	LeadLeaseEpisodeStore,
	reconcileLeaseEpisodeQueue,
	recoverLeaseEpisode,
} from "../lead-lease.js";

describe("FLY-1309 durable Lead lease episodes", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-episode-"));
		env = {
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "episodes.db"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(dir, "queue"),
			FLYWHEEL_ALERT_DEADLETTER_DIR: join(dir, "dead"),
			FLYWHEEL_LEAD_LEASE_AUDIT_LOG: join(dir, "audit.log"),
		};
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const payload = {
		leadId: "eng-lead",
		projectName: "flywheel",
		title: "Lead lease store broken",
		body: "repair the lease store",
		severity: "severe" as const,
	};

	it("coalesces repeated and cross-process ensure calls into one active episode and queue file", () => {
		const first = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_lease_store_broken:/state/lease.db",
			kind: "lead_lease_store_broken",
			payload,
			now: "2026-07-16T08:00:00.000Z",
		});
		const second = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_lease_store_broken:/state/lease.db",
			kind: "lead_lease_store_broken",
			payload,
			now: "2026-07-16T08:00:01.000Z",
		});
		expect(second.episodeId).toBe(first.episodeId);
		expect(second.created).toBe(false);
		expect(readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toHaveLength(1);

		const store = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		expect(store.getActive(first.sourceFingerprint)?.episodeId).toBe(
			first.episodeId,
		);
		expect(store.listPending()).toHaveLength(1);
		store.close();
	});

	it("uses compare-and-clear recovery so a stale E1 recovery cannot erase E2", () => {
		const e1 = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_backend_drift:claude_intruder:flywheel-eng-lead",
			kind: "lead_backend_drift",
			payload,
		});
		expect(
			recoverLeaseEpisode({
				env,
				sourceFingerprint: e1.sourceFingerprint,
				expectedEpisodeId: e1.episodeId,
			}),
		).toBe(true);
		const e2 = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: e1.sourceFingerprint,
			kind: "lead_backend_drift",
			payload,
		});
		expect(e2.episodeId).not.toBe(e1.episodeId);
		expect(
			recoverLeaseEpisode({
				env,
				sourceFingerprint: e1.sourceFingerprint,
				expectedEpisodeId: e1.episodeId,
			}),
		).toBe(false);
		const store = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		expect(store.getActive(e1.sourceFingerprint)?.episodeId).toBe(e2.episodeId);
		expect(store.getEpisode(e1.episodeId)?.faultState).toBe("recovered");
		expect(store.getEpisode(e2.episodeId)?.faultState).toBe("active");
		store.close();
	});

	it("reconciles a recovered unmaterialized episode without requiring the fault to recur", () => {
		const store = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		const ensured = store.ensure({
			sourceFingerprint: "lead_identity_source_broken:/state/projects.json",
			kind: "lead_identity_source_broken",
			payload,
		});
		expect(
			store.recover(
				ensured.episode.sourceFingerprint,
				ensured.episode.episodeId,
			),
		).toBe(true);
		store.close();

		expect(reconcileLeaseEpisodeQueue(env)).toMatchObject({ materialized: 1 });
		const file = readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)[0]!;
		const queued = JSON.parse(
			readFileSync(join(env.FLYWHEEL_ALERT_QUEUE_DIR!, file), "utf8"),
		);
		expect(queued).toMatchObject({
			episodeId: ensured.episode.episodeId,
			eventType: "lead_identity_source_broken",
		});
	});

	it("delivery terminal states never rematerialize while the same fault remains active", () => {
		const ensured = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_lease_control_broken:/state/mode.json",
			kind: "lead_lease_control_broken",
			payload,
		});
		const store = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		store.markDelivery(ensured.episodeId, "delivered");
		store.close();
		rmSync(env.FLYWHEEL_ALERT_QUEUE_DIR!, { recursive: true, force: true });

		const repeated = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: ensured.sourceFingerprint,
			kind: "lead_lease_control_broken",
			payload,
		});
		expect(repeated.episodeId).toBe(ensured.episodeId);
		expect(existsSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toBe(false);
	});
});
