import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ReleasePublication } from "../bridge/release-readiness/evaluate.js";
import { evaluateReadiness } from "../bridge/release-readiness/evaluate.js";
import { readReadinessPolicy } from "../bridge/release-readiness/policy.js";
import { StateStore } from "../StateStore.js";

const raw = (store: StateStore) =>
	(store as unknown as { db: { raw: Database.Database } }).db.raw;
const tables = [
	"release_signal_events",
	"release_signal_cursor",
	"release_signal_heartbeat",
	"release_signal_gaps",
	"release_deployment_anchors",
	"release_bug_reports",
	"release_bug_resolution_receipts",
	"release_bug_source_health",
	"release_report_publications",
	"release_founder_verdicts",
	"release_readiness_verdicts",
];

describe("release readiness ledger", () => {
	it("appends distinct same-millisecond verdicts and reads exact-subject history with reasons and policy intact", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const subject = { baseVersion: "1.56.0", sourceCommit: "a".repeat(40) };
			const evaluatedAt = "2026-09-11T00:00:00.000Z";
			const result = evaluateReadiness({
				subject,
				now: evaluatedAt,
				policy: readReadinessPolicy({}),
				localDeployedSha: null,
				anchor: null,
				events: [],
				gaps: [],
				heartbeats: [],
				bugs: [],
				bugSourceHealth: null,
				publications: [],
				founderVerdicts: [],
				outbox: {
					gapsPending: 0,
					gapsInvalid: 0,
					publicationsPending: 0,
					publicationsInvalid: 0,
					oldestPendingAt: null,
					readErrors: [],
				},
			});
			const first = store.appendReleaseReadinessVerdict({
				...result,
				subject,
				evaluatedAt,
			});
			const second = store.appendReleaseReadinessVerdict({
				...result,
				subject,
				evaluatedAt,
			});
			expect(first.verdictId).not.toBe(second.verdictId);
			expect(
				store.getReleaseReadinessVerdicts(subject.sourceCommit, 1),
			).toEqual([second]);
			expect(
				store.getReleaseReadinessVerdicts(subject.sourceCommit, 2),
			).toEqual([second, first]);
			expect(store.getReleaseReadinessVerdicts("b".repeat(40), 2)).toEqual([]);
			expect(() =>
				store.getReleaseReadinessVerdicts(subject.sourceCommit, 0),
			).toThrow("invalid history limit");
		} finally {
			store.close();
		}
	});
	it("requires a reason for abandonment and prevents receipt rewrites", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const at = "2026-09-11T00:00:00.000Z";
			store.insertReleaseBugIntent({
				intentId: "bi",
				sourceCommit: null,
				baseVersion: null,
				reporter: null,
				createdAt: at,
			});
			expect(() =>
				store.resolveReleaseBugIntent({
					intentId: "bi",
					abandon: true,
					reason: " ",
					resolvedBy: "master-api-token",
					resolvedAt: at,
				}),
			).toThrow("abandon reason required");
			store.resolveReleaseBugIntent({
				intentId: "bi",
				abandon: true,
				reason: "request never sent",
				resolvedBy: "master-api-token",
				resolvedAt: at,
			});
			expect(() =>
				raw(store).exec(
					"UPDATE release_bug_resolution_receipts SET resolved_by='forged'",
				),
			).toThrow("immutable");
			expect(() =>
				raw(store).exec("DELETE FROM release_bug_resolution_receipts"),
			).toThrow("immutable");
		} finally {
			store.close();
		}
	});
	it("persists successful scans atomically with sticky down verdicts and records later scan failure", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const sha = "a".repeat(40),
				at = "2026-09-11T00:00:00.000Z",
				later = "2026-09-11T00:01:00.000Z";
			const publication: ReleasePublication = {
				publicationId: "rp",
				day: "2026-09-11",
				subjectCommit: sha,
				baseVersion: "1.56.0",
				status: "published",
				channelId: "c",
				messageId: "m",
				intentAt: at,
				publishedAt: at,
				firstScanOkAt: null,
				lastScanOkAt: null,
				lastScanAt: null,
				lastScanError: null,
			};
			store.upsertReleasePublication(publication);
			store.recordReleaseFounderScan("rp", {
				ok: true,
				at,
				founderUserId: "annie",
				sentiment: "down",
			});
			store.recordReleaseFounderScan("rp", {
				ok: true,
				at: later,
				founderUserId: "annie",
				sentiment: "up",
			});
			store.recordReleaseFounderScan("rp", {
				ok: false,
				at: later,
				error: "403",
			});
			let evidence = store.getReleaseReadinessEvidence(sha, at, later);
			expect(evidence.founderVerdicts).toHaveLength(1);
			expect(evidence.founderVerdicts[0]).toMatchObject({
				sentiment: "down",
				observedAt: at,
			});
			expect(evidence.publications[0]).toMatchObject({
				firstScanOkAt: at,
				lastScanOkAt: later,
				lastScanError: "403",
			});
			store.recordReleaseFounderScan("rp", {
				ok: true,
				at: later,
				founderUserId: "annie",
				sentiment: null,
			});
			evidence = store.getReleaseReadinessEvidence(sha, at, later);
			expect(evidence.founderVerdicts[0]?.sentiment).toBe("down");
			expect(evidence.publications[0]?.lastScanError).toBeNull();
			store.upsertReleasePublication({
				...publication,
				publicationId: "rp2",
				day: "2026-09-12",
				messageId: "m2",
			});
			raw(store).exec(
				"CREATE TRIGGER fail_founder BEFORE INSERT ON release_founder_verdicts BEGIN SELECT RAISE(ABORT, 'founder failure'); END",
			);
			expect(() =>
				store.recordReleaseFounderScan("rp2", {
					ok: true,
					at,
					founderUserId: "annie",
					sentiment: "down",
				}),
			).toThrow("founder failure");
			expect(
				raw(store)
					.prepare(
						"SELECT first_scan_ok_at FROM release_report_publications WHERE publication_id='rp2'",
					)
					.get(),
			).toEqual({ first_scan_ok_at: null });
		} finally {
			store.close();
		}
	});
	it("reads exact-subject and unattributed evidence in the requested window without losing unhealthy history", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const sha = "a".repeat(40),
				at = "2026-09-11T00:00:00.000Z",
				end = "2026-09-11T01:00:00.000Z";
			const event = {
				eventId: "e",
				sourceCommit: sha,
				baseVersion: "1.56.0",
				kind: "deploy_failed",
				severity: "severe" as const,
				projectName: "flywheel",
				observedAt: at,
				ingestedAt: at,
				origin: "bridge" as const,
			};
			store.insertReleaseSignalObservation(event);
			store.insertReleaseSignalObservation({ ...event, sourceCommit: null });
			store.insertReleaseSignalObservation({
				...event,
				sourceCommit: "b".repeat(40),
			});
			const gap = {
				gapId: "g",
				eventId: null,
				sourceCommit: null,
				baseVersion: null,
				projectName: "machine",
				kind: "deploy_failed",
				severity: "severe" as const,
				reason: "shell_preflight" as const,
				observedAt: at,
				ingestedAt: at,
			};
			store.insertReleaseSignalGap(gap);
			store.insertReleaseSignalGap(gap);
			const heartbeat = {
				tickAt: at,
				sourceCommit: sha,
				baseVersion: "1.56.0",
				w1Freshness: "fresh",
				alertDeliveryEnabled: false,
				claimsDbOk: true,
				ingestOk: false,
				gapsDirOk: true,
				bridgeCaptureFailures: 2,
				rejectedRows: 1,
				backlogAgeS: 0,
				outboxPending: 0,
				outboxInvalid: 0,
			};
			store.appendReleaseHeartbeat(heartbeat);
			store.appendReleaseHeartbeat({
				...heartbeat,
				tickAt: end,
				alertDeliveryEnabled: true,
				ingestOk: true,
			});
			store.recordReleaseBugSourceHealth({
				label: "Bug",
				ok: false,
				error: "lookup failed",
				at,
			});
			store.recordReleaseBugSourceHealth({ label: "Bug", ok: true, at: end });
			const result = store.getReleaseReadinessEvidence(sha, at, end);
			expect(result.events.map((e) => e.sourceCommit)).toEqual([sha, null]);
			expect(result.gaps).toHaveLength(1);
			expect(result.heartbeats).toHaveLength(2);
			expect(result.heartbeats[0]).toEqual(heartbeat);
			expect(result.bugSourceHealth).toMatchObject({
				lastFailureAt: at,
				lastSuccessAt: end,
			});
			expect(
				store.getReleaseReadinessEvidence(sha, end, end).events,
			).toHaveLength(0);
		} finally {
			store.close();
		}
	});
	it("does not move episode start forward when retention removes the oldest deployment row", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const sha = "a".repeat(40);
			const insert = raw(store).prepare(
				"INSERT INTO deployment_events(project_name, deployed_sha, source, deployed_at, dedup_key) VALUES('flywheel', ?, 'test', ?, ?)",
			);
			insert.run(sha, "2026-08-01T00:00:00.000Z", "old");
			insert.run(sha, "2026-08-15T00:00:00.000Z", "retained");
			const episode = store.listDeploymentEpisodesForSha(sha)[0]!;
			store.upsertReleaseDeploymentAnchor(episode, "2026-08-15T01:00:00.000Z");
			raw(store).exec("DELETE FROM deployment_events WHERE dedup_key='old'");
			for (const candidate of store.listDeploymentEpisodesForSha(sha))
				store.upsertReleaseDeploymentAnchor(
					candidate,
					"2026-08-16T00:00:00.000Z",
				);
			expect(store.getReleaseDeploymentAnchor(sha)).toEqual(episode);
		} finally {
			store.close();
		}
	});
	it("separates rollback episodes and preserves deployment anchors after source retention", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const a = "a".repeat(40),
				b = "b".repeat(40);
			const t = (hour: number) => `2026-09-11T0${hour}:00:00.000Z`;
			const insert = raw(store).prepare(
				"INSERT INTO deployment_events(project_name, deployed_sha, environment, source, deployed_at, dedup_key) VALUES(?, ?, ?, 'test', ?, ?)",
			);
			insert.run("flywheel", a, "production", t(0), "1");
			insert.run("flywheel", a, "production", t(1), "2");
			insert.run("flywheel", b, "staging", t(1), "3");
			insert.run("other", b, "production", t(1), "4");
			insert.run("flywheel", b, "production", t(2), "5");
			insert.run("flywheel", a, "production", t(3), "6");
			const episodes = store.listDeploymentEpisodesForSha(a);
			expect(episodes).toEqual([
				{ sourceCommit: a, episodeFrom: t(0), episodeTo: t(2) },
				{ sourceCommit: a, episodeFrom: t(3), episodeTo: null },
			]);
			for (const episode of episodes)
				store.upsertReleaseDeploymentAnchor(episode, t(4));
			expect(store.getReleaseDeploymentAnchor(a)).toEqual(episodes[1]);
			raw(store).exec("DELETE FROM deployment_events");
			expect(store.getReleaseDeploymentAnchor(a)).toEqual(episodes[1]);
			store.upsertReleaseDeploymentAnchor(
				{ ...episodes[1]!, episodeTo: t(5) },
				t(6),
			);
			store.upsertReleaseDeploymentAnchor(episodes[1]!, t(7));
			expect(store.getReleaseDeploymentAnchor(a)?.episodeTo).toBe(t(5));
		} finally {
			store.close();
		}
	});
	it("accepts finalized publications before the first tick but forbids regression and identity replacement", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const publication: ReleasePublication = {
				publicationId: "rp-1",
				day: "2026-09-11",
				subjectCommit: "a".repeat(40),
				baseVersion: "1.56.0",
				status: "published",
				channelId: "c",
				messageId: "m",
				intentAt: "2026-09-11T00:00:00.000Z",
				publishedAt: "2026-09-11T00:01:00.000Z",
				firstScanOkAt: null,
				lastScanOkAt: null,
				lastScanAt: null,
				lastScanError: null,
			};
			store.upsertReleasePublication(publication);
			store.upsertReleasePublication(publication);
			expect(() =>
				store.upsertReleasePublication({
					...publication,
					status: "intent",
					messageId: null,
				}),
			).toThrow("publication regression");
			expect(() =>
				store.upsertReleasePublication({
					...publication,
					subjectCommit: "b".repeat(40),
				}),
			).toThrow("publication identity conflict");
			const next = {
				...publication,
				publicationId: "rp-2",
				day: "2026-09-12",
				messageId: null,
				status: "intent" as const,
				publishedAt: null,
			};
			store.upsertReleasePublication(next);
			store.upsertReleasePublication({
				...next,
				status: "published",
				messageId: "m2",
				publishedAt: publication.publishedAt,
			});
			store.upsertReleasePublication({
				...next,
				publicationId: "rp-3",
				day: "2026-09-13",
				status: "failed",
			});
			expect(
				raw(store)
					.prepare(
						"SELECT day, status FROM release_report_publications ORDER BY day",
					)
					.all(),
			).toEqual([
				{ day: "2026-09-11", status: "published" },
				{ day: "2026-09-12", status: "published" },
				{ day: "2026-09-13", status: "failed" },
			]);
		} finally {
			store.close();
		}
	});
	it("retains shell and Bridge occurrence 1 independently and rolls back projection with its cursor", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const event = {
				eventId: "same-event",
				sourceCommit: "a".repeat(40),
				baseVersion: "1.56.0",
				kind: "deploy_failed",
				severity: "warning" as const,
				projectName: "flywheel",
				observedAt: "2026-09-11T00:00:00.000Z",
				ingestedAt: "2026-09-11T00:01:00.000Z",
			};
			expect(
				store.insertReleaseSignalObservation({ ...event, origin: "bridge" }),
			).toBe(1);
			expect(
				store.insertReleaseSignalObservation({
					...event,
					origin: "bridge",
					severity: "severe",
				}),
			).toBe(2);
			const cursor = {
				sourceRowid: 1,
				observedAtUnix: 1789084800,
				eventId: event.eventId,
				commitKey: event.sourceCommit,
				occurrence: 1,
			};
			store.projectReleaseSignalBatch(
				[{ ...event, occurrence: 1 }],
				cursor,
				event.ingestedAt,
			);
			store.projectReleaseSignalBatch(
				[{ ...event, occurrence: 1 }],
				cursor,
				event.ingestedAt,
			);
			expect(
				raw(store)
					.prepare(
						"SELECT origin, occurrence FROM release_signal_events ORDER BY origin, occurrence",
					)
					.all(),
			).toEqual([
				{ origin: "bridge", occurrence: 1 },
				{ origin: "bridge", occurrence: 2 },
				{ origin: "shell", occurrence: 1 },
			]);
			expect(store.getReleaseSignalCursor()).toEqual({
				...cursor,
				sourceRowid: 1,
			});
			raw(store).exec(
				"CREATE TRIGGER fail_projection BEFORE INSERT ON release_signal_events WHEN NEW.event_id='bad' BEGIN SELECT RAISE(ABORT, 'projection failure'); END",
			);
			expect(() =>
				store.projectReleaseSignalBatch(
					[
						{ ...event, eventId: "good", occurrence: 1 },
						{ ...event, eventId: "bad", occurrence: 1 },
					],
					{
						...cursor,
						sourceRowid: 2,
						observedAtUnix: cursor.observedAtUnix + 1,
					},
					event.ingestedAt,
				),
			).toThrow("projection failure");
			expect(store.getReleaseSignalCursor()).toEqual({
				...cursor,
				sourceRowid: 1,
			});
			expect(
				raw(store)
					.prepare(
						"SELECT count(*) n FROM release_signal_events WHERE event_id='good'",
					)
					.get(),
			).toEqual({ n: 0 });
			expect(
				store.insertReleaseSignalObservation({
					...event,
					sourceCommit: null,
					origin: "bridge",
				}),
			).toBe(1);
			expect(
				store.insertReleaseSignalObservation({
					...event,
					sourceCommit: null,
					origin: "bridge",
				}),
			).toBe(2);
		} finally {
			store.close();
		}
	});
	it("resolves a bug intent and appends its receipt atomically, preserving the winner on retry", async () => {
		const store = await StateStore.create(":memory:");
		try {
			store.insertReleaseBugIntent({
				intentId: "bi-1",
				sourceCommit: "a".repeat(40),
				baseVersion: "1.56.0",
				reporter: "annie",
				createdAt: "2026-09-11T00:00:00.000Z",
			});
			const result = store.resolveReleaseBugIntent({
				intentId: "bi-1",
				issueIdentifier: "FLY-123",
				resolvedBy: "master-api-token",
				resolvedAt: "2026-09-11T00:01:00.000Z",
			});
			expect(result).toMatchObject({
				status: "finalized",
				issueIdentifier: "FLY-123",
				resolvedBy: "master-api-token",
			});
			expect(
				store.resolveReleaseBugIntent({
					intentId: "bi-1",
					abandon: true,
					reason: "retry",
					resolvedBy: "master-api-token",
					resolvedAt: "2026-09-11T00:02:00.000Z",
				}),
			).toEqual(result);
			expect(
				raw(store)
					.prepare("SELECT count(*) n FROM release_bug_resolution_receipts")
					.get(),
			).toEqual({ n: 1 });
			store.insertReleaseBugIntent({
				intentId: "bi-2",
				sourceCommit: null,
				baseVersion: null,
				reporter: null,
				createdAt: "2026-09-11T00:00:00.000Z",
			});
			raw(store).exec(
				"CREATE TRIGGER fail_receipt BEFORE INSERT ON release_bug_resolution_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
			);
			expect(() =>
				store.resolveReleaseBugIntent({
					intentId: "bi-2",
					abandon: true,
					reason: "not created",
					resolvedBy: "master-api-token",
					resolvedAt: "2026-09-11T00:03:00.000Z",
				}),
			).toThrow("injected receipt failure");
			expect(
				raw(store)
					.prepare(
						"SELECT status FROM release_bug_reports WHERE intent_id='bi-2'",
					)
					.get(),
			).toEqual({ status: "pending" });
		} finally {
			store.close();
		}
	});
	it("installs eleven additive tables once and preserves existing data across reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "release-readiness-store-"));
		let store: StateStore | undefined;
		try {
			store = await StateStore.create(join(dir, "test.db"));
			const names = raw(store)
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((r) => (r as { name: string }).name);
			for (const table of tables) expect(names).toContain(table);
			expect(
				raw(store)
					.prepare(
						"SELECT count(*) n FROM state_store_migration WHERE migration_id='fly-2390-release-readiness-v1'",
					)
					.get(),
			).toEqual({ n: 1 });
			raw(store)
				.prepare(
					"INSERT INTO release_deployment_anchors VALUES(?, ?, ?, NULL, ?)",
				)
				.run(
					"anchor",
					"a".repeat(40),
					"2026-09-11T00:00:00.000Z",
					"2026-09-11T00:00:00.000Z",
				);
			store.close();
			store = await StateStore.create(join(dir, "test.db"));
			expect(
				raw(store)
					.prepare("SELECT count(*) n FROM release_deployment_anchors")
					.get(),
			).toEqual({ n: 1 });
			expect(
				raw(store)
					.prepare(
						"SELECT count(*) n FROM state_store_migration WHERE migration_id='fly-2390-release-readiness-v1'",
					)
					.get(),
			).toEqual({ n: 1 });
		} finally {
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
