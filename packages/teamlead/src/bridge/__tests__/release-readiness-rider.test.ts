import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { isReadinessHeartbeatHealthy } from "../release-readiness/evaluate.js";
import {
	projectShellObservations,
	ReleaseReadinessRider,
	scanFounderReactions,
} from "../release-readiness/ingest-rider.js";

const sha = "a".repeat(40);
const now = "2026-09-11T12:00:00.000Z";

it("scans every page before accepting founder sentiment and preserves previous down on failure", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const publication = {
			publicationId: "rp-reactions",
			day: "2026-09-11",
			subjectCommit: sha,
			baseVersion: "1.56.0",
			status: "published" as const,
			channelId: "123",
			messageId: "456",
			intentAt: now,
			publishedAt: now,
			firstScanOkAt: null,
			lastScanOkAt: null,
			lastScanAt: null,
			lastScanError: null,
		};
		store.upsertReleasePublication(publication);
		const fetchReactions = vi.fn(
			async ({ emoji, after }: { emoji: string; after?: string }) => ({
				status: 200,
				body: !after
					? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }))
					: [{ id: emoji === "👎" ? "founder" : "other" }],
			}),
		);
		await scanFounderReactions(
			store,
			[publication],
			now,
			"founder",
			fetchReactions,
		);
		expect(fetchReactions).toHaveBeenCalledTimes(4);
		expect(
			store.getReleaseReadinessEvidence(sha, now, now).founderVerdicts[0]
				?.sentiment,
		).toBe("down");
		await scanFounderReactions(
			store,
			[publication],
			now,
			"founder",
			async ({ after }) =>
				after
					? { status: 429 }
					: {
							status: 200,
							body: Array.from({ length: 100 }, (_, i) => ({
								id: i === 0 ? "founder" : String(i),
							})),
						},
		);
		const evidence = store.getReleaseReadinessEvidence(sha, now, now);
		expect(evidence.publications[0]?.lastScanError).toContain("429");
		expect(evidence.founderVerdicts[0]?.sentiment).toBe("down");
		let page = 0;
		await scanFounderReactions(
			store,
			[publication],
			now,
			"founder",
			async () => ({
				status: 200,
				body: Array.from({ length: 100 }, (_, i) => ({
					id: String(++page * 100 + i),
				})),
			}),
		);
		expect(page).toBe(2000);
		expect(
			store.getReleaseReadinessEvidence(sha, now, now).publications[0]
				?.lastScanError,
		).toContain("page limit");
		const second = {
			...publication,
			publicationId: "rp-next",
			day: "2026-09-12",
			messageId: "789",
		};
		store.upsertReleasePublication(second);
		await scanFounderReactions(
			store,
			[publication, second],
			now,
			"founder",
			async ({ messageId, emoji }) => ({
				status: 200,
				body: messageId === "789" && emoji === "👍" ? [{ id: "founder" }] : [],
			}),
		);
		const recovered = store.getReleaseReadinessEvidence(sha, now, now);
		expect(recovered.publications.every((p) => p.lastScanError === null)).toBe(
			true,
		);
		expect(recovered.founderVerdicts.map((v) => v.sentiment)).toEqual([
			"down",
			"up",
		]);
	} finally {
		store.close();
	}
});

it("retains failed publication ingestion and admits only one concurrent tick", async () => {
	const root = mkdtempSync(join(tmpdir(), "readiness-publication-"));
	const store = await StateStore.create(":memory:");
	try {
		mkdirSync(join(root, "publications"));
		const claims = new Database(join(root, "claims.db"));
		claims.exec(`CREATE TABLE alert_version_observations (
			event_id TEXT, source_commit_key TEXT, occurrence INTEGER,
			severity TEXT, project_name TEXT, kind TEXT, base_version TEXT, observed_at INTEGER)`);
		claims.close();
		const path = join(root, "publications", "2026-09-11.json");
		writeFileSync(
			path,
			JSON.stringify({
				publicationId: "rp-test",
				day: "2026-09-11",
				subjectCommit: sha,
				baseVersion: "1.56.0",
				status: "published",
				channelId: "123",
				messageId: "456",
				intentAt: now,
				publishedAt: now,
			}),
		);
		const rider = new ReleaseReadinessRider(store, {
			outboxRoot: root,
			claimsPath: join(root, "claims.db"),
			deployedShaPath: join(root, "absent-sha"),
			subject: { sourceCommit: sha, baseVersion: "1.56.0" },
			notifier: { peekCaptureFailures: () => 0, ackCaptureFailures: () => {} },
			sourceHealth: () => ({
				w1Freshness: "fresh",
				alertDeliveryEnabled: true,
			}),
		});
		vi.spyOn(store, "upsertReleasePublication").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		await Promise.all([rider.tick(now), rider.tick(now)]);
		const first = store.getReleaseReadinessEvidence(sha, now, now);
		expect(first.heartbeats).toHaveLength(1);
		expect(first.heartbeats[0]).toMatchObject({
			ingestOk: false,
			outboxPending: 1,
		});
		expect(isReadinessHeartbeatHealthy(first.heartbeats[0]!, 600)).toBe(false);
		expect(existsSync(path)).toBe(true);
		await rider.tick(now);
		expect(existsSync(path)).toBe(false);
		expect(
			store.getReleaseReadinessEvidence(sha, now, now).publications[0],
		).toMatchObject({
			status: "published",
			messageId: "456",
			lastScanOkAt: null,
		});
		const recovered = store.getReleaseReadinessEvidence(sha, now, now)
			.heartbeats[1]!;
		expect(recovered).toMatchObject({
			ingestOk: true,
			outboxPending: 0,
			outboxInvalid: 0,
		});
		expect(isReadinessHeartbeatHealthy(recovered, 600)).toBe(true);
		expect(store.getReleaseReadinessVerdicts(sha)).toEqual([]);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("lands outbox evidence and acknowledges sticky capture failures only after heartbeat commit", async () => {
	const root = mkdtempSync(join(tmpdir(), "readiness-tick-"));
	const store = await StateStore.create(":memory:");
	try {
		mkdirSync(join(root, "gaps"));
		mkdirSync(join(root, "publications"));
		writeFileSync(join(root, "deployed-sha"), sha);
		const gapPath = join(root, "gaps", "gap.intent.json");
		writeFileSync(
			gapPath,
			JSON.stringify({
				eventIdHint: null,
				kind: "deploy_failed",
				severity: "severe",
				projectName: "flywheel",
				leadId: "updater",
				sourceCommit: sha,
				baseVersion: "1.56.0",
				observedAt: now,
				reason: "shell_preflight",
			}),
		);
		let failures = 2;
		const ackCaptureFailures = vi.fn((count: number) => {
			failures -= count;
		});
		const rider = new ReleaseReadinessRider(store, {
			outboxRoot: root,
			claimsPath: join(root, "claims.db"),
			deployedShaPath: join(root, "deployed-sha"),
			subject: { sourceCommit: sha, baseVersion: "1.56.0" },
			notifier: { peekCaptureFailures: () => failures, ackCaptureFailures },
			sourceHealth: () => ({
				w1Freshness: "fresh",
				alertDeliveryEnabled: true,
			}),
		});
		vi.spyOn(store, "appendReleaseHeartbeat").mockImplementationOnce(() => {
			throw new Error("heartbeat disk failure");
		});
		await expect(rider.tick(now)).rejects.toThrow("heartbeat disk failure");
		expect(ackCaptureFailures).not.toHaveBeenCalled();
		expect(existsSync(gapPath)).toBe(false);
		expect(existsSync(join(root, "gaps", "landed", "gap.intent.json"))).toBe(
			true,
		);
		expect(store.getReleaseReadinessEvidence(sha, now, now).gaps).toHaveLength(
			1,
		);
		await rider.tick(now);
		expect(ackCaptureFailures).toHaveBeenCalledWith(2);
		expect(
			store.getReleaseReadinessEvidence(sha, now, now).heartbeats[0],
		).toMatchObject({
			bridgeCaptureFailures: 2,
			claimsDbOk: false,
			gapsDirOk: true,
		});
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("reports malformed attribution and preserves the cursor when projection fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "readiness-claims-errors-"));
	const path = join(root, "claims.db");
	const claims = new Database(path);
	const store = await StateStore.create(":memory:");
	try {
		claims.exec(`CREATE TABLE alert_version_observations (
			event_id TEXT, source_commit_key TEXT, occurrence INTEGER,
			severity TEXT, project_name TEXT, kind TEXT, base_version TEXT, observed_at INTEGER);
			INSERT INTO alert_version_observations VALUES ('bad', 'main', 1, 'warning', 'flywheel', 'deploy_failed', '1.56.0', ${Date.parse(now) / 1000 - 600});`);
		const fail = vi
			.spyOn(store, "projectReleaseSignalBatch")
			.mockImplementationOnce(() => {
				throw new Error("disk full");
			});
		expect(await projectShellObservations(store, path, now)).toMatchObject({
			ingestOk: false,
			claimsDbOk: true,
			backlogAgeS: 600,
		});
		expect(store.getReleaseSignalCursor()).toBeNull();
		fail.mockRestore();
		expect(await projectShellObservations(store, path, now)).toMatchObject({
			ingestOk: true,
			rejectedRows: 1,
		});
		expect(
			store.getReleaseReadinessEvidence(sha, "2026-09-11T00:00:00.000Z", now)
				.events[0]?.sourceCommit,
		).toBeNull();
		claims.exec("DROP TABLE alert_version_observations");
		expect(await projectShellObservations(store, path, now)).toMatchObject({
			claimsDbOk: false,
		});
	} finally {
		claims.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([501, 5001])(
	"seeks across bounded pages for %i same-second rows and replays idempotently",
	async (count) => {
		const root = mkdtempSync(join(tmpdir(), "readiness-claims-"));
		const path = join(root, "claims.db");
		const claims = new Database(path);
		const store = await StateStore.create(":memory:");
		try {
			claims.exec(`CREATE TABLE alert_version_observations (
			event_id TEXT, source_commit_key TEXT, occurrence INTEGER,
			severity TEXT, project_name TEXT, kind TEXT, base_version TEXT, observed_at INTEGER)`);
			const insert = claims.prepare(
				"INSERT INTO alert_version_observations VALUES (?, ?, ?, 'severe', 'flywheel', 'deploy_failed', '1.56.0', ?)",
			);
			claims.transaction(() => {
				for (let i = 1; i <= count; i++)
					insert.run("same-event", sha, i, Date.parse(now) / 1000);
			})();
			expect(await projectShellObservations(store, path, now)).toEqual({
				claimsDbOk: true,
				ingestOk: true,
				rejectedRows: 0,
				backlogAgeS: 0,
			});
			expect(store.getReleaseSignalCursor()?.occurrence).toBe(
				Math.min(count, 5000),
			);
			expect(
				store.getReleaseReadinessEvidence(sha, now, now).events,
			).toHaveLength(Math.min(count, 5000));
			await projectShellObservations(store, path, now);
			expect(
				store.getReleaseReadinessEvidence(sha, now, now).events,
			).toHaveLength(count);
		} finally {
			claims.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([false, true])(
	"projects late lower-sorting observations after reopening (legacy cursor=%s)",
	async (legacy) => {
		const root = mkdtempSync(join(tmpdir(), "readiness-late-"));
		const path = join(root, "claims.db");
		const claims = new Database(path);
		let store = await StateStore.create(join(root, "state.db"));
		try {
			claims.exec(`CREATE TABLE alert_version_observations (
   event_id TEXT, source_commit_key TEXT, occurrence INTEGER,
   severity TEXT, project_name TEXT, kind TEXT, base_version TEXT, observed_at INTEGER,
   PRIMARY KEY(event_id, source_commit_key, occurrence))`);
			const insert = claims.prepare(
				"INSERT INTO alert_version_observations VALUES (?, ?, 1, 'severe', 'flywheel', 'deploy_failed', '1.56.0', ?)",
			);
			insert.run("z-first", sha, Date.parse(now) / 1000);
			await projectShellObservations(store, path, now);
			store.close();
			if (legacy) {
				const db = new Database(join(root, "state.db"));
				db.exec(
					"ALTER TABLE release_signal_cursor DROP COLUMN last_source_rowid",
				);
				db.close();
			}
			claims.exec("VACUUM");
			store = await StateStore.create(join(root, "state.db"));
			expect(store.getReleaseSignalCursor()?.sourceRowid).toBe(
				legacy ? null : 1,
			);
			insert.run("a-later", sha, Date.parse(now) / 1000);
			insert.run(
				"earlier-observed-delayed-commit",
				sha,
				Date.parse(now) / 1000 - 60,
			);
			await projectShellObservations(store, path, now);
			await projectShellObservations(store, path, now);
			expect(
				store
					.getReleaseReadinessEvidence(sha, "2020-01-01T00:00:00.000Z", now)
					.events.map((e) => e.eventId)
					.sort(),
			).toEqual(["a-later", "earlier-observed-delayed-commit", "z-first"]);
		} finally {
			claims.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([false, true])(
	"ingests a Lead shell preflight gap with state root exported=%s",
	async (exportRoot) => {
		const root = mkdtempSync(join(tmpdir(), "readiness-shell-rider-"));
		const store = await StateStore.create(":memory:");
		try {
			const stateRoot = join(root, ".flywheel");
			mkdirSync(join(root, "doc"));
			writeFileSync(join(root, "doc", "VERSION"), "1.56.0");
			writeFileSync(join(root, "deployed-sha"), sha);
			const shell = spawnSync(
				"/bin/bash",
				[
					fileURLToPath(
						new URL("../../../../../scripts/lead-alert.sh", import.meta.url),
					),
					"--lead",
					"missing",
					"--project",
					"flywheel",
					"--kind",
					"deploy_failed",
					"--severity",
					"severe",
					"--title",
					"test",
					"--body",
					"test",
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: root,
						FLYWHEEL_REPO: root,
						FLYWHEEL_DEPLOYED_SHA_FILE: join(root, "deployed-sha"),
						FLYWHEEL_PROJECTS_FILE: join(root, "missing.json"),
						...(exportRoot ? { FLYWHEEL_STATE_DIR: stateRoot } : {}),
					},
					encoding: "utf8",
				},
			);
			expect(shell.status).not.toBe(0);
			const rider = new ReleaseReadinessRider(store, {
				outboxRoot: join(stateRoot, "state", "release-readiness"),
				claimsPath: join(root, "missing.db"),
				deployedShaPath: join(root, "deployed-sha"),
				subject: { sourceCommit: sha, baseVersion: "1.56.0" },
				notifier: {
					peekCaptureFailures: () => 0,
					ackCaptureFailures: () => {},
				},
				sourceHealth: () => ({
					w1Freshness: "fresh",
					alertDeliveryEnabled: true,
				}),
			});
			await rider.tick(new Date().toISOString());
			const evidence = store.getReleaseReadinessEvidence(
				sha,
				"2020-01-01T00:00:00.000Z",
				"2100-01-01T00:00:00.000Z",
			);
			expect(evidence.gaps).toHaveLength(1);
			expect(evidence.gaps[0]).toMatchObject({
				sourceCommit: sha,
				reason: "shell_preflight",
			});
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
