import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it, vi } from "vitest";
import { epicShapeSnapshot } from "../../epic-page/__tests__/fixtures/epic-shape.js";
import { StateStore } from "../../StateStore.js";
import { masterOnlyAuthMiddleware } from "../dependency-route.js";
import {
	createLeadNoteRouter,
	type LeadNoteRouterDeps,
} from "../lead-note-route.js";
import { EpicSnapshotTruncatedError } from "../linear-epic-query.js";
import type { LinearIssue } from "../linear-query.js";

async function fixture(
	overrides: Partial<LeadNoteRouterDeps> = {},
	master: string | undefined = "master",
) {
	const store = await StateStore.create(":memory:");
	const onEpicChange = vi.fn();
	const app = express();
	app.use(express.json());
	app.use(
		"/api/lead-note",
		masterOnlyAuthMiddleware(master, "scoped"),
		createLeadNoteRouter({
			store,
			projects: [
				{
					projectName: "example",
					projectRoot: "/tmp/example",
					leads: [
						{
							agentId: "engineering-lead",
							summaryRole: "producer",
							chatChannel: "123",
							department: "engineering",
							match: { labels: [] },
						},
					],
					linear: { team: "EXM" },
				},
			],
			linearApiKey: "fixture-key",
			lookup: async () =>
				({
					id: "11111111-1111-4111-8111-111111111111",
					identifier: "EXM-1",
					labels: [],
					project: null,
				}) as LinearIssue,
			now: () => new Date("2026-09-09T12:00:00.000Z"),
			onEpicChange,
			...overrides,
		}),
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead-note`;
	const target = {
		projectName: "example",
		issue: "EXM-1",
		role: "engineering",
	};
	const post = async (command: string, body: unknown) =>
		fetch(`${url}/${command}`, {
			method: "POST",
			headers: {
				authorization: "Bearer master",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	return {
		store,
		onEpicChange,
		url,
		target,
		post,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			store.close();
		},
	};
}

it("sets, reads and clears only the declared role with durable server time and refresh receipts", async () => {
	const { onEpicChange, url, target, post, close } = await fixture();
	try {
		const set = await post("set", { ...target, text: " 验证中 " });
		expect(set.status).toBe(200);
		expect(await set.json()).toMatchObject({
			ok: true,
			command: "set",
			note: {
				text: "验证中",
				role: "engineering",
				written_at: "2026-09-09T12:00:00.000Z",
			},
			refresh: "invoked",
		});
		expect(onEpicChange).toHaveBeenCalledExactlyOnceWith(
			"example",
			"lead_note_changed",
		);
		const show = await fetch(`${url}/show?${new URLSearchParams(target)}`, {
			headers: { authorization: "Bearer master" },
		});
		expect(await show.json()).toMatchObject({
			ok: true,
			notes: [
				{
					text: "验证中",
					role: "engineering",
					written_at: "2026-09-09T12:00:00.000Z",
				},
			],
		});
		expect(onEpicChange).toHaveBeenCalledTimes(1);
		expect(await (await post("clear", target)).json()).toMatchObject({
			changed: true,
			refresh: "invoked",
		});
		expect(await (await post("clear", target)).json()).toMatchObject({
			changed: false,
			refresh: "unchanged",
		});
		expect(onEpicChange).toHaveBeenCalledTimes(2);
	} finally {
		await close();
	}
});

it("fails closed for unauthenticated and scoped callers before lookup", async () => {
	const lookup = vi.fn();
	for (const master of ["master", ""]) {
		const f = await fixture({ lookup }, master);
		try {
			for (const token of ["", "bad", "scoped"]) {
				const response = await fetch(`${f.url}/set`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ ...f.target, text: "判断" }),
				});
				expect(response.status).toBe(
					!master ? 503 : token === "scoped" ? 403 : 401,
				);
			}
			expect(lookup).not.toHaveBeenCalled();
			expect(f.onEpicChange).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	}
});

it("supports exact Unicode departments and rejects missing, invalid and unknown configuration roles", async () => {
	const f = await fixture({
		projects: [
			{
				projectName: "example",
				projectRoot: "/tmp/example",
				linear: { team: "EXM" },
				leads: ["工程 部门", "bad\nrole", "product"].map((department) => ({
					department,
					agentId: "fixture-lead",
					summaryRole: "producer",
					chatChannel: "123",
					match: { labels: [] },
				})),
			},
		],
	});
	try {
		for (const role of [
			"Engineering",
			"工程 Lead",
			"fixture-lead",
			"工程 部门 ",
		]) {
			expect(
				(await f.post("set", { ...f.target, role, text: "判断" })).status,
			).toBe(400);
		}
		const invalid = await f.post("set", {
			...f.target,
			role: "bad\nrole",
			text: "判断",
		});
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toEqual({
			ok: false,
			error: "role_configuration_invalid",
		});
		expect(
			(
				await f.post("set", {
					...f.target,
					role: "工程 部门",
					text: "😀".repeat(280),
				})
			).status,
		).toBe(200);
		expect(
			(await f.post("set", { ...f.target, role: "product", text: "e\u0301" }))
				.status,
		).toBe(200);
		expect(
			f.store
				.getLeadNotes("example", ["11111111-1111-4111-8111-111111111111"])
				.map((note) => note.text),
		).toEqual(["é", "😀".repeat(280)]);
	} finally {
		await f.close();
	}
});

it("does not scan directly bound issues; reports upstream and storage errors without writes or refresh", async () => {
	const fetchSnapshot = vi.fn();
	const f = await fixture({ fetchSnapshot });
	try {
		expect((await f.post("set", { ...f.target, text: "判断" })).status).toBe(
			200,
		);
		expect(fetchSnapshot).not.toHaveBeenCalled();
		vi.spyOn(f.store, "setLeadNote").mockImplementationOnce(() => {
			throw new Error("private details");
		});
		const error = await f.post("set", { ...f.target, text: "不能写" });
		expect(error.status).toBe(500);
		expect(await error.json()).toEqual({ ok: false, error: "store_error" });
		expect(f.onEpicChange).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
	const broken = await fixture({
		lookup: async () => {
			throw new Error("private upstream");
		},
	});
	try {
		const error = await broken.post("set", {
			...broken.target,
			text: "不能写",
		});
		expect(error.status).toBe(502);
		expect(await error.json()).toEqual({
			ok: false,
			error: "linear_unavailable",
		});
		expect(broken.onEpicChange).not.toHaveBeenCalled();
	} finally {
		await broken.close();
	}
});

it("reports refresh exceptions separately from a successful durable write", async () => {
	const f = await fixture({
		onEpicChange: () => {
			throw new Error("fixture");
		},
	});
	try {
		expect(
			await (await f.post("set", { ...f.target, text: "已写入" })).json(),
		).toMatchObject({ ok: true, refresh: "unavailable" });
		expect(
			f.store.getLeadNotes("example", [
				"11111111-1111-4111-8111-111111111111",
			])[0]?.text,
		).toBe("已写入");
	} finally {
		await f.close();
	}
});

it("rejects malformed input before lookup and SQL, including hidden identity and time fields", async () => {
	const lookup = vi.fn();
	const f = await fixture({ lookup });
	try {
		for (const body of [
			null,
			[],
			{ ...f.target, text: "ok", author: "forbidden" },
			{ ...f.target, text: "ok", written_at: "2026-09-09" },
			{ ...f.target, role: 2, text: "ok" },
			{ ...f.target, text: "" },
			{ ...f.target, text: "x".repeat(281) },
			{ ...f.target, text: "a\nb" },
			{ ...f.target, text: "a\u0085b" },
			{ ...f.target, text: "a\u2028b" },
			{
				...f.target,
				issue: "11111111-1111-4111-8111-111111111111",
				text: "ok",
			},
		]) {
			expect((await f.post("set", body)).status).toBe(400);
		}
		expect(
			(await f.post("clear", { ...f.target, text: "not allowed" })).status,
		).toBe(400);
		expect(
			(
				await fetch(
					`${f.url}/show?projectName=example&issue=EXM-1&issue=EXM-2`,
					{ headers: { authorization: "Bearer master" } },
				)
			).status,
		).toBe(400);
		expect(lookup).not.toHaveBeenCalled();
		expect(f.onEpicChange).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});

it("requires configured exact roles, but permits offline UUID cleanup after binding and role removal", async () => {
	const lookup = vi.fn();
	const f = await fixture({
		lookup,
		projects: [
			{ projectName: "example", projectRoot: "/tmp/example", leads: [] },
		],
	});
	const uuid = "11111111-1111-4111-8111-111111111111";
	try {
		f.store.setLeadNote({
			projectName: "example",
			issueUuid: uuid,
			role: "旧部门",
			text: "旧判断",
			writtenAt: "2026-09-09T12:00:00.000Z",
		});
		const show = await fetch(
			`${f.url}/show?projectName=example&issue=${uuid}`,
			{ headers: { authorization: "Bearer master" } },
		);
		expect(await show.json()).toMatchObject({
			ok: true,
			notes: [{ role: "旧部门", text: "旧判断" }],
		});
		expect(
			await (
				await f.post("clear", { ...f.target, issue: uuid, role: "旧部门" })
			).json(),
		).toMatchObject({ ok: true, changed: true });
		expect(lookup).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});

it("accepts a bound-root descendant despite different team and missing labels, refusing unavailable proof", async () => {
	const snapshot = epicShapeSnapshot();
	const lookup = vi.fn(
		async () =>
			({
				id: snapshot.descendantIds[0],
				identifier: "OTHER-1",
				labels: [],
				project: null,
			}) as LinearIssue,
	);
	const fetchSnapshot = vi.fn(async () => snapshot);
	const f = await fixture({ lookup, fetchSnapshot });
	try {
		expect((await f.post("set", { ...f.target, text: "子树内" })).status).toBe(
			200,
		);
		fetchSnapshot.mockRejectedValueOnce(
			new EpicSnapshotTruncatedError("fixture"),
		);
		const unavailable = await f.post("set", { ...f.target, text: "不能写" });
		expect(unavailable.status).toBe(422);
		expect(await unavailable.json()).toEqual({
			ok: false,
			error: "scope_membership_unavailable",
		});
		lookup.mockResolvedValueOnce({
			id: "foreign",
			identifier: "OTHER-1",
			labels: [],
			project: null,
		} as LinearIssue);
		expect((await f.post("set", { ...f.target, text: "不能写" })).status).toBe(
			403,
		);
		expect(f.onEpicChange).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
});
