import express from "express";
import type { MemoryService } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	findProjectForLead,
	generateBootstrap,
	getBootstrapQuestionPage,
} from "./bootstrap-generator.js";
import { masterOnlyAuthMiddleware } from "./dependency-route.js";

/** Read-only recovery pages. Authority comes solely from the configured master token. */
export function createBootstrapReadRouter(deps: {
	store: StateStore;
	projects: ProjectEntry[];
	apiToken?: string;
	geminiAgentToken?: string;
	memoryService?: MemoryService;
	chatThreadsEnabled?: boolean;
}): express.Router {
	const router = express.Router();
	router.get(
		"/:leadId/:section",
		masterOnlyAuthMiddleware(deps.apiToken, deps.geminiAgentToken),
		async (req, res) => {
			const { leadId, section } = req.params;
			if (typeof leadId !== "string") {
				res.status(400).json({ error: "invalid_lead" });
				return;
			}
			const project = findProjectForLead(leadId, deps.projects);
			if (!project) {
				res.status(404).json({ error: "unknown_lead" });
				return;
			}
			const { kind, cursor } = req.query;
			const limit =
				req.query.limit === undefined
					? 50
					: typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit)
						? Number(req.query.limit)
						: NaN;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
				res.status(400).json({ error: "invalid_limit" });
				return;
			}
			const snapshotAt = new Date().toISOString();
			if (section === "audit-events") {
				const beforeSeq =
					cursor === undefined
						? Number.MAX_SAFE_INTEGER
						: typeof cursor === "string" && /^\d+$/.test(cursor)
							? Number(cursor)
							: NaN;
				if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) {
					res.status(400).json({ error: "invalid_cursor" });
					return;
				}
				const range: {
					afterSeq?: number;
					throughSeq?: number;
					storeEpoch?: string;
				} = {};
				if (
					Object.keys(req.query).some((key) =>
						/^(afterSeq|throughSeq|storeEpoch)\[/.test(key),
					)
				) {
					res.status(400).json({ error: "invalid_audit_range" });
					return;
				}
				for (const field of ["afterSeq", "throughSeq"] as const) {
					const value = req.query[field];
					if (value === undefined) continue;
					if (
						typeof value !== "string" ||
						!/^\d+$/.test(value) ||
						!Number.isSafeInteger(Number(value))
					) {
						res.status(400).json({ error: "invalid_audit_range" });
						return;
					}
					range[field] = Number(value);
				}
				if (
					range.afterSeq !== undefined &&
					range.throughSeq !== undefined &&
					range.afterSeq > range.throughSeq
				) {
					res.status(400).json({ error: "invalid_audit_range" });
					return;
				}
				if (req.query.storeEpoch !== undefined) {
					if (
						typeof req.query.storeEpoch !== "string" ||
						!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
							req.query.storeEpoch,
						)
					) {
						res.status(400).json({ error: "invalid_store_epoch" });
						return;
					}
					range.storeEpoch = req.query.storeEpoch;
				}
				try {
					res.json({
						snapshotAt,
						...deps.store.getLeadAuditEventPage(leadId, limit, beforeSeq, {
							projectName: project.projectName,
							...range,
						}),
					});
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "audit_store_epoch_mismatch"
					) {
						res.status(409).json({ error: "audit_store_epoch_mismatch" });
						return;
					}
					res.status(500).json({ error: "bootstrap_read_failed" });
				}
				return;
			}
			if (section === "questions") {
				if (kind !== "gate" && kind !== "ask" && kind !== "report") {
					res.status(400).json({ error: "invalid_kind" });
					return;
				}
				let parsed: { created_at: string; id: string } | undefined;
				if (cursor !== undefined) {
					try {
						if (typeof cursor !== "string" || cursor.length > 4096)
							throw new Error("invalid_cursor");
						const value = JSON.parse(cursor);
						if (
							!value ||
							typeof value.created_at !== "string" ||
							!value.created_at.trim() ||
							typeof value.id !== "string" ||
							!value.id.trim() ||
							Object.keys(value).some((k) => k !== "created_at" && k !== "id")
						)
							throw new Error("invalid_cursor");
						parsed = { created_at: value.created_at, id: value.id };
					} catch {
						res.status(400).json({ error: "invalid_cursor" });
						return;
					}
				}
				try {
					res.json({
						snapshotAt,
						...getBootstrapQuestionPage(
							leadId,
							deps.store,
							deps.projects,
							{ kind, limit, cursor: parsed },
							deps,
						),
					});
				} catch {
					res.status(500).json({ error: "bootstrap_read_failed" });
				}
				return;
			}
			if (section !== "sections") {
				res.sendStatus(404);
				return;
			}
			if (
				kind !== "activeSessions" &&
				kind !== "pendingDecisions" &&
				kind !== "recentFailures" &&
				kind !== "recentEvents" &&
				kind !== "memoryRecall"
			) {
				res.status(400).json({ error: "invalid_kind" });
				return;
			}
			const offset =
				cursor === undefined
					? 0
					: typeof cursor === "string" && /^\d+$/.test(cursor)
						? Number(cursor)
						: NaN;
			if (!Number.isSafeInteger(offset) || offset < 0) {
				res.status(400).json({ error: "invalid_cursor" });
				return;
			}
			try {
				const snapshot = await generateBootstrap(
					leadId,
					deps.store,
					deps.projects,
					kind === "memoryRecall" ? deps.memoryService : undefined,
					deps,
				);
				const rows =
					kind === "memoryRecall"
						? snapshot.memoryRecall
							? [snapshot.memoryRecall]
							: []
						: snapshot[kind];
				res.json({
					snapshotAt,
					count: rows.length,
					items: rows.slice(offset, offset + limit),
					nextCursor:
						offset + limit < rows.length ? String(offset + limit) : null,
				});
			} catch {
				res.status(500).json({ error: "bootstrap_read_failed" });
			}
		},
	);
	return router;
}
