import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createEpicIntakeRouter } from "../epic-intake-route.js";

const at = "2026-09-14T20:00:00.000Z";
const result = {
	outcome: "complete",
	childIssueIds: [],
	firstBatchIssueIds: [],
	ledgerObservedAt: at,
	threadId: "123456789012345678",
	messageId: "223456789012345678",
	founderQuestion: null,
};
async function fixture() {
	const store = await StateStore.create(":memory:");
	const row = store.recordEpicIntake({
		issueUuid: "uuid",
		identifier: "TEST-1",
		startedAt: at,
		intakeAt: at,
		observedAt: at,
		projectName: "test",
		leadId: "lead",
		bindingDigest: "binding",
		sourceSpanIds: ["span"],
		backfill: false,
		active: true,
		hasChildIssues: true,
	})!;
	const observe = vi.fn(async () => ({
		active: true,
		directChildIds: [],
		canonicalThreadId: result.threadId,
		message: {
			id: result.messageId,
			channelId: result.threadId,
			authorId: "bot",
		},
		leadBotUserId: "bot",
		now: at,
		patrolIntervalMs: 60000,
	}));
	const refresh = vi.fn();
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		if (req.headers.authorization === "Bearer master")
			res.locals.reportCredentialTier = "master";
		next();
	});
	app.use(
		"/api/epic-intake",
		createEpicIntakeRouter({
			store,
			ownsLead: (project, lead) => project === "test" && lead === "lead",
			observe,
			now: () => new Date(at),
			onEpicChange: refresh,
		}),
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/epic-intake`;
	return {
		store,
		row,
		observe,
		refresh,
		url,
		post: (body: unknown, token = "master") =>
			fetch(`${url}/resolve`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		},
	};
}
it("requires master access, frozen owner and valid bounded evidence before external reads", async () => {
	const f = await fixture();
	try {
		const body = {
			projectName: "test",
			leadId: "lead",
			eventUid: f.row.eventUid,
			evidence: result,
		};
		expect((await f.post(body, "runner")).status).toBe(403);
		expect((await f.post({ ...body, leadId: "other" })).status).toBe(403);
		expect((await f.post({ ...body, projectName: "other" })).status).toBe(403);
		expect(
			(await f.post({ ...body, evidence: { ...result, extra: true } })).status,
		).toBe(400);
		expect(f.observe).not.toHaveBeenCalled();
		expect((await f.post(body)).status).toBe(200);
		expect((await f.post(body)).status).toBe(200);
		expect(f.observe).toHaveBeenCalledTimes(1);
		expect(f.store.listEpicIntakes("test")[0]?.workState).toBe("complete");
		const shown = await fetch(`${f.url}?projectName=test&leadId=lead`, {
			headers: { authorization: "Bearer master" },
		});
		expect(shown.status).toBe(200);
		expect((await shown.json()).intakes).toHaveLength(1);
	} finally {
		await f.close();
	}
});
it("retains pending when fresh observation fails or message ownership conflicts", async () => {
	const f = await fixture();
	try {
		const body = {
			projectName: "test",
			leadId: "lead",
			eventUid: f.row.eventUid,
			evidence: result,
		};
		f.observe.mockRejectedValueOnce(new Error("unavailable"));
		expect((await f.post(body)).status).toBe(503);
		f.observe.mockResolvedValueOnce({
			...(await f.observe()),
			leadBotUserId: "other",
		});
		expect((await f.post(body)).status).toBe(409);
		expect(f.store.listEpicIntakes("test")[0]?.workState).toBe("pending");
		expect(f.refresh).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
it("keeps needs_founder pending and permits its owner to complete with new evidence", async () => {
	const f = await fixture();
	try {
		const body = {
			projectName: "test",
			leadId: "lead",
			eventUid: f.row.eventUid,
			evidence: {
				...result,
				outcome: "needs_founder",
				founderQuestion: "Which scope?",
			},
		};
		expect((await f.post(body)).status).toBe(200);
		expect(f.store.listEpicIntakes("test")[0]?.workState).toBe("needs_founder");
		expect((await f.post({ ...body, evidence: result })).status).toBe(200);
		expect(f.store.listEpicIntakes("test")[0]?.workState).toBe("complete");
	} finally {
		await f.close();
	}
});
it("rejects current-state changes and oversized evidence without clearing pending", async () => {
	const f = await fixture();
	try {
		const body = {
			projectName: "test",
			leadId: "lead",
			eventUid: f.row.eventUid,
			evidence: result,
		};
		f.store.setEpicIntakeActive(
			f.row.eventUid,
			false,
			"2026-09-14T20:01:00.000Z",
		);
		expect((await f.post(body)).status).toBe(409);
		const huge = {
			...body,
			evidence: {
				...result,
				childIssueIds: Array.from(
					{ length: 500 },
					(_, i) => `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`,
				),
			},
		};
		expect((await f.post(huge)).status).toBe(413);
		expect(f.store.listEpicIntakes("test")[0]?.workState).toBe("pending");
	} finally {
		await f.close();
	}
});

it("FLY-2597: stores a service-issued quiet receipt and replays without re-observing", async () => {
	const f = await fixture();
	try {
		const { threadId: _t, messageId: _m, ...quiet } = result;
		const body = {
			projectName: "test",
			leadId: "lead",
			eventUid: f.row.eventUid,
			evidence: quiet,
		};
		expect(
			(
				await f.post({
					...body,
					evidence: {
						...quiet,
						receipt: {
							kind: "bridge_record",
							leadId: "forged",
							verifiedAt: at,
						},
					},
				})
			).status,
		).toBe(400);
		expect((await f.post(body)).status).toBe(200);
		expect(f.store.listEpicIntakes("test")[0]?.result).toMatchObject({
			receipt: { kind: "bridge_record", leadId: "lead", verifiedAt: at },
		});
		expect((await f.post(body)).status).toBe(200);
		expect(f.observe).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
});
