import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewRulingHandler } from "../review-ruling-route.js";

describe("POST /review-rulings", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (!server) return;
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	});

	async function post(
		current:
			| {
					reviewRuling: (body: Record<string, unknown>) => Promise<unknown>;
			  }
			| undefined,
		body: unknown,
	) {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		const app = express();
		app.use(express.json());
		app.post("/review-rulings", createReviewRulingHandler({ current }));
		server = createServer(app);
		await new Promise<void>((resolve) =>
			server?.listen(0, "127.0.0.1", () => resolve()),
		);
		const port = (server.address() as AddressInfo).port;
		const response = await fetch(`http://127.0.0.1:${port}/review-rulings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	}

	it("fails closed until the late-bound coordinator is ready", async () => {
		expect(await post(undefined, {})).toEqual({
			status: 503,
			body: { accepted: false, reason: "review coordinator not ready" },
		});
	});

	it("passes the body through and preserves supervised status codes", async () => {
		const reviewRuling = vi
			.fn()
			.mockResolvedValueOnce({
				accepted: true,
				httpStatus: 201,
				ruling: { ruling_id: "r1" },
			})
			.mockResolvedValueOnce({
				accepted: false,
				httpStatus: 409,
				reason: "conflict",
			});
		const holder = { current: { reviewRuling } };
		const created = await post(holder.current, { issue: "FLY-1251" });
		expect(created).toMatchObject({
			status: 201,
			body: { accepted: true, ruling: { ruling_id: "r1" } },
		});
		expect(reviewRuling).toHaveBeenCalledWith({ issue: "FLY-1251" });
		const conflict = await post(holder.current, {});
		expect(conflict).toMatchObject({
			status: 409,
			body: { accepted: false, reason: "conflict" },
		});
	});

	it("contains coordinator failures as a generic 500", async () => {
		const reviewRuling = vi.fn(async () => {
			throw new Error("secret database path");
		});
		expect(await post({ reviewRuling }, {})).toEqual({
			status: 500,
			body: { accepted: false, reason: "internal error" },
		});
	});
});
