import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { masterOnlyAuthMiddleware } from "../dependency-route.js";
import { createLeadPersonaRouter } from "../lead-persona-routes.js";

describe("lead persona activation route", () => {
	const close: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const stop of close.splice(0)) await stop();
	});

	async function fixture(master: string | undefined) {
		const readActivation = vi.fn(async () => ({
			kind: "pre-m0" as const,
			contractDigest: "a".repeat(64),
			a0Digest: "b".repeat(64),
			revision: "4",
		}));
		const app = express();
		app.use(
			"/api/lead-persona",
			masterOnlyAuthMiddleware(master, "scoped"),
			createLeadPersonaRouter({ readActivation }),
		);
		const server = createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		close.push(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		return {
			readActivation,
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead-persona/activation`,
		};
	}

	it("returns only the server-derived decision for exact query fields", async () => {
		const f = await fixture("master");
		const response = await fetch(`${f.url}?projectName=raya&leadId=raya`, {
			headers: { authorization: "Bearer master" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: "pre-m0",
			revision: "4",
		});
		expect(f.readActivation).toHaveBeenCalledExactlyOnceWith("raya", "raya");

		const injected = await fetch(
			`${f.url}?projectName=raya&leadId=raya&phase=ready`,
			{
				headers: { authorization: "Bearer master" },
			},
		);
		expect(injected.status).toBe(400);
		expect(f.readActivation).toHaveBeenCalledTimes(1);
	});

	it("fails before state reads for missing, wrong, and scoped credentials", async () => {
		for (const master of ["master", undefined]) {
			const f = await fixture(master);
			for (const token of ["", "wrong", "scoped"]) {
				const response = await fetch(`${f.url}?projectName=raya&leadId=raya`, {
					headers: { authorization: `Bearer ${token}` },
				});
				expect(response.status).toBe(
					master === undefined ? 503 : token === "scoped" ? 403 : 401,
				);
			}
			expect(f.readActivation).not.toHaveBeenCalled();
		}
	});
});
