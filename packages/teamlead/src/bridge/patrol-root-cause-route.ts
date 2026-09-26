/**
 * FLY-2914: read-only root-cause scheduling facts for the shell patrol path.
 *
 * GET  /api/patrol/root-causes?projectName=&leadId=  → { v: 1, lines }
 * POST /api/patrol/root-causes/verify { report }     → { valid, errors }
 *
 * The Bridge owns the Linear credential and StateStore; the Lead's shell only
 * receives rendered report lines and verdicts. Nothing here writes Linear,
 * founder_ask, Discord or any run state.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import {
	collectRootCauseFacts,
	type LinearRequest,
	type RootCauseFacts,
	renderRootCauseLines,
	verifyRootCauseEvidence,
} from "../patrol-root-causes.js";
import type { StateStore } from "../StateStore.js";

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPORT_NAME = /^[0-9]{8}T[0-9]{6}Z-tick(?:NA|[0-9]{1,16})\.md$/;

export interface PatrolRootCauseSource {
	store: Pick<
		StateStore,
		"getActiveWorkflowRunIdForAliases" | "getOpenPatrolScheduleAsk"
	>;
	/** Fresh read-only Linear requester per call, or undefined when unconfigured. */
	linearRequest(): LinearRequest | undefined;
	stateDir: string;
}

export async function collectPatrolRootCauses(
	source: PatrolRootCauseSource,
	projectName: string,
	leadId: string,
): Promise<RootCauseFacts> {
	return collectRootCauseFacts({
		projectName,
		leadId,
		request: source.linearRequest(),
		state: {
			activeRunId: (project, aliases) =>
				source.store.getActiveWorkflowRunIdForAliases(project, aliases),
			openAsk: (project, key) =>
				source.store.getOpenPatrolScheduleAsk(project, key),
		},
	});
}

/** Newest prior report of this Lead (carry-forward input only; never trusted as evidence). */
export function readPriorPatrolReport(
	stateDir: string,
	leadId: string,
): string | undefined {
	if (!SAFE_KEY.test(leadId)) return undefined;
	const dir = join(stateDir, "patrol-reports", leadId);
	try {
		const latest = readdirSync(dir)
			.filter((name) => REPORT_NAME.test(name))
			.sort()
			.at(-1);
		if (!latest) return undefined;
		const path = join(dir, latest);
		if (statSync(path).size > 1024 * 1024) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Rendered STEP 6 root-cause lines for one snapshot; failures render as unavailable. */
export async function renderPatrolRootCauses(
	source: PatrolRootCauseSource,
	projectName: string,
	leadId: string,
): Promise<{ v: 1; lines: string[] }> {
	const facts = await collectPatrolRootCauses(source, projectName, leadId);
	return {
		v: 1,
		lines: renderRootCauseLines(facts, {
			priorReport: readPriorPatrolReport(source.stateDir, leadId),
			nowMs: Date.now(),
		}),
	};
}

export function createPatrolRootCauseRouter(
	source: PatrolRootCauseSource & {
		getAsk: StateStore["getFounderAsk"];
	},
): Router {
	const router = Router();
	router.get("/", async (req: Request, res: Response) => {
		const projectName = String(req.query.projectName ?? "");
		const leadId = String(req.query.leadId ?? "");
		if (!SAFE_KEY.test(projectName) || !SAFE_KEY.test(leadId)) {
			res.status(400).json({ error: "invalid_scope" });
			return;
		}
		try {
			res.json(await renderPatrolRootCauses(source, projectName, leadId));
		} catch {
			res.status(502).json({ error: "root_cause_source_unavailable" });
		}
	});
	router.post("/verify", async (req: Request, res: Response) => {
		const report = (req.body as { report?: unknown } | undefined)?.report;
		if (typeof report !== "string" || Buffer.byteLength(report) > 1024 * 1024) {
			res.status(400).json({ error: "invalid_report" });
			return;
		}
		const projectName = /^project: (.*)$/m.exec(report)?.[1] ?? "";
		const leadId = /^lead: (.*)$/m.exec(report)?.[1] ?? "";
		if (!SAFE_KEY.test(projectName) || !SAFE_KEY.test(leadId)) {
			res.status(400).json({ error: "invalid_scope" });
			return;
		}
		try {
			const fresh = await collectPatrolRootCauses(source, projectName, leadId);
			res.json(
				verifyRootCauseEvidence(report, {
					getAsk: (askId) => source.getAsk(askId),
					nowMs: Date.now(),
					fresh,
				}),
			);
		} catch {
			res.status(502).json({ error: "root_cause_verifier_unavailable" });
		}
	});
	return router;
}
