import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import * as leadLease from "flywheel-comm/lead-lease";
import { afterEach, expect, it, vi } from "vitest";
import { createStandingAuthorityConfirmationRouter } from "./standing-authority-confirmation-route.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

it("authenticates the fixed independent Lead and never accepts a caller actor", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly2654-confirm-route-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-20T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "flywheel",
				projectRoot: home,
				generalChannel: "11111111111111111",
				leads: [
					{
						agentId: "flywheel-cos-lead",
						summaryRole: "aggregator",
						chatChannel: "11111111111111111",
						match: { labels: ["CoS"] },
						role: "cos",
						backend: "codex-app-server",
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "flywheel",
		leadId: "flywheel-cos-lead",
		homeDir: home,
	});
	vi.spyOn(leadLease, "validateLeadCarrierAuthorization").mockReturnValue({
		valid: true,
		disposition: "carrier_passthrough",
		leadKey: identity.leadKey,
		carrier: {
			leadKey: identity.leadKey,
			backend: identity.backend,
			identityDigest: identity.identityDigest,
			pid: process.pid,
			lstart: "fixture",
			instanceDigest: "a".repeat(64),
		},
	});
	const confirm = vi.fn().mockResolvedValue({
		status: "active",
		receiptId: "b".repeat(64),
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/confirm",
		createStandingAuthorityConfirmationRouter({
			apiToken: "SECRET",
			homeDir: home,
			projectsPath,
			confirm,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/confirm`;
	const body = {
		schemaVersion: 1,
		projectName: "flywheel",
		identityDigest: identity.identityDigest,
		carrierClaim: "carrier-claim",
		entryId: "raya-carrier-follow-main/v1",
		revision: 1,
		pendingManifestDigest: "c".repeat(64),
	};
	const post = (value: unknown, token = "SECRET") =>
		fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(value),
		});
	try {
		expect((await post(body, "wrong")).status).toBe(401);
		expect((await post({ ...body, actor: "flywheel-cos-lead" })).status).toBe(
			400,
		);
		expect(await (await post(body)).json()).toMatchObject({ status: "active" });
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				authenticatedIdentity: identity,
				entryId: body.entryId,
				// The authoritative ledger row records who confirmed through
				// which carrier claim; the route forwards the validated values.
				authenticatedIdentityDigest: identity.identityDigest,
				carrierClaim: "carrier-claim",
			}),
		);
		expect(
			(await post({ ...body, identityDigest: "f".repeat(64) })).status,
		).toBe(403);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
