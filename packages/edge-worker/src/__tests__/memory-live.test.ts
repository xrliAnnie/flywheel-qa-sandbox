import { describe, it, expect } from "vitest";
import { MemoryService } from "../memory/MemoryService.js";

// NO vi.mock here — uses real mem0 with real Gemini API
// Run with: RUN_MEM0_LIVE_TESTS=true GOOGLE_API_KEY=xxx pnpm test

describe("Memory System Live E2E", () => {
	const skipLive = !process.env.RUN_MEM0_LIVE_TESTS;

	it.skipIf(skipLive)("add + search round-trip with real mem0", async () => {
		const svc = new MemoryService({
			googleApiKey: process.env.GOOGLE_API_KEY!,
			historyDbPath: ":memory:",
			collectionName: `test-${Date.now()}`,
		});

		await svc.addSessionMemory({
			projectName: "live-test",
			executionId: "live-exec-1",
			issueId: "TEST-1",
			issueTitle: "Fix database connection pooling",
			sessionResult: "success",
			commitMessages: ["fix: increase pool size to 20"],
			diffSummary: "Modified db.ts: pool_size 5 -> 20",
		});

		const block = await svc.searchAndFormat({
			query: "database connection issues",
			projectName: "live-test",
		});

		expect(block).toContain("<project_memory>");
	}, 30_000);
});
