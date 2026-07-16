import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureLeaseEpisodeMaterialized,
	LeadLeaseEpisodeStore,
	recoverLeaseEpisode,
} from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadAlertNotifier } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

describe("FLY-1309 episode-aware alert drain", () => {
	let dir: string;
	let queueDir: string;
	let deadLetterDir: string;
	let episodeDbPath: string;
	let env: NodeJS.ProcessEnv;
	let state: StateStore;

	const projects: ProjectEntry[] = [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "eng-lead",
					match: { labels: ["eng"] },
					alertChannel: "alerts",
					botToken: "token",
				},
			],
		},
	];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-episode-drain-"));
		queueDir = join(dir, "queue");
		deadLetterDir = join(dir, "dead");
		episodeDbPath = join(dir, "episodes.db");
		env = {
			FLYWHEEL_ALERT_QUEUE_DIR: queueDir,
			FLYWHEEL_LEAD_EPISODE_DB: episodeDbPath,
		};
		state = await StateStore.create(":memory:");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function ensure(sourceFingerprint = "lead_lease_store_broken:/lease.db") {
		return ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint,
			kind: "lead_lease_store_broken",
			payload: {
				leadId: "eng-lead",
				projectName: "flywheel",
				title: "lease store broken",
				body: "repair it",
				severity: "severe",
			},
		});
	}

	function notifier(fetchFn: typeof fetch, queueMax?: number) {
		return new LeadAlertNotifier({
			store: state,
			projects,
			queueDir,
			deadLetterDir,
			episodeDbPath,
			fetchFn,
			...(queueMax === undefined ? {} : { queueMax }),
		});
	}

	it("acks delivery in SQLite before unlinking the queue file", async () => {
		const episode = ensure();
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "message" }), { status: 200 }),
		) as unknown as typeof fetch;
		expect(await notifier(fetchFn).drainQueue()).toMatchObject({ sent: 1 });
		expect(readdirSync(queueDir)).toEqual([]);
		const store = new LeadLeaseEpisodeStore(episodeDbPath);
		expect(store.getEpisode(episode.episodeId)?.deliveryState).toBe(
			"delivered",
		);
		store.close();
	});

	it("removes an acked leftover without reposting", async () => {
		const episode = ensure();
		const store = new LeadLeaseEpisodeStore(episodeDbPath);
		store.markDelivery(episode.episodeId, "delivered");
		store.close();
		const fetchFn = vi.fn() as unknown as typeof fetch;
		await notifier(fetchFn).drainQueue();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(queueDir)).toEqual([]);
	});

	it("rebuilds a missing episode DB row from the durable queue before delivery", async () => {
		const episode = ensure();
		rmSync(episodeDbPath, { force: true });
		rmSync(`${episodeDbPath}-wal`, { force: true });
		rmSync(`${episodeDbPath}-shm`, { force: true });
		const fetchFn = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof fetch;
		expect(await notifier(fetchFn).drainQueue()).toMatchObject({ sent: 1 });
		const store = new LeadLeaseEpisodeStore(episodeDbPath);
		expect(store.getEpisode(episode.episodeId)).toMatchObject({
			deliveryState: "delivered",
			faultState: "recovered",
		});
		store.close();
	});

	it("marks terminal dead-letter state before moving a capped file", async () => {
		const episode = ensure();
		const fetchFn = vi.fn() as unknown as typeof fetch;
		expect(await notifier(fetchFn, 0).drainQueue()).toMatchObject({
			deadLettered: 1,
		});
		const store = new LeadLeaseEpisodeStore(episodeDbPath);
		expect(store.getEpisode(episode.episodeId)).toMatchObject({
			deliveryState: "dead_lettered",
			deliveryReason: "queue-cap",
		});
		store.close();
	});

	it("drains recovered E1 and active E2 independently without moving the E2 pointer", async () => {
		const source = "lead_backend_drift:carrier:flywheel-eng-lead";
		const e1 = ensure(source);
		expect(
			recoverLeaseEpisode({
				env,
				sourceFingerprint: source,
				expectedEpisodeId: e1.episodeId,
			}),
		).toBe(true);
		const e2 = ensure(source);
		const fetchFn = vi.fn(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof fetch;
		expect(await notifier(fetchFn).drainQueue()).toMatchObject({ sent: 2 });
		const store = new LeadLeaseEpisodeStore(episodeDbPath);
		expect(store.getEpisode(e1.episodeId)?.deliveryState).toBe("delivered");
		expect(store.getEpisode(e2.episodeId)?.deliveryState).toBe("delivered");
		expect(store.getActive(source)?.episodeId).toBe(e2.episodeId);
		store.close();
	});
});
