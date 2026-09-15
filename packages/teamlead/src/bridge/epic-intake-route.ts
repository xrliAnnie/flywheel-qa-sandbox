import express from "express";
import { z } from "zod";
import type { StateStore } from "../StateStore.js";
import {
	type EpicIntakeEvidenceObservation,
	type EpicIntakeResult,
	epicIntakeResultSchema,
	validateEpicIntakeEvidence,
} from "./epic-intake-result.js";
import type { EpicIntakeRecord } from "./epic-intake-store.js";

const identity = z
	.object({
		projectName: z.string().min(1).max(512),
		leadId: z.string().min(1).max(512),
	})
	.strict();
const resolution = identity.extend({
	eventUid: z.string().min(1).max(512),
	evidence: epicIntakeResultSchema,
});
export interface EpicIntakeRouterDeps {
	store: Pick<StateStore, "listEpicIntakes" | "resolveEpicIntake">;
	ownsLead: (project: string, lead: string) => boolean;
	observe: (
		row: EpicIntakeRecord,
		evidence: EpicIntakeResult,
	) => Promise<EpicIntakeEvidenceObservation>;
	now?: () => Date;
	onEpicChange?: (project: string, reason: "epic_intake") => void;
}
export function createEpicIntakeRouter(
	deps: EpicIntakeRouterDeps,
): express.Router {
	const router = express.Router();
	router.use((_req, res, next) => {
		if (res.locals.reportCredentialTier !== "master") {
			res.status(403).json({ ok: false, error: "lead_access_required" });
			return;
		}
		next();
	});
	router.get("/", (req, res) => {
		const parsed = identity.safeParse(req.query);
		if (!parsed.success) {
			res.status(400).json({ ok: false, error: "invalid_arguments" });
			return;
		}
		const { projectName, leadId } = parsed.data;
		if (!deps.ownsLead(projectName, leadId)) {
			res.status(403).json({ ok: false, error: "owner_mismatch" });
			return;
		}
		res.json({
			ok: true,
			intakes: deps.store
				.listEpicIntakes(projectName)
				.filter((row) => row.leadId === leadId),
		});
	});
	router.post("/resolve", async (req, res) => {
		const fail = (status: number, error: string) => {
			res.status(status).json({ ok: false, error });
		};
		if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > 20 * 1024) {
			fail(413, "evidence_too_large");
			return;
		}
		const parsed = resolution.safeParse(req.body);
		if (!parsed.success) {
			fail(400, "invalid_arguments");
			return;
		}
		const { projectName, leadId, eventUid, evidence } = parsed.data;
		if (Buffer.byteLength(JSON.stringify(evidence)) > 16 * 1024) {
			fail(413, "evidence_too_large");
			return;
		}
		if (!deps.ownsLead(projectName, leadId)) {
			fail(403, "owner_mismatch");
			return;
		}
		const row = deps.store
			.listEpicIntakes(projectName)
			.find((row) => row.eventUid === eventUid);
		if (!row) {
			fail(404, "intake_not_found");
			return;
		}
		if (row.leadId !== leadId) {
			fail(403, "owner_mismatch");
			return;
		}
		if (JSON.stringify(row.result) === JSON.stringify(evidence)) {
			res.json({ ok: true, intake: row });
			return;
		}
		let observed: EpicIntakeEvidenceObservation;
		try {
			observed = await deps.observe(row, evidence);
		} catch {
			fail(503, "intake_evidence_unavailable");
			return;
		}
		try {
			validateEpicIntakeEvidence(evidence, observed);
			// Observation cannot silently reactivate an episode or supersede a still-active row.
			// The scan owns active-state changes; retry after its next successful observation.
			if (row.active !== observed.active) {
				fail(409, "intake_episode_changed");
				return;
			}
			const intake = deps.store.resolveEpicIntake(
				row,
				evidence,
				(deps.now ?? (() => new Date()))().toISOString(),
			);
			// Durable page_dirty is the retry authority even if the immediate refresh fails.
			try {
				deps.onEpicChange?.(projectName, "epic_intake");
			} catch {}
			res.json({ ok: true, intake });
		} catch {
			fail(409, "intake_resolution_conflict");
		}
	});
	return router;
}
