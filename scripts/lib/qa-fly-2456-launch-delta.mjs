import { readFileSync } from "node:fs";
import { observeRound } from "./qa-fly-2456-observe.mjs";

const name = (value) =>
	typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
// DEVIATION #16 (FLY-2456 host drill): activation ids carry ":" separators (activation:<exec>:<run>:<node>:<attempt>)
const activationName = (value) =>
	typeof value === "string" && /^[a-zA-Z0-9_:.-]+$/.test(value);
function listing(path) {
	const raw = readFileSync(path, "utf8");
	const rows = raw === "" ? [] : raw.replace(/\n$/, "").split("\n");
	if (rows.some((row) => !name(row)) || new Set(rows).size !== rows.length)
		throw new Error("invalid launch inventory");
	return new Set(rows);
}
export function launchCommitsDelta({
	beforePath,
	afterPath,
	manifest,
	dbPath,
	cycleStep,
}) {
	try {
		const before = listing(beforePath),
			after = listing(afterPath),
			declared = new Set();
		if (!manifest?.steps || typeof manifest.steps !== "object")
			throw new Error("manifest missing");
		const labels = new Set();
		for (const entry of Object.values(manifest.steps)) {
			if (entry.intent?.detail?.kind !== "start") continue;
			const detail = entry.intent.detail;
			if (
				!["B1", "B2", "B3", "PRE"].includes(detail.label) ||
				labels.has(detail.label)
			)
				throw new Error("start label invalid or duplicate");
			labels.add(detail.label);
			const expectedIssue =
				manifest.config?.issues?.[detail.label] ??
				manifest.bodies?.[detail.label]?.issueId ??
				manifest.auxiliaryBodies?.[detail.label]?.issueId;
			if (expectedIssue !== undefined && detail.issueId !== expectedIssue)
				throw new Error("start issue binding mismatch");
			const result = entry.receipt?.result;
			if (!result) continue;
			if (
				result.success !== true ||
				result.generalized !== true ||
				!name(result.executionId) ||
				!name(result.workflowRunId) ||
				!name(result.workflowNodeId)
			)
				throw new Error("start receipt invalid");
			declared.add(result.executionId);
		}
		const qaEntries = Object.values(manifest.steps).filter(
			(e) => e.intent?.detail?.kind === "qa-identity",
		);
		if (qaEntries.length > 1) throw new Error("duplicate QA identity");
		for (const entry of qaEntries) {
			const d = entry.intent.detail,
				r = entry.receipt?.result;
			if (!r) continue;
			const parents = Object.values(manifest.steps).filter(
				(e) =>
					e.intent?.detail?.kind === "start" &&
					e.intent.detail.label === "B1" &&
					e.receipt,
			);
			if (
				d.label !== "B1" ||
				parents.length !== 1 ||
				d.issueId !== manifest.config?.issues?.B1 ||
				r.source !== "workflow-engine" ||
				r.workflowRunId !== parents[0].receipt.result.workflowRunId ||
				r.issueId !== d.issueId ||
				r.workflowNodeId !== "qa" ||
				r.attempt !== 1 ||
				!activationName(r.activationId) ||
				!name(r.executionId)
			)
				throw new Error("QA identity invalid");
			declared.add(r.executionId);
		}
		let replacement;
		if (dbPath !== undefined || cycleStep !== undefined) {
			const cycle = manifest.steps[cycleStep]?.intent?.detail;
			if (cycle?.kind !== "cycle" || !cycle.preState?.bounds)
				throw new Error("cycle evidence missing");
			const bodies = Object.fromEntries(
				["B1", "B2", "B3"].map((label) => {
					const matches = Object.values(manifest.steps).filter(
						(entry) =>
							entry.intent?.detail?.kind === "start" &&
							entry.intent.detail.label === label &&
							entry.receipt,
					);
					if (matches.length !== 1) throw new Error("body start ambiguous");
					const r = matches[0].receipt.result;
					return [
						label,
						{
							executionId: r.executionId,
							runId: r.workflowRunId,
							nodeId: r.workflowNodeId,
						},
					];
				}),
			);
			const observed = observeRound({
				dbPath,
				bounds: cycle.preState.bounds,
				bodies,
			});
			if (observed.status !== "pass")
				throw new Error("replacement authority invalid");
			replacement = observed.bodies.B1.replacement;
			if (replacement) declared.add(replacement.executionId);
		}
		const added = [...after].filter((id) => !before.has(id)),
			removed = [...before].filter((id) => !after.has(id));
		const unknown = added.filter((id) => !declared.has(id));
		return {
			status: unknown.length || removed.length ? "fail" : "pass",
			added,
			removed,
			unknown,
			declared: [...declared],
			replacement,
			retainedAfterTeardown: true,
		};
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
