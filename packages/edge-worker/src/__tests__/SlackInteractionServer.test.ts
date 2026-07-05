import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackAction } from "../SlackInteractionServer.js";
import { SlackInteractionServer } from "../SlackInteractionServer.js";

function buildPayload(overrides?: Record<string, unknown>): string {
	const payload = {
		type: "block_actions",
		user: { id: "U12345" },
		actions: [
			{
				action_id: "flywheel_approve_issue-123",
				value: JSON.stringify({ issueId: "issue-123", action: "approve" }),
			},
		],
		response_url: "https://hooks.slack.com/actions/T12345/respond",
		message: { ts: "1704110400.000100" },
		...overrides,
	};
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

async function postInteraction(
	port: number,
	body: string,
): Promise<{ status: number; text: string }> {
	const res = await fetch(`http://127.0.0.1:${port}/slack/interaction`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	return { status: res.status, text: await res.text() };
}

describe("SlackInteractionServer", () => {
	let server: SlackInteractionServer;

	beforeEach(() => {
		server = new SlackInteractionServer();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("start() returns port > 0", async () => {
		const port = await server.start();
		expect(port).toBeGreaterThan(0);
		expect(server.getPort()).toBe(port);
	});

	it("POST valid interaction payload → 200", async () => {
		const port = await server.start();
		const res = await postInteraction(port, buildPayload());
		expect(res.status).toBe(200);
	});

	it("POST emits action event with parsed SlackAction", async () => {
		const port = await server.start();

		const actionPromise = new Promise<SlackAction>((resolve) => {
			server.on("action", resolve);
		});

		await postInteraction(port, buildPayload());
		const action = await actionPromise;

		expect(action.actionId).toBe("flywheel_approve_issue-123");
		expect(action.issueId).toBe("issue-123");
		expect(action.action).toBe("approve");
		expect(action.userId).toBe("U12345");
		expect(action.responseUrl).toBe(
			"https://hooks.slack.com/actions/T12345/respond",
		);
		expect(action.messageTs).toBe("1704110400.000100");
	});

	it("POST missing payload → 400", async () => {
		const port = await server.start();
		const res = await postInteraction(port, "");
		expect(res.status).toBe(400);
	});

	it("POST with unknown action_id prefix → ignored (200)", async () => {
		const port = await server.start();

		let emitted = false;
		server.on("action", () => {
			emitted = true;
		});

		const payload = buildPayload({
			actions: [{ action_id: "other_app_button", value: "{}" }],
		});
		const res = await postInteraction(port, payload);

		expect(res.status).toBe(200);
		// Give event loop a tick to ensure no event was emitted
		await new Promise((r) => setTimeout(r, 10));
		expect(emitted).toBe(false);
	});

	it("waitForAction resolves on matching issueId", async () => {
		const port = await server.start();

		const waitPromise = server.waitForAction("issue-123", 5000);

		// Small delay to ensure listener is registered
		await new Promise((r) => setTimeout(r, 10));
		await postInteraction(port, buildPayload());

		const action = await waitPromise;
		expect(action).not.toBeNull();
		expect(action!.issueId).toBe("issue-123");
		expect(action!.action).toBe("approve");
	});

	it("waitForAction returns null on timeout", async () => {
		await server.start();
		const action = await server.waitForAction("nonexistent", 50);
		expect(action).toBeNull();
	});

	it("stop() shuts down gracefully", async () => {
		const port = await server.start();
		await server.stop();

		// Server should no longer accept connections
		await expect(
			fetch(`http://127.0.0.1:${port}/slack/interaction`),
		).rejects.toThrow();
	});
});
