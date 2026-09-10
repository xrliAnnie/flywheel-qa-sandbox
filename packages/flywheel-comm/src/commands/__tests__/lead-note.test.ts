import { expect, it, vi } from "vitest";
import { runLeadNote } from "../lead-note.js";

it("sends exactly one set request and prints a single JSON receipt", async () => {
	const receipt = {
		ok: true,
		command: "set",
		project: "example",
		issue: "EXM-1",
		issue_uuid: "11111111-1111-4111-8111-111111111111",
		note: {
			text: "判断",
			role: "engineering",
			written_at: "2026-09-09T12:00:00.000Z",
		},
		refresh: "invoked",
	};
	const fetchFn = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => receipt,
	}));
	const log = vi.fn();
	expect(
		await runLeadNote(
			["set", "--issue", "EXM-1", "--role", "engineering", "--text", "判断"],
			{
				env: {
					FLYWHEEL_PROJECT_NAME: "example",
					TEAMLEAD_API_TOKEN: "fixture-token",
				},
				fetchFn,
				log,
			},
		),
	).toBe(0);
	expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
		"http://localhost:9876/api/lead-note/set",
		{
			method: "POST",
			headers: {
				Authorization: "Bearer fixture-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				projectName: "example",
				issue: "EXM-1",
				role: "engineering",
				text: "判断",
			}),
		},
	);
	expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt));
});

const env = {
	FLYWHEEL_PROJECT_NAME: "example",
	TEAMLEAD_API_TOKEN: "fixture-token",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1234/",
};
const target = ["--issue", "EXM-1", "--role", "engineering"];

it.each([
	["unknown"],
	["set", ...target],
	["set", ...target, "--text", "ok", "--role", "product"],
	["show", ...target, "--text", "no"],
	["clear", "--issue", "EXM-1"],
	["clear", ...target, "--text", "no"],
	["show", ...target, "positional"],
	["set", ...target, "--text", "ok", "--actor", "forbidden"],
])("rejects arguments without a request: %j", async (...args: string[]) => {
	const fetchFn = vi.fn();
	const log = vi.fn();
	const errorLog = vi.fn();
	expect(await runLeadNote(args, { env, fetchFn, log, errorLog })).toBe(1);
	expect(fetchFn).not.toHaveBeenCalled();
	expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
		ok: false,
		error: "invalid_arguments",
	});
	expect(errorLog).toHaveBeenCalledTimes(1);
});

it("uses GET for show, encodes role exactly and never invokes generation", async () => {
	const receipt = {
		ok: true,
		command: "show",
		project: "example",
		issue: "EXM-1",
		issue_uuid: "11111111-1111-4111-8111-111111111111",
		notes: [],
	};
	const fetchFn = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => receipt,
	}));
	expect(
		await runLeadNote(["show", "--issue", "EXM-1", "--role", "工程 部门"], {
			env,
			fetchFn,
			log: vi.fn(),
		}),
	).toBe(0);
	const [url, init] = fetchFn.mock.calls[0]! as unknown as [
		string,
		{ method: string; body?: string },
	];
	expect(new URL(url).pathname).toBe("/api/lead-note/show");
	expect(new URL(url).searchParams.get("role")).toBe("工程 部门");
	expect(init.method).toBe("GET");
	expect(init.body).toBeUndefined();
	expect(fetchFn).toHaveBeenCalledTimes(1);
});

it.each([
	null,
	{ ok: true },
	{
		ok: true,
		command: "set",
		project: "example",
		issue: "EXM-1",
		issue_uuid: "id",
		note: { text: 4 },
		refresh: "invoked",
	},
])("refuses malformed success %j without echoing it", async (receipt) => {
	const fetchFn = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => receipt,
	}));
	const log = vi.fn();
	const errorLog = vi.fn();
	expect(
		await runLeadNote(["set", ...target, "--text", "ok"], {
			env,
			fetchFn,
			log,
			errorLog,
		}),
	).toBe(1);
	expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
		ok: false,
		error: "invalid_response",
	});
	expect(errorLog.mock.calls[0]![0]).toContain("show");
});

it("does not retry uncertain writes or expose request/token/upstream details", async () => {
	const fetchFn = vi.fn(async () => {
		throw new Error("fixture-token private request");
	});
	const log = vi.fn();
	const errorLog = vi.fn();
	expect(
		await runLeadNote(["set", ...target, "--text", "private request"], {
			env,
			fetchFn,
			log,
			errorLog,
		}),
	).toBe(1);
	expect(fetchFn).toHaveBeenCalledTimes(1);
	expect(
		log.mock.calls.flat().join(" ") + errorLog.mock.calls.flat().join(" "),
	).not.toMatch(/fixture-token|private request/);
	expect(errorLog.mock.calls[0]![0]).toContain("show");
});
