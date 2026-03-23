import { describe, expect, it } from "vitest";
import { createMemoryService } from "../memory/createMemoryService.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const RUN_LIVE = process.env.RUN_MEM0_LIVE_TESTS === "true";

describe.skipIf(!RUN_LIVE || !SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_API_KEY)(
	"MemoryService — Supabase live smoke test",
	() => {
		it("factory creates service and round-trips add + search", async () => {
			const uniqueProject = `flywheel-smoke-${Date.now()}`;

			const svc = await createMemoryService({
				googleApiKey: GOOGLE_API_KEY!,
				supabaseUrl: SUPABASE_URL!,
				supabaseKey: SUPABASE_KEY!,
				projectName: uniqueProject,
			});

			expect(svc).toBeDefined();
			if (!svc)
				throw new Error(
					"createMemoryService returned undefined — Supabase init failed",
				);

			const addResult = await svc.addMessages({
				messages: [
					{ role: "user", content: "Live smoke test issue" },
					{
						role: "assistant",
						content:
							"Session result: success. test: verify Supabase integration",
					},
				],
				projectName: uniqueProject,
				userId: "live-test-user",
				agentId: "test-agent",
			});
			expect(addResult.added + addResult.updated).toBeGreaterThan(0);

			const searchResult = await svc.searchAndFormat({
				query: "Supabase integration test",
				projectName: uniqueProject,
				userId: "live-test-user",
			});
			expect(searchResult).not.toBeNull();
			expect(searchResult).toContain("<project_memory>");
		}, 30000);
	},
);
