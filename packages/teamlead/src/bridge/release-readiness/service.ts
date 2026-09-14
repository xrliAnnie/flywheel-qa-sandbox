import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_RE } from "flywheel-release-contract";
import { z } from "zod";
import type { StateStore } from "../../StateStore.js";
import {
	evaluateReadiness,
	READINESS_WINDOW_MS,
	type ReadinessInput,
} from "./evaluate.js";
import type { ReadinessPolicy } from "./policy.js";
import { type ReadinessSubject, readLocalDeployedSha } from "./subject.js";

export class ReleaseReadinessService {
	constructor(
		private readonly store: StateStore,
		private readonly options: {
			outboxRoot: string;
			deployedShaPath: string;
			policy: ReadinessPolicy;
		},
	) {}

	collect(
		subject: ReadinessSubject,
		now = new Date().toISOString(),
	): ReadinessInput {
		const anchor = this.store.getReleaseDeploymentAnchor(subject.sourceCommit);
		const nowMs = Date.parse(now);
		const from = new Date(
			Math.max(
				anchor ? Date.parse(anchor.episodeFrom) : nowMs,
				nowMs - READINESS_WINDOW_MS,
			),
		).toISOString();
		const to = new Date(
			Math.min(anchor?.episodeTo ? Date.parse(anchor.episodeTo) : nowMs, nowMs),
		).toISOString();
		return {
			subject,
			now,
			anchor,
			policy: this.options.policy,
			localDeployedSha: readLocalDeployedSha(this.options.deployedShaPath),
			...this.store.getReleaseReadinessEvidence(subject.sourceCommit, from, to),
			outbox: scanReadinessOutbox(this.options.outboxRoot).counts,
		};
	}

	evaluate(subject: ReadinessSubject, now = new Date().toISOString()) {
		return this.store.appendReleaseReadinessVerdict({
			...evaluateReadiness(this.collect(subject, now)),
			subject,
			evaluatedAt: now,
		});
	}
}

const timestamp = z.string().datetime({ precision: 3 });
const commit = z
	.string()
	.length(40)
	.regex(/^[0-9a-f]{40}$/);
const base = z.string().regex(BASE_RE);
const gapSchema = z.object({
	eventIdHint: z.string().min(1).nullable(),
	kind: z.string().min(1),
	severity: z.enum(["info", "warning", "severe"]),
	projectName: z.string().min(1),
	leadId: z.string().min(1),
	sourceCommit: commit.nullable(),
	baseVersion: base.nullable(),
	observedAt: timestamp,
	reason: z.enum(["shell_preflight", "shell_claim_db"]),
});
const publicationSchema = z
	.object({
		publicationId: z.string().min(1),
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		subjectCommit: commit,
		baseVersion: base,
		status: z.enum(["intent", "published", "failed"]),
		channelId: z.string().min(1),
		messageId: z.string().min(1).nullable(),
		intentAt: timestamp,
		publishedAt: timestamp.nullable(),
	})
	.refine(
		(value) =>
			value.status !== "published" ||
			(value.messageId !== null && value.publishedAt !== null),
	);

export function scanReadinessOutbox(root: string) {
	const counts: ReadinessInput["outbox"] = {
		gapsPending: 0,
		gapsInvalid: 0,
		publicationsPending: 0,
		publicationsInvalid: 0,
		oldestPendingAt: null,
		readErrors: [],
	};
	function scan<T>(directory: "gaps" | "publications", schema: z.ZodType<T>) {
		const entries: { path: string; contents: string; value: T }[] = [];
		try {
			for (const name of readdirSync(join(root, directory))) {
				const path = join(root, directory, name);
				if (name === "landed" && lstatSync(path).isDirectory()) continue;
				counts[`${directory}Pending`]++;
				try {
					const stat = lstatSync(path);
					const modifiedAt = stat.mtime.toISOString();
					if (!counts.oldestPendingAt || modifiedAt < counts.oldestPendingAt)
						counts.oldestPendingAt = modifiedAt;
					if (!stat.isFile()) throw new Error("not a regular file");
					const contents = readFileSync(path, "utf8");
					entries.push({
						path,
						contents,
						value: schema.parse(JSON.parse(contents)),
					});
				} catch {
					counts[`${directory}Invalid`]++;
				}
			}
		} catch (error) {
			counts.readErrors.push(`${directory}: ${String(error)}`);
		}
		return entries;
	}
	return {
		gaps: scan("gaps", gapSchema),
		publications: scan("publications", publicationSchema),
		counts,
	};
}
