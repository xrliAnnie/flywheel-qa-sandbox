import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import { createContext7Handlers } from "../handlers/context7.js";

const scope = vi.hoisted(() => ({ valid: true }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!scope.valid) throw Error("stale");
		},
	}),
}));
it("calls only pinned docs tools and denies schema drift, stale scope and credential content", async () => {
	const snapshot = JSON.parse(
		readFileSync(
			resolve(
				"../../engineering/doc/FLY-2519-codex-lead-parity/upstream-context7-schema.json",
			),
			"utf8",
		),
	);
	let tools = snapshot.tools,
		reply: unknown = { content: [{ type: "text", text: "documentation" }] };
	const client = {
		getServerVersion: () => ({ name: "Context7", version: "4.1.0" }),
		listTools: vi.fn(async () => ({ tools })),
		callTool: vi.fn(async () => reply),
	};
	const handlers = createContext7Handlers({
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
		client: client as unknown as Client,
		secrets: ["CREDENTIAL_CANARY"],
	});
	const context: LeadOperationContext = {
		requestId: randomUUID(),
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	try {
		const lookup = handlers.get("docs.lookup")!,
			resolver = handlers.get("docs.library.resolve")!;
		expect(
			(
				await lookup.execute(
					{ libraryId: "/org/library", query: "setup" },
					context,
				)
			).status,
		).toBe("succeeded");
		expect(client.callTool.mock.calls[0]![0]).toMatchObject({
			name: "query-docs",
			arguments: { libraryId: "/org/library", query: "setup" },
		});
		expect(
			(
				await resolver.execute(
					{ libraryName: "library", query: "setup" },
					context,
				)
			).status,
		).toBe("succeeded");
		expect(client.callTool.mock.calls[1]![0]).toMatchObject({
			name: "resolve-library-id",
		});
		await expect(
			lookup.authorize(
				{ libraryId: "/org/library", query: "setup", url: "https://foreign" },
				context,
			),
		).rejects.toThrow();
		expect(
			(
				await lookup.execute(
					{ libraryId: "/org/library", query: "CREDENTIAL_CANARY" },
					context,
				)
			).status,
		).toBe("rejected");
		expect(client.callTool).toHaveBeenCalledTimes(2);
		tools = [];
		expect(
			(
				await lookup.execute(
					{ libraryId: "/org/library", query: "setup" },
					context,
				)
			).errorCode,
		).toBe("baseline_drift");
		expect(client.callTool).toHaveBeenCalledTimes(2);
		tools = snapshot.tools;
		reply = { content: [{ type: "text", text: "CREDENTIAL_CANARY" }] };
		expect(
			(
				await lookup.execute(
					{ libraryId: "/org/library", query: "setup" },
					context,
				)
			).status,
		).toBe("unknown");
		scope.valid = false;
		expect(
			(
				await lookup.execute(
					{ libraryId: "/org/library", query: "setup" },
					context,
				)
			).status,
		).toBe("rejected");
		expect(client.callTool).toHaveBeenCalledTimes(3);
	} finally {
		scope.valid = true;
	}
});
