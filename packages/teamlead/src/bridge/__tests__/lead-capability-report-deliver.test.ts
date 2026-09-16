import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import type { DiscordSendFn } from "../../lead-backends/codex/CodexLeadOutboundHandler.js";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { createLeadReportDeliverRouter } from "../lead-capability-report-deliver.js";
import { ReportRegistry } from "../report-registry.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
async function fixture(uncertain = false) {
	const root = mkdtempSync(join(tmpdir(), "report-deliver-"));
	roots.push(root);
	const registry = new ReportRegistry(root);
	await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			migratedAt: new Date().toISOString(),
			gatewayDeploymentId: "test",
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	const staged = registry.stagePublish(
		"flywheel",
		"<html><head></head><body>Report</body></html>",
		"Report",
		registry.hostingBinding(),
	);
	await staged.commit();
	const db = join(root, "outbound.db");
	let store = new SqliteOutboundDedupStore(db),
		authorized = true;
	const send = vi.fn(async (_input: Parameters<DiscordSendFn>[0]) => {
		if (uncertain) throw new Error("lost response");
		return "12345678901234567";
	});
	const proof = {
		projectName: "flywheel",
		capability: {
			schemaVersion: 1,
			operationId: "report.deliver",
			requestId: randomUUID(),
			leadId: "eng",
			identityDigest: "a".repeat(64),
			carrierClaim: "CLAIM",
			activationId: "a1",
			reportId: staged.entry.token,
			issueId: "FLY-2519",
		},
	};
	let server: Server;
	async function start() {
		const app = express();
		app.use(express.json());
		app.use(
			createLeadReportDeliverRouter({
				registry,
				store,
				apiToken: "TOKEN",
				authorize: async () => {
					if (!authorized) throw new Error("PRIVATE");
					return {
						report: staged.entry,
						assertCurrent() {
							if (!authorized) throw new Error("revoked");
						},
					};
				},
				resolveIssueThread: async () => "22345678901234567",
				authorizeChannel: async () => authorized,
				send,
			}),
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
	}
	await start();
	return {
		send,
		proof,
		revoke() {
			authorized = false;
		},
		async post(path = "/deliver", body = proof) {
			const r = await fetch(
				`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			return { status: r.status, body: await r.json() };
		},
		async restart() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			store = new SqliteOutboundDedupStore(db);
			await start();
		},
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		},
	};
}
it("delivers once and reads the existing durable receipt after a Bridge restart", async () => {
	const f = await fixture();
	try {
		const first = await f.post();
		expect(first.status).toBe(200);
		expect(first.body.data).toMatchObject({
			reportId: f.proof.capability.reportId,
			messageId: "12345678901234567",
			channelId: "22345678901234567",
			delivery: "link-only",
		});
		expect(f.send).toHaveBeenCalledOnce();
		expect(f.send.mock.calls[0]?.[0]).toMatchObject({
			text: expect.stringContaining("/r/"),
		});
		await f.restart();
		expect((await f.post("/delivery-receipt")).body.status).toBe("succeeded");
		expect((await f.post()).body.status).toBe("succeeded");
		expect(f.send).toHaveBeenCalledOnce();
		f.revoke();
		expect((await f.post()).status).toBe(403);
	} finally {
		await f.close();
	}
});
it("leaves uncertain sends unknown across restart, and rejects model URL/channel overrides", async () => {
	const f = await fixture(true);
	try {
		const invalid = await f.post("/deliver", {
			...f.proof,
			url: "https://evil.test",
		} as typeof f.proof);
		expect(invalid.status).toBe(403);
		expect(f.send).not.toHaveBeenCalled();
		expect((await f.post()).body.status).toBe("unknown");
		await f.restart();
		expect((await f.post("/delivery-receipt")).body.status).toBe("unknown");
		expect((await f.post()).body.status).toBe("unknown");
		expect(f.send).toHaveBeenCalledOnce();
	} finally {
		await f.close();
	}
});
