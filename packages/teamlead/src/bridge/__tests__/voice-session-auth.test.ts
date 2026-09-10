import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { apiAuthWithRunnerTierDelegation } from "../plugin.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";

const MASTER = "master-token";
const INGEST = "ingest-token";
let server: Server | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => resolve());
			server = undefined;
		}),
);

async function start(master?: string, ingest?: string): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use("/api", apiAuthWithRunnerTierDelegation(master));
	app.use(
		"/api/voice/sessions",
		voiceSessionAuthMiddleware(master, ingest),
		(req, res) =>
			res.json({ tier: res.locals.voiceCredentialTier, path: req.path }),
	);
	app.post("/api/voice/context", (_req, res) => res.json({ old: true }));
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(base: string, path: string, token?: string) {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	return { status: response.status, body: await response.json() };
}

describe("voice session auth", () => {
	it("fails closed without a master token", async () => {
		const base = await start(undefined, INGEST);
		expect(await request(base, "/api/voice/sessions", INGEST)).toEqual({
			status: 503,
			body: { error: "voice_unavailable", reason: "master_token_unset" },
		});
	});

	it("accepts master and ingest credentials with an explicit tier", async () => {
		const base = await start(MASTER, INGEST);
		expect(await request(base, "/api/voice/sessions", MASTER)).toEqual({
			status: 200,
			body: { tier: "master", path: "/" },
		});
		expect(await request(base, "/api/voice/sessions", INGEST)).toEqual({
			status: 200,
			body: { tier: "ingest", path: "/" },
		});
		expect((await request(base, "/api/voice/sessions", "bad")).status).toBe(
			401,
		);
	});

	it("delegates only the new sessions prefix and leaves old voice auth unchanged", async () => {
		const base = await start(MASTER, INGEST);
		expect(
			(await request(base, "/api/voice/sessions/s-1/claim", INGEST)).status,
		).toBe(200);
		expect((await request(base, "/api/voice/context", INGEST)).status).toBe(
			401,
		);
	});
});
