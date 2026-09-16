import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestLeadOperation } from "../lead-operation-client.js";

const request = {
	schemaVersion: 1 as const,
	operationId: "discord.thread.read",
	requestId: "123e4567-e89b-42d3-a456-426614174000",
	input: { threadId: "123" },
};
const dirs: string[] = [],
	servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
async function fixture(reply: (body: string) => string | null) {
	const dir = mkdtempSync("/tmp/lead-client-");
	dirs.push(dir);
	const path = join(dir, "s");
	let calls = 0;
	const server = createServer((socket) => {
		calls++;
		let body = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			body += chunk;
			if (!body.includes("\n")) return;
			const result = reply(body);
			if (result === null) socket.destroy();
			else socket.end(result);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return { path, calls: () => calls };
}
describe("result-only Lead broker client", () => {
	it("sends the same exact request key and validates the correlated result", async () => {
		const endpoint = await fixture((body) => {
			expect(JSON.parse(body)).toEqual(request);
			return `${JSON.stringify({
				requestId: request.requestId,
				status: "succeeded",
				resourceRefs: [],
				data: { messages: [] },
			})}\n`;
		});
		expect((await requestLeadOperation(endpoint.path, request)).status).toBe(
			"succeeded",
		);
		expect(endpoint.calls()).toBe(1);
	});
	it("never retries a lost response, and reports a stable error without raw body", async () => {
		const endpoint = await fixture(() => null);
		await expect(requestLeadOperation(endpoint.path, request)).rejects.toThrow(
			"broker_response_incomplete",
		);
		expect(endpoint.calls()).toBe(1);
	});
	it("rejects wrong correlation, extra protocol fields and oversized responses", async () => {
		for (const result of [
			{ requestId: "foreign", status: "succeeded", resourceRefs: [] },
			{
				requestId: request.requestId,
				status: "succeeded",
				resourceRefs: [],
				token: "SECRET",
			},
			{
				requestId: request.requestId,
				status: "succeeded",
				resourceRefs: [],
				data: "x".repeat(262144),
			},
		]) {
			const endpoint = await fixture(() => `${JSON.stringify(result)}\n`);
			await expect(
				requestLeadOperation(endpoint.path, request),
			).rejects.toThrow(/^broker_response_/);
		}
	});
	it("rejects invalid or oversized requests before connecting", async () => {
		const endpoint = await fixture(() => null);
		await expect(
			requestLeadOperation(endpoint.path, {
				...request,
				token: "SECRET",
			} as typeof request),
		).rejects.toThrow("broker_request_invalid");
		await expect(
			requestLeadOperation(endpoint.path, {
				...request,
				input: "x".repeat(65536),
			}),
		).rejects.toThrow("broker_request_too_large");
		expect(endpoint.calls()).toBe(0);
	});
});

it("correlates only explicit pre-dispatch socket rejections", async () => {
	const endpoint = await fixture(
		() =>
			`${JSON.stringify({ requestId: null, status: "rejected", resourceRefs: [], errorCode: "request_too_large" })}\n`,
	);
	expect(await requestLeadOperation(endpoint.path, request)).toEqual({
		requestId: request.requestId,
		status: "rejected",
		resourceRefs: [],
		errorCode: "request_too_large",
	});
	for (const extra of [
		{ status: "unknown" },
		{ errorCode: "broker_dispatch_failed" },
		{ data: {} },
		{ resourceRefs: ["side-effect"] },
	]) {
		const invalid = await fixture(
			() =>
				`${JSON.stringify({ requestId: null, status: "rejected", resourceRefs: [], errorCode: "request_too_large", ...extra })}\n`,
		);
		await expect(requestLeadOperation(invalid.path, request)).rejects.toThrow(
			"broker_response_invalid",
		);
	}
});
