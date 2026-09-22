import { describe, expect, it } from "vitest";
import {
	getLeadCapability,
	LEAD_CAPABILITY_CATALOG,
	LEAD_PARITY_COVERAGE,
} from "../catalog.js";

describe("lead capability catalog", () => {
	it("has unique stable operations and all seventeen parity requirements", () => {
		const ids = LEAD_CAPABILITY_CATALOG.map((x) => x.operationId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(LEAD_PARITY_COVERAGE.map((x) => x.parityId)).toEqual(
			Array.from(
				{ length: 17 },
				(_, i) => `P${String(i + 1).padStart(2, "0")}`,
			),
		);
		for (const op of LEAD_CAPABILITY_CATALOG) {
			expect(op.scope).toBe("canonical-project-lead");
			expect(op.evidenceRequirements.length).toBeGreaterThan(0);
		}
	});
	it("denies reserved lifecycle operations and unknown operations", () => {
		for (const id of [
			"terminal.close",
			"bridge.ship",
			"bridge.merge",
			"bridge.terminate",
			"bridge.restart",
			"bridge.park",
			"bridge.unpark",
			"bridge.approve_to_ship",
		]) {
			expect(getLeadCapability(id)?.classification).toBe("reserved");
			expect(getLeadCapability(id)?.handlerKey).toBeNull();
		}
		expect(getLeadCapability("bridge.raw")).toBeUndefined();
	});
	it("validates concrete bounded contracts and rejects arbitrary credential fields", () => {
		const read = getLeadCapability("discord.thread.read")!;
		expect(
			read.inputSchema.safeParse({ threadId: "123", limit: 10 }).success,
		).toBe(true);
		for (const input of [
			{ threadId: "123", limit: 101 },
			{ threadId: "123", token: "secret" },
			{ url: "https://evil" },
		])
			expect(read.inputSchema.safeParse(input).success).toBe(false);
		expect(read.outputSchema.safeParse({}).success).toBe(false);
		expect(
			getLeadCapability("git.feature.push")!.inputSchema.safeParse({
				branch: "main",
			}).success,
		).toBe(false);
		expect(
			getLeadCapability(
				"discord.message.attachments.send",
			)!.inputSchema.safeParse({
				threadId: "123",
				artifactHandles: Array(11).fill("a"),
			}).success,
		).toBe(false);
	});
	it("defines strict self-scoped voice operation contracts", () => {
		const start = getLeadCapability("voice.session.start")!;
		expect(start.classification).toBe("write");
		expect(start.credentialConsumer).toBe("bridge");
		expect(
			start.inputSchema.safeParse({ mode: "rg", topic: "聊一下" }).success,
		).toBe(true);
		expect(
			start.inputSchema.safeParse({
				mode: "meeting",
				meetingId: "123e4567-e89b-42d3-a456-426614174000",
			}).success,
		).toBe(true);
		for (const input of [
			{ mode: "rg", meetingId: "123e4567-e89b-42d3-a456-426614174000" },
			{ mode: "rg", projectName: "foreign" },
			{ mode: "rg", token: "secret" },
			{ mode: "rg", topic: "x".repeat(201) },
		])
			expect(start.inputSchema.safeParse(input).success).toBe(false);
		expect(
			getLeadCapability("voice.session.status")!.inputSchema.safeParse({
				sessionId: "123e4567-e89b-42d3-a456-426614174000",
			}).success,
		).toBe(true);
	});
});

it("rejects control characters in identifiers and message text", () => {
	expect(
		getLeadCapability("discord.thread.read")!.inputSchema.safeParse({
			threadId: "123\u0000",
		}).success,
	).toBe(false);
	expect(
		getLeadCapability("discord.thread.reply")!.inputSchema.safeParse({
			threadId: "123",
			text: "hello\u001b",
		}).success,
	).toBe(false);
	expect(
		getLeadCapability("discord.thread.reply")!.inputSchema.safeParse({
			threadId: "123",
			text: "hello\nworld",
		}).success,
	).toBe(true);
});

it("binds native browser operations to exact filtered schemas", () => {
	const click = getLeadCapability("browser.click");
	expect(click).toBeDefined();
	expect(
		click!.inputSchema.safeParse({
			generation: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			arguments: { uid: "1" },
		}).success,
	).toBe(true);
	expect(
		click!.inputSchema.safeParse({
			generation: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			arguments: { uid: "1", filePath: "/etc/passwd" },
		}).success,
	).toBe(false);
	expect(getLeadCapability("browser.upload_file")).toBeUndefined();
	expect(getLeadCapability("browser.evaluate_script")?.classification).toBe(
		"write",
	);
	expect(getLeadCapability("browser.list_pages")?.classification).toBe("read");
});

it("defines exact Bridge read resource contracts without cross-resource fields", () => {
	const definition = getLeadCapability("bridge.read")!;
	expect(definition).toBeDefined();
	expect(
		definition.inputSchema.safeParse({ request: { resource: "health" } })
			.success,
	).toBe(true);
	expect(
		definition.inputSchema.safeParse({
			request: { resource: "health", executionId: "foreign" },
		}).success,
	).toBe(false);
	expect(
		definition.inputSchema.safeParse({
			request: { resource: "session.status" },
		}).success,
	).toBe(false);
	expect(
		definition.inputSchema.safeParse({
			request: { resource: "sessions.list", cursor: "http://evil" },
		}).success,
	).toBe(false);
	expect(
		definition.inputSchema.safeParse({
			request: { resource: "diagnostic", executionId: "run" },
		}).success,
	).toBe(false);
	expect(
		definition.outputSchema.safeParse({
			result: { resource: "health", status: "ready", apiToken: "secret" },
			receiptId: "r",
			observedAt: new Date().toISOString(),
		}).success,
	).toBe(false);
});

it("retains all six runner actions as concrete scoped v2 operations", () => {
	const names = [
		"start_runner",
		"list_runners",
		"get_runner_status",
		"read_runner_tmux",
		"send_runner",
		"respond_runner",
	];
	for (const name of names) {
		const op = getLeadCapability(name);
		expect(op?.parityId).toBe("P01");
		expect(op?.credentialConsumer).toBe("bridge");
	}
	expect(
		getLeadCapability("start_runner")!.inputSchema.safeParse({
			issueId: "FLY-1",
			taskCategory: "engineering",
			idempotencyKey: "business-key",
		}).success,
	).toBe(true);
	expect(
		getLeadCapability("respond_runner")!.inputSchema.safeParse({
			questionId: "123e4567-e89b-42d3-a456-426614174000",
			answer: "yes",
			checkpoint: "approve_to_ship",
		}).success,
	).toBe(false);
});

it("admits only one terminal submission", () => {
	const schema = getLeadCapability("terminal.input")!.inputSchema;
	const input = {
		executionId: "exec",
		expectedSessionId: "$1:%2",
		text: "yes",
	};
	expect(schema.safeParse(input).success).toBe(true);
	for (const text of ["1\r/exit", "1\r/quit", "first\nsecond"])
		expect(schema.safeParse({ ...input, text }).success).toBe(false);
});
