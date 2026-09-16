import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it } from "vitest";
import { createLeadConfigRouter } from "../bridge/lead-config-routes.js";
import { LeadConfigError } from "../bridge/lead-config-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
	let calls = 0;
	const app = express();
	app.use(
		"/api/lead-config",
		createLeadConfigRouter({
			stage: async (input) => {
				calls++;
				if ((input as { invalid?: boolean }).invalid)
					throw new LeadConfigError("invalid_request", 400);
				return { stage: true };
			},
			apply: async () => {
				calls++;
				return { effectiveStatus: "pending_runtime" };
			},
			status: async (id) => {
				calls++;
				return { operationId: id };
			},
		}),
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (body: unknown, origin = base) =>
		fetch(`${base}/api/lead-config/stage`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { base, post, calls: () => calls };
}
it("authenticates before staging or disclosing durable operation status", async () => {
	const f = await fixture();
	expect((await f.post({}, "https://evil.example")).status).toBe(403);
	expect((await fetch(`${f.base}/api/lead-config/operations/op`)).status).toBe(
		403,
	);
	expect(f.calls()).toBe(0);
	expect((await f.post({})).status).toBe(200);
	expect(
		(
			await fetch(`${f.base}/api/lead-config/operations/op`, {
				headers: { origin: f.base },
			})
		).status,
	).toBe(200);
	expect(f.calls()).toBe(2);
});
it("limits request bodies and returns structured service errors", async () => {
	const f = await fixture();
	expect((await f.post({ payload: "x".repeat(17000) })).status).toBe(413);
	expect(f.calls()).toBe(0);
	const rejected = await f.post({ invalid: true });
	expect(rejected.status).toBe(400);
	expect(await rejected.json()).toEqual({
		ok: false,
		reason: "invalid_request",
	});
});
