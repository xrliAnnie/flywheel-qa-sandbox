import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBridgeApp } from "../plugin.js";
import { RunnerAdmissionController } from "../runner-admission.js";

it("validates subjects, persists verdicts, and restricts intent resolution to the master token", async () => {
	const root = mkdtempSync(join(tmpdir(), "readiness-routes-"));
	const store = await StateStore.create(":memory:");
	const subject = { sourceCommit: "a".repeat(40), baseVersion: "1.56.0" };
	mkdirSync(join(root, "doc"));
	writeFileSync(join(root, "doc", "VERSION"), subject.baseVersion);
	vi.stubEnv("FLYWHEEL_BRIDGE_SOURCE_MODE", "1");
	vi.stubEnv("FLYWHEEL_BRIDGE_SOURCE_SHA", subject.sourceCommit);
	vi.stubEnv("FLYWHEEL_REPO_ROOT", root);
	vi.stubEnv("FLYWHEEL_STATE_DIR", root);
	vi.stubEnv("FLYWHEEL_DEPLOYED_SHA_FILE", join(root, "absent-sha"));
	mkdirSync(join(root, "state", "release-readiness", "gaps"), {
		recursive: true,
	});
	writeFileSync(
		join(root, "state", "release-readiness", "gaps", "pending.intent.json"),
		"{}",
	);
	const app = createBridgeApp(store, [], {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "fixture",
		defaultLeadAgentId: "fixture",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		apiToken: "master",
		geminiAgentToken: "scoped",
	});
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const request = (path: string, token = "master", body?: unknown) =>
		fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/release-readiness${path}`,
			{
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"X-Actor": "forged",
				},
				body: body ? JSON.stringify(body) : undefined,
			},
		);
	try {
		expect((await request("/verdict", "bad")).status).toBe(401);
		expect((await request("/verdict?commit=main")).status).toBe(400);
		const verdict = await (await request("/verdict")).json();
		expect(verdict.state).toBe("unknown");
		expect(verdict.evidence.outbox.gapsPending).toBe(1);
		expect(
			verdict.reasons.map((reason: { code: string }) => reason.code),
		).toContain("outbox_pending");
		const report = await request("/report/render", "master", {
			day: "2026-09-11",
		});
		expect(report.status).toBe(200);
		expect(report.headers.get("x-readiness-commit")).toBe(subject.sourceCommit);
		expect(report.headers.get("x-readiness-version")).toBe(subject.baseVersion);
		expect(report.headers.get("content-type")).toContain("text/html");
		expect(await report.text()).toContain("发布就绪日报");
		expect(
			(await request("/report/render", "master", { day: "2026-02-31" })).status,
		).toBe(400);
		const bug = await request("/bug-report", "master", {
			issueIdentifier: "FLY-123",
			...subject,
		});
		expect(bug.status).toBe(201);
		const saved = await bug.json();
		const replay = await request("/bug-report", "master", {
			issueIdentifier: "FLY-123",
			sourceCommit: "b".repeat(40),
			baseVersion: "1.57.0",
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(saved);
		expect(
			(
				await request("/bug-report", "master", {
					issueIdentifier: "FLY-124",
					sourceCommit: "main",
				})
			).status,
		).toBe(400);
		expect(
			store
				.getReleaseReadinessVerdicts(subject.sourceCommit)
				.some((record) => record.verdictId === verdict.verdictId),
		).toBe(true);
		expect(
			(await request(`/verdicts?commit=${subject.sourceCommit}&limit=0`))
				.status,
		).toBe(400);
		store.insertReleaseBugIntent({
			intentId: "intent-test",
			...subject,
			reporter: null,
			createdAt: new Date().toISOString(),
		});
		expect(
			(
				await request("/bug-intent/intent-test/resolve", "scoped", {
					issueIdentifier: "FLY-2390",
				})
			).status,
		).toBe(403);
		expect(
			(
				await request("/bug-intent/intent-test/resolve", "master", {
					abandon: true,
					reason: " ",
				})
			).status,
		).toBe(400);
		const receipt = await (
			await request("/bug-intent/intent-test/resolve", "master", {
				issueIdentifier: "FLY-2390",
			})
		).json();
		expect(receipt).toMatchObject({
			status: "finalized",
			resolvedBy: "master-api-token",
		});
		expect(
			await (
				await request("/bug-intent/intent-test/resolve", "master", {
					abandon: true,
					reason: "later",
				})
			).json(),
		).toEqual(receipt);
		expect(
			(
				await request("/bug-intent/missing/resolve", "master", {
					issueIdentifier: "FLY-2390",
				})
			).status,
		).toBe(404);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		vi.unstubAllEnvs();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
