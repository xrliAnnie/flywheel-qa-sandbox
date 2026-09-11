import { describe, expect, it } from "vitest";
import {
	buildWorkflowReworkContext,
	renderWorkflowReworkContextLine,
	renderWorkflowReworkLaunchSection,
	renderWorkflowReworkLaunchStableSection,
	workflowReworkLaunchDigest,
} from "../workflow-rework-context.js";
import { renderWorkflowReworkWakeContent } from "../workflow-rework-wake-copy.js";

const request = {
	request_id: "rework-1",
	authority: "qa" as const,
	authority_context_json: JSON.stringify({
		outcome: "qa_fail",
		sourceExecutionId: "qa-1",
	}),
};
const route = {
	target_node_id: "implement",
	target_attempt: 2,
	invalidation_scope: ["implement"],
	verification_policy: ["qa"],
};

describe("replacement launch rework context", () => {
	it("preserves the wake context in the launch envelope with stable revision-bound evidence", () => {
		const built = buildWorkflowReworkContext({ request, route });
		expect(built.ok).toBe(true);
		if (!built.ok) throw new Error(built.reason);
		expect(built.context).toEqual({
			requestId: "rework-1",
			authority: "qa",
			authorityContext: { outcome: "qa_fail", sourceExecutionId: "qa-1" },
			target: {
				nodeId: "implement",
				attempt: 2,
				invalidationScope: ["implement"],
				verificationPolicy: ["qa"],
			},
		});
		const stableSection = renderWorkflowReworkLaunchStableSection({
			context: built.context,
			baseRevision: "a".repeat(40),
		});
		expect(stableSection).toContain("Previous verdict: qa_fail.");
		expect(stableSection).toContain(
			`Base revision under rework: ${"a".repeat(40)}.`,
		);
		const line = renderWorkflowReworkContextLine(built.context);
		expect(stableSection).toContain(line);
		expect(
			renderWorkflowReworkWakeContent({
				wakeId: "w",
				activationId: "a",
				epoch: 2,
				executionId: "e",
				context: built.context,
			}),
		).toBe(
			`[phase-wake w] Workflow rework activation a is ready at TURN epoch 2. FIRST run flywheel-comm turn --exec-id e; proceed only if it answers yours. ${line}`,
		);
		expect(
			renderWorkflowReworkLaunchSection({
				stableSection,
				qaSummary: "Fix receipt validation",
			}),
		).toBe(`${stableSection}\nQA summary: Fix receipt validation`);
		expect(renderWorkflowReworkLaunchSection({ stableSection })).toBe(
			`${stableSection}\nQA summary: (no QA summary provided)`,
		);
		const evidence = { requestId: "rework-1", routeRevision: 1, stableSection };
		const digest = workflowReworkLaunchDigest(evidence);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(
			workflowReworkLaunchDigest({ ...evidence, routeRevision: 2 }),
		).not.toBe(digest);
		expect(
			workflowReworkLaunchDigest({
				...evidence,
				stableSection: `${stableSection} changed`,
			}),
		).not.toBe(digest);
	});
	it("refuses corrupt stored authority JSON", () => {
		expect(
			buildWorkflowReworkContext({
				request: { ...request, authority_context_json: "{" },
				route,
			}),
		).toEqual({ ok: false, reason: "authority_context_corrupt" });
	});
	it("preserves the verification label for node reuse", () => {
		const context = { authorityContext: { kind: "node_reuse" } };
		expect(renderWorkflowReworkContextLine(context)).toBe(
			`Verification context: ${JSON.stringify(context)}`,
		);
	});
});
