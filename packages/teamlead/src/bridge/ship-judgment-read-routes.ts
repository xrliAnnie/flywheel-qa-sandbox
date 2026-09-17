import { Router } from "express";
import { z } from "zod";
import type { StateStore } from "../StateStore.js";
import { JUDGMENT_PROJECT, POLICY_VERSION } from "../ship-judgment/contract.js";
import { renderHistoryDocument } from "../ship-judgment/history-pages.js";
import { showQuerySchema } from "../ship-judgment/show.js";
import { statisticsRangeSchema } from "../ship-judgment/statistics.js";

const reportQuery = z
	.object({
		project: z.literal(JUDGMENT_PROJECT),
		from: z.string(),
		to: z.string(),
		asOf: z.string().optional(),
		policyVersion: z.string().optional(),
		modelSnapshotDigest: z.string().optional(),
	})
	.strict();
const historyQuery = z
	.object({ project: z.literal(JUDGMENT_PROJECT) })
	.strict();

/** Mounted only behind the existing Bridge API-token middleware. No write path. */
export function createShipJudgmentReadRouter(
	store: Pick<
		StateStore,
		| "getShipJudgmentStatistics"
		| "getShipJudgmentReader"
		| "getShipJudgmentHistory"
	>,
	now: () => Date = () => new Date(),
): Router {
	const router = Router();
	router.get("/history/render", (req, res) => {
		const query = historyQuery.safeParse(req.query);
		if (!query.success) {
			res.status(400).json({ error: "invalid_history_query" });
			return;
		}
		try {
			const snapshot = store.getShipJudgmentHistory().read(now().toISOString());
			const html = renderHistoryDocument(snapshot.rows, {
				asOf: snapshot.asOf,
				total: snapshot.rows.length,
			});
			res.set("Cache-Control", "no-store").type("html").send(html);
		} catch {
			res.status(503).json({ error: "history_render_failed" });
		}
	});
	router.get("/report", (req, res) => {
		const query = reportQuery.safeParse(req.query);
		if (!query.success) {
			res.status(400).json({ error: "invalid_statistics_query" });
			return;
		}
		const { project: _project, ...values } = query.data;
		const range = statisticsRangeSchema.safeParse({
			...values,
			asOf: values.asOf ?? now().toISOString(),
		});
		if (!range.success) {
			res.status(400).json({ error: "invalid_statistics_range" });
			return;
		}
		try {
			const report = store.getShipJudgmentStatistics().read(range.data);
			res.json({
				schema_version: 1,
				policy: POLICY_VERSION,
				source: "machine",
				report,
			});
		} catch {
			res.status(503).json({ error: "statistics_read_failed" });
		}
	});
	router.get("/show", (req, res) => {
		const query = showQuerySchema.safeParse(req.query);
		if (!query.success) {
			res.status(400).json({ error: "invalid_audit_query" });
			return;
		}
		try {
			const result = store.getShipJudgmentReader().show(query.data);
			if (!result) {
				res.status(404).json({ error: "audit_not_found" });
				return;
			}
			res.json(result);
		} catch {
			res.status(503).json({ error: "audit_read_failed" });
		}
	});
	return router;
}
