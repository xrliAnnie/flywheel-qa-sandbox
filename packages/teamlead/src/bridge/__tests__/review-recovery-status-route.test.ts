import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBridgeApp } from "../plugin.js";
import { ReviewRequestCoordinator } from "../review-request-coordinator.js";
import { RunnerAdmissionController } from "../runner-admission.js";

it("production status route authenticates, binds the original pending review, and fails closed on missing coordinator/DB", async () => {
	const dir = mkdtempSync(join(tmpdir(), "review-status-http-"));
	const store = await StateStore.create(join(dir, "state.db"));
	const path = join(dir, "comm.db");
	const db = new CommDB(path);
	const holder: { current: ReviewRequestCoordinator | undefined } = {
		current: undefined,
	};
	let unavailable = false;
	const coordinator = new ReviewRequestCoordinator({
		store,
		commDbPathFor: () => path,
		openCommDb: (path) => {
			if (unavailable) throw new Error("missing db");
			return new CommDB(path, false);
		},
	});
	const app = createBridgeApp(
		store,
		[],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath: join(dir, "state.db"),
			apiToken: "api-token",
			ingestToken: "ingest-token",
			notificationChannel: "test",
			defaultLeadAgentId: "test-lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ reviewCoordinator: holder },
	);
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("test listener missing");
	const post = async (body: unknown, token = "ingest-token") => {
		const response = await fetch(
			`http://127.0.0.1:${address.port}/review-requests/status`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(body),
			},
		);
		return { status: response.status, body: await response.json() };
	};
	try {
		expect((await post({}, "wrong")).status).toBeGreaterThanOrEqual(400);
		expect(await post({})).toEqual({
			status: 503,
			body: { status: "pending" },
		});
		store.upsertSession({
			execution_id: "author",
			issue_id: "FLY-test",
			project_name: "p",
			status: "running",
			adapter_type: "codex-tmux",
		});
		db.registerSession("author", "window", "p");
		const q = db.insertQuestion("author", "test-lead", "review", {
			checkpoint: "review_code",
		});
		store.insertCodexReviewJob({
			requestId: "R",
			executionId: "author",
			projectName: "p",
			questionId: q,
			reviewType: "code",
		});
		store.claimCodexReviewJobRunning("R");
		store.retireCodexReviewJob({ requestId: "R", expectedGeneration: 1 });
		holder.current = coordinator;
		expect(await post({ executionId: "author", questionId: q })).toMatchObject({
			status: 200,
			body: {
				status: "pending",
				reviewRetry: {
					requestId: "R",
					questionId: q,
					reviewType: "code",
					reason: "operator_required",
				},
			},
		});
		expect(await post({ executionId: "other", questionId: q })).toEqual({
			status: 200,
			body: { status: "pending" },
		});
		unavailable = true;
		expect(await post({ executionId: "author", questionId: q })).toMatchObject({
			body: { status: "pending" },
		});
		unavailable = false;
		db.insertResponse(q, "test-lead", "final");
		expect(await post({ executionId: "author", questionId: q })).toEqual({
			status: 200,
			body: { status: "pending" },
		});
	} finally {
		coordinator.stop();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
