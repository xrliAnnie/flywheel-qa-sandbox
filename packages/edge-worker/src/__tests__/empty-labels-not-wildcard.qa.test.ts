import type { AgentConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";

/**
 * FLY-1335 QA (independent verification phase): pin the SEMANTIC CONTRACT the
 * fix rests on, synthetically — no dependency on `.flywheel/config.yaml`, so
 * this suite still guards the invariant for every project (and for a future
 * config that reshuffles its agents).
 *
 * The contract chosen for FLY-1335 was option B/C, NOT option A:
 *   - an empty `match.labels` array is NOT a wildcard — it never wins label
 *     matching, at step 2a (own-dept) or step 2b (top-level);
 *   - "no label matched → project catch-all" is expressed ONLY by declaring
 *     `default_agent` (step 3a);
 *   - without `default_agent`, an unmatched issue still falls to the shipped
 *     generic executor (the exact production symptom FLY-1335 reported).
 *
 * If a future change makes empty-labels mean wildcard (option A), these tests
 * MUST be updated deliberately — that is the point of pinning them.
 */

const REPO_ROOT = "/tmp/fly1335-qa-flywheel-root";

/** Top-level (no dept dir) catch-all with an empty labels array. */
const GENERAL: AgentConfig = {
	agent_file: ".flywheel/agents/general-executor.md",
	match: { labels: [] },
};

/** Dept-scoped agent with an empty labels array (step-2a exposure). */
const DEPT_EMPTY: AgentConfig = {
	agent_file: ".flywheel/agents/engineering/quiet-executor.md",
	department: "engineering",
	match: { labels: [] },
};

/** Ordinary label-matching agent — the "still routes normally" control. */
const ENGINEER: AgentConfig = {
	agent_file: ".flywheel/agents/engineering/engineer-executor.md",
	department: "engineering",
	match: { labels: ["code"] },
};

describe("FLY-1335 QA: empty match.labels is never a wildcard", () => {
	it("reproduces the reported bug: empty-labels catch-all + no default_agent -> shipped-generic", () => {
		// This is the production symptom FLY-1335 filed: the config *looks* like
		// it declares a catch-all, but the issue silently leaves the project.
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER, general: GENERAL },
			undefined,
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["totally-unmatched"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("generic");
		expect(r.matchMethod).toBe("shipped-generic");
		expect(r.agentFileRoot).toBe("flywheel");
	});

	it("empty labels never win step-2b even as the ONLY agent", () => {
		const dispatcher = new AgentDispatcher(
			{ general: GENERAL },
			undefined,
			REPO_ROOT,
		);
		for (const issueLabels of [[], ["bug"], ["general"]]) {
			const r = dispatcher.dispatch({ issueLabels, owningDept: undefined });
			expect(r.matchMethod).toBe("shipped-generic");
		}
	});

	it("empty labels never win step-2a (own-dept scope) either", () => {
		const dispatcher = new AgentDispatcher(
			{ quiet: DEPT_EMPTY },
			undefined,
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["anything"],
			owningDept: "engineering",
		});
		expect(r.agentName).not.toBe("quiet");
		expect(r.matchMethod).toBe("shipped-generic");
	});

	it("default_agent is what makes the empty-labels agent reachable (the fix)", () => {
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER, general: GENERAL },
			"general",
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["totally-unmatched"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
		expect(r.agentFileRoot).toBe("project");
		expect(r.agentConfig.agent_file).toBe(
			".flywheel/agents/general-executor.md",
		);
	});

	it("default_agent never shadows a real label match (step 2 wins over step 3a)", () => {
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER, general: GENERAL },
			"general",
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["code"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("engineer");
		expect(r.matchMethod).toBe("label");
	});

	it("a default_agent naming a NON-empty-labels agent still works (mechanism is label-agnostic)", () => {
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER },
			"engineer",
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["unmatched"],
			owningDept: "ops",
		});
		expect(r.agentName).toBe("engineer");
		expect(r.matchMethod).toBe("default");
		// dept derived from the agent_file path, not from owningDept
		expect(r.department).toBe("engineering");
	});

	it("a dangling default_agent degrades to shipped-generic, never throws", () => {
		// REGRESSION PIN, not a new invariant: AgentDispatcher.test.ts:242 already
		// covers this path. Repeated here only so this synthetic fixture exercises
		// the same degradation, keeping the suite self-contained.
		// ConfigLoader rejects this at load time; the dispatcher must still be
		// defensive because it is constructible from any caller (scripts/tests).
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER },
			"does-not-exist",
			REPO_ROOT,
		);
		const r = dispatcher.dispatch({
			issueLabels: ["unmatched"],
			owningDept: "engineering",
		});
		expect(r.matchMethod).toBe("shipped-generic");
	});

	it('reserved agentName:"generic" still bypasses the project catch-all', () => {
		// REGRESSION PIN, not a new invariant: AgentDispatcher.test.ts:327 already
		// covers dispatchByName("generic"). Note the `defaultAgent: "general"` below
		// is NOT causal — dispatchByName short-circuits on the reserved name
		// (AgentDispatcher.ts:277) BEFORE it ever reads this.defaultAgent, so this
		// passes for any defaultAgent value. It documents the escape hatch survives
		// the FLY-1335 change; it does not prove an interaction, because the two
		// are structurally independent.
		const dispatcher = new AgentDispatcher(
			{ engineer: ENGINEER, general: GENERAL },
			"general",
			REPO_ROOT,
		);
		const r = dispatcher.dispatchByName("generic");
		expect(r.matchMethod).toBe("shipped-generic");
		expect(r.agentFileRoot).toBe("flywheel");
	});
});
