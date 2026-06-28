/**
 * FLY-643: AutoQaEffects.createQaIssue — creates the separate QA·FLY-XX Linear
 * issue mirroring the parent's team / project / labels, fail-closed on any error.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	AutoQaEffects,
	buildQaIssueContent,
	type LinearClientLike,
} from "../auto-qa-effects.js";

const SHA = "a".repeat(40);

function parentSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "main-1",
		issue_id: "parent-uuid",
		project_name: "proj",
		issue_identifier: "FLY-643",
		issue_title: "Auto-QA separate issue",
		issue_url: "https://linear.app/x/issue/FLY-643",
		pr_number: 42,
		...over,
	} as Session;
}

function makeEffects(opts: {
	apiKey?: string;
	clientFactory?: (apiKey: string) => LinearClientLike;
}) {
	return new AutoQaEffects({
		store: {} as never,
		projects: [],
		config: { linearApiKey: opts.apiKey } as never,
		...(opts.clientFactory && { linearClientFactory: opts.clientFactory }),
	});
}

/** A fake Linear client that records the createIssue input. */
function fakeClient(over?: {
	team?: { id: string };
	project?: { id: string };
	labels?: { id: string }[];
	createdIssue?: { id?: string; identifier?: string; url?: string };
}) {
	const calls: {
		teamId: string;
		title: string;
		description?: string;
		labelIds?: string[];
		projectId?: string;
	}[] = [];
	const client: LinearClientLike = {
		issue: () => ({
			identifier: "FLY-643",
			title: "Auto-QA separate issue",
			url: "https://linear.app/x/issue/FLY-643",
			team: over?.team ?? { id: "team-FLY" },
			project: over?.project,
			labels: () => ({ nodes: over?.labels ?? [] }),
		}),
		createIssue: (input) => {
			calls.push(input);
			return {
				issue: over?.createdIssue ?? {
					id: "qa-issue-uuid",
					identifier: "FLY-700",
					url: "https://linear.app/x/issue/FLY-700",
				},
			};
		},
	};
	return { client, calls };
}

describe("buildQaIssueContent (FLY-643)", () => {
	it("titles QA · <parent> — <title> and embeds parent link / PR / commit", () => {
		const { title, description } = buildQaIssueContent({
			parentIdentifier: "FLY-643",
			parentTitle: "Auto-QA separate issue",
			parentUrl: "https://linear.app/x/issue/FLY-643",
			prNumber: 42,
			prHeadSha: SHA,
		});
		expect(title).toBe("QA · FLY-643 — Auto-QA separate issue");
		expect(description).toContain("FLY-643");
		expect(description).toContain("https://linear.app/x/issue/FLY-643");
		expect(description).toContain("#42");
		expect(description).toContain(SHA);
		expect(description).toContain("qa-result");
	});

	it("omits the PR line when no PR number", () => {
		const { description } = buildQaIssueContent({
			parentIdentifier: "FLY-1",
			prHeadSha: SHA,
		});
		expect(description).not.toContain("- PR:");
	});
});

describe("AutoQaEffects.createQaIssue (FLY-643)", () => {
	it("creates the QA issue mirroring parent team / project / labels", async () => {
		const { client, calls } = fakeClient({
			team: { id: "team-FLY" },
			project: { id: "proj-flywheel" },
			labels: [{ id: "label-flywheel" }, { id: "label-engineer" }],
		});
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toEqual({
			issueId: "qa-issue-uuid",
			issueIdentifier: "FLY-700",
			issueTitle: "QA · FLY-643 — Auto-QA separate issue",
			issueUrl: "https://linear.app/x/issue/FLY-700",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			teamId: "team-FLY",
			projectId: "proj-flywheel",
			labelIds: ["label-flywheel", "label-engineer"],
			title: "QA · FLY-643 — Auto-QA separate issue",
		});
	});

	it("works without a project (label-only scoped) — omits projectId", async () => {
		const { client, calls } = fakeClient({ team: { id: "team-FLY" } });
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref?.issueId).toBe("qa-issue-uuid");
		expect(calls[0]?.projectId).toBeUndefined();
		expect(calls[0]?.labelIds).toBeUndefined();
	});

	it("fail-closed: no LINEAR_API_KEY → undefined (no client call)", async () => {
		const factory = vi.fn();
		const effects = makeEffects({ apiKey: undefined, clientFactory: factory });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
		expect(factory).not.toHaveBeenCalled();
	});

	it("fail-closed: parent issue has no team → undefined", async () => {
		const client: LinearClientLike = {
			issue: () => ({
				team: undefined,
				labels: () => ({ nodes: [] }),
			}),
			createIssue: () => ({ issue: { id: "should-not-happen" } }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});

	it("fail-closed: Linear throws → undefined (never throws to the coordinator)", async () => {
		const client: LinearClientLike = {
			issue: () => {
				throw new Error("Linear API error");
			},
			createIssue: () => ({ issue: { id: "x" } }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});

	it("fail-closed: createIssue returns no issue → undefined", async () => {
		const client: LinearClientLike = {
			issue: () => ({
				team: { id: "team-FLY" },
				labels: () => ({ nodes: [] }),
			}),
			createIssue: () => ({ issue: undefined }),
		};
		const effects = makeEffects({ apiKey: "k", clientFactory: () => client });
		const ref = await effects.createQaIssue({
			parent: parentSession(),
			prHeadSha: SHA,
		});
		expect(ref).toBeUndefined();
	});
});
