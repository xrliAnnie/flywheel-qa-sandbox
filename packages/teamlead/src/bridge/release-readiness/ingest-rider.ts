import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { LeadAlertNotifier } from "../../LeadAlertNotifier.js";
import type { ReactionFetcher } from "../../lead-backends/codex/gateway/founder-confirmation.js";
import type { StateStore } from "../../StateStore.js";
import { sqliteRunWithStdin } from "../lead-alert-helpers.js";
import {
	READINESS_WINDOW_MS,
	type ReleasePublication,
	type ReleaseSignalEvent,
} from "./evaluate.js";
import { scanReadinessOutbox } from "./service.js";
import {
	parseReadinessSubject,
	type ReadinessSubject,
	readLocalDeployedSha,
} from "./subject.js";

export class ReleaseReadinessRider {
	private running = false;
	constructor(
		private readonly store: StateStore,
		private readonly options: {
			outboxRoot: string;
			claimsPath: string;
			deployedShaPath: string;
			subject: ReadinessSubject | null;
			notifier: Pick<
				LeadAlertNotifier,
				"peekCaptureFailures" | "ackCaptureFailures"
			>;
			sourceHealth: () => {
				w1Freshness: string;
				alertDeliveryEnabled: boolean;
			};
			founder?: {
				userId: () => string | undefined;
				fetchReactions: ReactionFetcher;
			};
		},
	) {}

	async tick(now = new Date().toISOString()) {
		if (this.running) return;
		this.running = true;
		try {
			await this.run(now);
		} finally {
			this.running = false;
		}
	}

	private async run(now: string) {
		const { outboxRoot, notifier } = this.options;
		let gapsDirOk = true;
		let ingestOk = true;
		try {
			for (const dir of ["gaps", "publications"])
				mkdirSync(join(outboxRoot, dir), { recursive: true });
			const probe = join(outboxRoot, "gaps", `.probe-${randomUUID()}`);
			writeFileSync(probe, "", { flag: "wx" });
			unlinkSync(probe);
		} catch {
			gapsDirOk = false;
		}
		const scan = scanReadinessOutbox(outboxRoot);
		if (scan.counts.readErrors.length) ingestOk = false;
		try {
			const sha = readLocalDeployedSha(this.options.deployedShaPath);
			if (sha)
				for (const anchor of this.store.listDeploymentEpisodesForSha(sha))
					this.store.upsertReleaseDeploymentAnchor(anchor, now);
		} catch {
			ingestOk = false;
		}
		const projection = await projectShellObservations(
			this.store,
			this.options.claimsPath,
			now,
		);
		for (const entry of scan.gaps) {
			try {
				const { eventIdHint, ...gap } = entry.value;
				this.store.insertReleaseSignalGap({
					...gap,
					eventId: eventIdHint,
					gapId: `rg-${createHash("sha256").update(basename(entry.path)).digest("hex")}`,
					ingestedAt: now,
				});
				this.land(entry);
			} catch {
				ingestOk = false;
			}
		}
		for (const entry of scan.publications) {
			try {
				this.store.upsertReleasePublication({
					...entry.value,
					firstScanOkAt: null,
					lastScanOkAt: null,
					lastScanAt: null,
					lastScanError: null,
				});
				this.land(entry);
			} catch {
				ingestOk = false;
			}
		}
		const remaining = scanReadinessOutbox(outboxRoot).counts;
		if (remaining.readErrors.length) ingestOk = false;
		const failures = notifier.peekCaptureFailures();
		this.store.appendReleaseHeartbeat({
			tickAt: now,
			sourceCommit: this.options.subject?.sourceCommit ?? null,
			baseVersion: this.options.subject?.baseVersion ?? null,
			...this.options.sourceHealth(),
			...projection,
			ingestOk: ingestOk && projection.ingestOk,
			gapsDirOk,
			bridgeCaptureFailures: failures,
			outboxPending: remaining.gapsPending + remaining.publicationsPending,
			outboxInvalid: remaining.gapsInvalid + remaining.publicationsInvalid,
		});
		notifier.ackCaptureFailures(failures);
		if (this.options.subject) {
			const from = new Date(
				Date.parse(now) - READINESS_WINDOW_MS,
			).toISOString();
			const publications = this.store.getReleaseReadinessEvidence(
				this.options.subject.sourceCommit,
				from,
				now,
			).publications;
			await scanFounderReactions(
				this.store,
				publications,
				now,
				this.options.founder?.userId(),
				this.options.founder?.fetchReactions,
			);
		}
	}

	private land(entry: { path: string; contents: string }) {
		// A publisher may have finalized the intent while the sqlite projection awaited.
		if (readFileSync(entry.path, "utf8") !== entry.contents) return;
		const landed = join(dirname(entry.path), "landed");
		mkdirSync(landed, { recursive: true });
		renameSync(entry.path, join(landed, basename(entry.path)));
	}
}

export async function scanFounderReactions(
	store: StateStore,
	publications: ReleasePublication[],
	now: string,
	founderId: string | undefined,
	fetchReactions: ReactionFetcher | undefined,
) {
	for (const publication of publications) {
		if (publication.status !== "published" || !publication.messageId) continue;
		try {
			if (!founderId || !fetchReactions)
				throw new Error("founder reaction source unavailable");
			let sentiment: "up" | "down" | null = null;
			for (const emoji of ["👍", "👎"]) {
				let after: string | undefined;
				for (let page = 0; page < 20; page++) {
					const result = await fetchReactions({
						channelId: publication.channelId,
						messageId: publication.messageId,
						emoji,
						after,
					});
					if (result.status !== 200)
						throw new Error(`reaction HTTP ${result.status}`);
					const users = z
						.array(z.object({ id: z.string().min(1) }))
						.max(100)
						.parse(result.body);
					if (users.some((user) => user.id === founderId))
						sentiment = emoji === "👎" ? "down" : "up";
					if (users.length < 100) break;
					if (page === 19) throw new Error("reaction page limit exceeded");
					const next = users[users.length - 1]!.id;
					if (next === after)
						throw new Error("reaction cursor did not advance");
					after = next;
				}
			}
			store.recordReleaseFounderScan(publication.publicationId, {
				at: now,
				ok: true,
				founderUserId: founderId,
				sentiment,
			});
		} catch (error) {
			store.recordReleaseFounderScan(publication.publicationId, {
				at: now,
				ok: false,
				error: String(error),
			});
		}
	}
}

const cursorRow = z.object({
	source_rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	observed_at: z.number().int().nonnegative().max(8_640_000_000_000),
	event_id: z.string(),
	source_commit_key: z.string(),
	occurrence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	severity: z.unknown(),
	project_name: z.unknown(),
	kind: z.unknown(),
	base_version: z.unknown(),
});

export async function projectShellObservations(
	store: StateStore,
	claimsPath: string,
	now: string,
) {
	const health = {
		claimsDbOk: true,
		ingestOk: true,
		rejectedRows: 0,
		backlogAgeS: 0,
	};
	let cursor = store.getReleaseSignalCursor();
	// claims observations are append-only: insertion order includes late timestamps.
	const where = () => `WHERE rowid > ${cursor?.sourceRowid ?? 0}`;
	try {
		for (let page = 0; page < 10; page++) {
			const output = await sqliteRunWithStdin(
				claimsPath,
				`.bail on\n.mode json\nPRAGMA query_only=ON;\nSELECT rowid AS source_rowid, * FROM alert_version_observations ${where()} ORDER BY rowid LIMIT 500;`,
				5000,
			);
			const rows = z.array(cursorRow).parse(JSON.parse(output || "[]"));
			if (!rows.length) break;
			const events: (ReleaseSignalEvent & { ingestedAt: string })[] = [];
			for (const row of rows) {
				if (!row.event_id) {
					health.rejectedRows++;
					continue;
				}
				const identity = parseReadinessSubject(
					row.base_version,
					row.source_commit_key,
				);
				const severity = z
					.enum(["info", "warning", "severe"])
					.safeParse(row.severity);
				const project = z.string().min(1).safeParse(row.project_name);
				const kind = z.string().min(1).safeParse(row.kind);
				const valid = severity.success && project.success && kind.success;
				if (!valid || (!identity && row.source_commit_key !== "null"))
					health.rejectedRows++;
				events.push({
					eventId: row.event_id,
					occurrence: row.occurrence,
					sourceCommit: valid ? (identity?.sourceCommit ?? null) : null,
					baseVersion: valid ? (identity?.baseVersion ?? null) : null,
					severity: severity.success ? severity.data : "severe",
					projectName: project.success ? project.data : "unknown",
					kind: kind.success ? kind.data : "unknown",
					observedAt: new Date(row.observed_at * 1000).toISOString(),
					ingestedAt: now,
				});
			}
			const last = rows[rows.length - 1]!;
			const next = {
				sourceRowid: last.source_rowid,
				observedAtUnix: last.observed_at,
				eventId: last.event_id,
				commitKey: last.source_commit_key,
				occurrence: last.occurrence,
			};
			try {
				store.projectReleaseSignalBatch(events, next, now);
			} catch {
				health.ingestOk = false;
				break;
			}
			cursor = next;
			if (rows.length < 500) break;
		}
		const remaining = await sqliteRunWithStdin(
			claimsPath,
			`.bail on\n.mode json\nPRAGMA query_only=ON;\nSELECT MIN(observed_at) AS oldest FROM alert_version_observations ${where()};`,
			5000,
		);
		const [{ oldest }] = z
			.tuple([z.object({ oldest: z.number().nullable() })])
			.parse(JSON.parse(remaining));
		health.backlogAgeS =
			oldest === null
				? 0
				: Math.max(0, Math.floor(Date.parse(now) / 1000 - oldest));
	} catch {
		health.claimsDbOk = false;
	}
	return health;
}
