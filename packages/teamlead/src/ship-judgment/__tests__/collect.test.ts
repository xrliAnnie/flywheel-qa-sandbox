import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectJudgmentInput } from "../collect.js";
import { bindingFixture, CHANNEL, HEAD } from "./binding-fixture.js";

describe("judgment source collection", () => {
	it("combines pinned plan, QA and full diff with provenance and validates every repository head", async () => {
		const { store } = await bindingFixture();
		try {
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const qa = "<p>R1 test: PASS</p>";
			const deps = {
				issue: async () => ({
					body: "R1: do the thing",
					format: "text" as const,
					revision: "issue-revision",
				}),
				plan: async () => ({
					body: "R1: do the thing",
					format: "text" as const,
					revision: "plan-blob",
				}),
				qa: async () => ({
					body: qa,
					format: "html" as const,
					revision: "qa-record",
					runId: "r",
					repoIdentity: "__main__",
					headSha: HEAD,
					digest: createHash("sha256").update(qa).digest("hex"),
					withdrawn: false,
				}),
				diff: async () => ({
					baseSha: "b".repeat(40),
					headSha: HEAD,
					text: "+implemented",
					complete: true,
					files: [{ path: "src/a.ts", status: "A" }],
				}),
				currentBinding: () => store.readShipJudgmentBinding("q", CHANNEL),
			};
			const args = {
				binding,
				channelId: CHANNEL,
				model: {
					model: "fixture",
					effort: "high",
					configuration_digest: "c".repeat(64),
				},
				prompt: "Evaluate",
				requirements: [
					{
						requirement_id: "R1",
						source_id: "plan",
						quote_start: 0,
						quote_end: 16,
					},
				],
			};
			const result = await collectJudgmentInput(args, deps);
			expect(result.status).toBe("ready");
			if (result.status !== "ready") throw new Error(result.status);
			expect(
				result.packet.sources.some((source) => source.text === "R1 test: PASS"),
			).toBe(true);
			expect(result.packet.files).toEqual([
				{ repo_identity: "__main__", path: "src/a.ts" },
			]);
			const supplemented = await collectJudgmentInput(
				{
					...args,
					requirements: [
						{
							requirement_id: "R2",
							source_id: "revision:1",
							quote_start: 0,
							quote_end: 13,
						},
					],
				},
				{
					...deps,
					supplements: async () => [
						{
							sourceId: "prd:1",
							kind: "prd" as const,
							body: "<p>Prior scope</p>",
							format: "html" as const,
							revision: "blob-1",
						},
						{
							sourceId: "revision:1",
							kind: "revision" as const,
							body: "<p>R2: new scope</p>",
							format: "html" as const,
							revision: "message-revision",
							acceptanceRef: "founder-message:123",
						},
					],
				},
			);
			expect(supplemented.status).toBe("ready");
			if (supplemented.status !== "ready") throw new Error(supplemented.reason);
			expect(
				supplemented.packet.sources.find(
					(source) => source.source_id === "revision:1",
				)?.revision,
			).toContain("founder-message:123");
			for (const supplement of [
				{
					sourceId: "revision:1",
					kind: "revision" as const,
					body: "unaccepted",
					format: "text" as const,
					revision: "1",
				},
				{
					sourceId: "issue",
					kind: "prd" as const,
					body: "overwrite",
					format: "text" as const,
					revision: "1",
				},
			])
				expect(
					(
						await collectJudgmentInput(args, {
							...deps,
							supplements: async () => [supplement],
						})
					).status,
				).toBe("undetermined");
			expect(
				(
					await collectJudgmentInput(args, {
						...deps,
						qa: async () => ({ ...(await deps.qa()), headSha: "d".repeat(40) }),
					})
				).status,
			).toBe("undetermined");
			expect(
				(
					await collectJudgmentInput(args, {
						...deps,
						diff: async () => ({ ...(await deps.diff()), complete: false }),
					})
				).status,
			).toBe("undetermined");
			expect(
				(
					await collectJudgmentInput(args, {
						...deps,
						currentBinding: () => undefined,
					})
				).status,
			).toBe("undetermined");
		} finally {
			store.close();
		}
	});
});
