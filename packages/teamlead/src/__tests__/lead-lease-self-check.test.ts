import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import { hashCarrierInstanceId } from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLeadLeaseSelfCheckRouter } from "../bridge/lead-lease-self-check.js";
import { tokenAuthMiddleware } from "../bridge/plugin.js";

const LEAD_ID = "eng-lead";
const LEAD_KEY = "flywheel-eng-lead";
const RAW_CLAIM = "raw-carrier-capability";
const NOW = Date.parse("2026-07-16T12:00:00.000Z");

describe("FLY-1309 Bridge carrier self-check endpoint", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	let server: Server;
	let identityDigest: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-self-check-route-"));
		mkdirSync(join(dir, ".flywheel"));
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "test",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		env = {
			FLYWHEEL_STATE_DIR: join(dir, "state"),
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "carrier-evidence.json"),
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "must-not-exist.db"),
		};
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE!,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: LEAD_ID,
							backend: "codex-app-server",
							summaryRole: "producer",
						},
					],
				},
			]),
		);
		identityDigest = resolveLeadIdentity({
			projectsPath: env.FLYWHEEL_PROJECTS_FILE!,
			projectName: "flywheel",
			leadId: LEAD_ID,
			homeDir: dir,
		}).identityDigest;
		writeEvidence("matching");
		const app = express();
		app.use(express.json());
		app.use(
			"/api/lead-lease/self-check",
			tokenAuthMiddleware("token"),
			createLeadLeaseSelfCheckRouter({
				env,
				authorizationDeps: {
					now: () => NOW,
					processAliveWithStart: (pid, start) =>
						pid === 777 && start === "carrier-start",
				},
			}),
		);
		server = createServer(app);
		server.listen(0);
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	function writeEvidence(fault: "matching" | "wrong" | "stale"): void {
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: new Date(
					fault === "stale" ? NOW - 91_000 : NOW,
				).toISOString(),
				leads: {
					[LEAD_KEY]: {
						leadKey: LEAD_KEY,
						backend: "codex-app-server",
						identityDigest,
						pid: 777,
						lstart: "carrier-start",
						instanceDigest: hashCarrierInstanceId(
							fault === "wrong" ? "another-capability" : RAW_CLAIM,
						),
					},
				},
			}),
		);
	}

	async function post(input?: {
		token?: string;
		host?: string;
		carrierClaim?: unknown;
	}) {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("not bound");
		if (input?.host) {
			const body = JSON.stringify({
				leadId: LEAD_ID,
				projectName: "flywheel",
				identityDigest,
				carrierClaim: "carrierClaim" in input ? input.carrierClaim : RAW_CLAIM,
			});
			return await new Promise<{
				status: number;
				body: Record<string, unknown>;
			}>((resolve, reject) => {
				const request = httpRequest(
					{
						host: "127.0.0.1",
						port: address.port,
						path: "/api/lead-lease/self-check",
						method: "POST",
						headers: {
							Host: input.host,
							Authorization: `Bearer ${input.token ?? "token"}`,
							"content-type": "application/json",
							"content-length": Buffer.byteLength(body),
						},
					},
					(response) => {
						let raw = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							raw += chunk;
						});
						response.on("end", () => {
							resolve({
								status: response.statusCode ?? 0,
								body: JSON.parse(raw) as Record<string, unknown>,
							});
						});
					},
				);
				request.on("error", reject);
				request.end(body);
			});
		}
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-lease/self-check`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(input?.token === "none"
						? {}
						: { Authorization: `Bearer ${input?.token ?? "token"}` }),
					...(input?.host ? { Host: input.host } : {}),
				},
				body: JSON.stringify({
					leadId: LEAD_ID,
					projectName: "flywheel",
					identityDigest,
					carrierClaim:
						input && "carrierClaim" in input ? input.carrierClaim : RAW_CLAIM,
				}),
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	}

	it("requires the master bearer token", async () => {
		expect((await post({ token: "none" })).status).toBe(401);
		expect((await post({ token: "wrong" })).status).toBe(401);
	});

	it("rejects a non-loopback Host even with a valid token", async () => {
		const result = await post({ host: "localhost.evil" });
		expect(result.status).toBe(403);
		expect(result.body).toMatchObject({ reason: "non_loopback_host" });
	});

	it("returns a secret-free attestation for a matching live carrier", async () => {
		const result = await post();
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			ok: true,
			disposition: "carrier_passthrough",
			leadKey: LEAD_KEY,
			carrier: {
				identityDigest,
				pid: 777,
				lstart: "carrier-start",
				instanceDigest: hashCarrierInstanceId(RAW_CLAIM),
			},
		});
		expect(JSON.stringify(result.body)).not.toContain(RAW_CLAIM);
		expect(existsSync(env.FLYWHEEL_LEAD_LEASE_DB!)).toBe(false);
	});

	it.each([
		["missing", undefined],
		["wrong", RAW_CLAIM],
		["stale", RAW_CLAIM],
	] as const)(
		"rejects a %s carrier without mutating the lease store",
		async (fault, claim) => {
			if (fault === "wrong" || fault === "stale") writeEvidence(fault);
			const result = await post({ carrierClaim: claim });
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({ ok: false });
			expect(JSON.stringify(result.body)).not.toContain(RAW_CLAIM);
			expect(existsSync(env.FLYWHEEL_LEAD_LEASE_DB!)).toBe(false);
		},
	);
});
