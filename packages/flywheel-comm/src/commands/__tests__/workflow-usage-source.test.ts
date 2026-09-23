import { describe, expect, it, vi } from "vitest";
import { workflowUsageSource } from "../workflow-usage-source.js";

describe("workflow usage source hook", () => {
	it("posts only native identity and source location with the ingest bearer", async () => {
		const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
		await workflowUsageSource({
			event: "turn-start",
			stdin: JSON.stringify({
				session_id: "session-1",
				transcript_path: "/trusted/projects/session-1.jsonl",
				prompt: "must not leave the hook process",
			}),
			env: {
				FLYWHEEL_EXEC_ID: "exec-1",
				FLYWHEEL_WORKFLOW_ACTIVATION_ID: "activation-1",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
				FLYWHEEL_INGEST_TOKEN: "secret",
			},
			fetchFn,
		});
		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:9876/api/workflow/usage-source");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
		expect(JSON.parse(String(init?.body))).toEqual({
			event: "turn-start",
			execution_id: "exec-1",
			activation_id: "activation-1",
			session_id: "session-1",
			transcript_path: "/trusted/projects/session-1.jsonl",
		});
	});
});
