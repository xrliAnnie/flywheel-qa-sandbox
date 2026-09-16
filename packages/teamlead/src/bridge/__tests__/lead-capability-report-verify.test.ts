import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createLeadReportVerifyRouter } from "../lead-capability-report-verify.js";
import { ReportRegistry } from "../report-registry.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
async function fixture(fetchImpl: typeof fetch, authorized = true) {
	const root = mkdtempSync(join(tmpdir(), "report-verify-"));
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
		"<html><head></head><body><script>1</script></body></html>",
		undefined,
		registry.hostingBinding(),
	);
	await staged.commit();
	let current = true;
	const authorize = vi.fn(async () => {
		if (!authorized) throw new Error("PRIVATE_CREDENTIAL");
		return {
			report: staged.entry,
			assertCurrent() {
				if (!current) throw new Error("revoked");
			},
		};
	});
	const app = express();
	app.use(express.json());
	app.use(
		createLeadReportVerifyRouter({
			registry,
			authorize,
			fetchImpl,
			lookupPublishReceipt: async () => {
				if (!authorized) throw new Error("PRIVATE_CREDENTIAL");
				return {
					report: staged.entry,
					assertCurrent() {
						if (!current) throw new Error("revoked");
					},
				};
			},
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const body = {
		projectName: "flywheel",
		capability: {
			schemaVersion: 1,
			operationId: "report.verify",
			requestId: randomUUID(),
			leadId: "eng",
			identityDigest: "a".repeat(64),
			carrierClaim: "CLAIM",
			activationId: "activation",
			reportId: staged.entry.token,
		},
	};
	return {
		staged,
		registry,
		body,
		revoke: () => {
			current = false;
		},
		async post(raw: unknown = body, path = "/verify") {
			const response = await fetch(
				`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(raw),
				},
			);
			return { status: response.status, body: await response.json() };
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
it("verifies only the registry URL with bounded credential-free HTTPS and scoped receipt", async () => {
	const fetchImpl = vi.fn(
		async () => new Response(f.staged.html),
	) as typeof fetch;
	const f = await fixture(fetchImpl);
	try {
		const result = await f.post();
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			requestId: f.body.capability.requestId,
			status: "succeeded",
			data: {
				reportId: f.staged.entry.token,
				httpStatus: 200,
				cspValid: true,
				nonceValid: true,
			},
		});
		expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
			`https://${f.registry.vercelProjectName()}.vercel.app/r/${f.staged.entry.token}/`,
		);
		expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]).toMatchObject({
			redirect: "error",
		});
		expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("CLAIM");
	} finally {
		await f.close();
	}
});
it("rejects ownership before network access without exposing provider errors", async () => {
	const fetchImpl = vi.fn() as unknown as typeof fetch;
	const f = await fixture(fetchImpl, false);
	try {
		const result = await f.post();
		expect(result.status).toBe(403);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CREDENTIAL");
	} finally {
		await f.close();
	}
});
it("reports unknown for oversized or revoked reads and never treats malformed CSP as valid", async () => {
	let reply = () => new Response("x".repeat(1024 * 1024 + 1));
	const f = await fixture(vi.fn(async () => reply()) as typeof fetch);
	try {
		expect((await f.post()).body.status).toBe("unknown");
		reply = () =>
			new Response("<html><head></head><body><script>1</script></body></html>");
		expect((await f.post()).body.data).toMatchObject({
			cspValid: false,
			nonceValid: false,
		});
		reply = () => {
			f.revoke();
			return new Response(f.staged.html);
		};
		expect((await f.post()).body.status).toBe("unknown");
	} finally {
		await f.close();
	}
});

it("rejects model URLs and bounds an abort-ignoring hosted fetch", async () => {
	const fetchImpl = vi.fn(
		() => new Promise<Response>(() => {}),
	) as typeof fetch;
	const f = await fixture(fetchImpl);
	try {
		const invalid = await f.post({
			...f.body,
			url: "https://evil.test",
		} as typeof f.body);
		expect(invalid.status).toBe(403);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await f.post()).body.status).toBe("unknown");
		expect(fetchImpl).toHaveBeenCalledOnce();
	} finally {
		await f.close();
	}
}, 20000);

it("returns a committed publish receipt without fetching or publishing", async () => {
	const fetchImpl = vi.fn() as unknown as typeof fetch;
	const f = await fixture(fetchImpl);
	try {
		const { reportId: _reportId, ...proof } = f.body.capability;
		const result = await f.post(
			{
				projectName: "flywheel",
				capability: {
					...proof,
					operationId: "report.publish",
					issueId: "FLY-2519",
				},
			},
			"/publish-receipt",
		);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			requestId: f.body.capability.requestId,
			reportId: f.staged.entry.token,
			url: expect.stringContaining(f.staged.entry.token),
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
