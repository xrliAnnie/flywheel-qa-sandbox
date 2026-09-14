import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateReadiness, type ReadinessInput } from "../../../../packages/teamlead/src/bridge/release-readiness/evaluate.js";
import { readReadinessPolicy } from "../../../../packages/teamlead/src/bridge/release-readiness/policy.js";
import { scanReadinessOutbox } from "../../../../packages/teamlead/src/bridge/release-readiness/service.js";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
export function buildReplay(state: "green" | "hold" | "unknown"): ReadinessInput {
	const now = "2026-09-11T12:00:00.000Z";
	const sourceCommit = "a".repeat(40);
	const start = Date.parse("2026-09-08T12:00:00.000Z");
	const heartbeats = Array.from({length: 4321}, (_, i) => ({tickAt: new Date(start + i * 60_000).toISOString(), sourceCommit, baseVersion: "1.56.0", w1Freshness: "fresh", alertDeliveryEnabled: true, claimsDbOk: true, ingestOk: true, gapsDirOk: true, bridgeCaptureFailures: 0, rejectedRows: 0, backlogAgeS: 0, outboxPending: 0, outboxInvalid: 0}));
	const input: ReadinessInput = {subject: {sourceCommit, baseVersion: "1.56.0"}, now, localDeployedSha: sourceCommit, policy: readReadinessPolicy({FLYWHEEL_READINESS_REPORT_CHANNEL: "fixture-channel"}), anchor: read<ReadinessInput["anchor"][]>("anchors.json")[state === "unknown" ? 2 : 1]!, heartbeats, events: read("events.json"), gaps: [], bugs: state === "hold" ? read("bugs.json") : [], bugSourceHealth: null, publications: read("publications.json"), founderVerdicts: state === "hold" ? read("founder-verdicts.json") : [], outbox: {gapsPending: 0, gapsInvalid: 0, publicationsPending: 0, publicationsInvalid: 0, oldestPendingAt: null, readErrors: []}};
	if (state === "unknown") {
		input.heartbeats = heartbeats.slice(0, -120);
		input.events.push({eventId: "replay-no-version-tag", sourceCommit: null, baseVersion: null, occurrence: 1, projectName: "flywheel", kind: "deploy_failed", severity: "severe", observedAt: now});
		input.bugSourceHealth = read("bug-source-health.json");
		input.outbox = scanReadinessOutbox(fileURLToPath(new URL("outbox/", import.meta.url))).counts;
		// Filesystem mtimes are not replay evidence; use the fixture observation time.
		input.outbox.oldestPendingAt = now;
	}
	return input;
}

export function replayVerdict(input: ReadinessInput) {
	const result = evaluateReadiness(input);
	return {...result, subject: input.subject, evaluatedAt: input.now, verdictId: `rr-replay-${result.state}`};
}
