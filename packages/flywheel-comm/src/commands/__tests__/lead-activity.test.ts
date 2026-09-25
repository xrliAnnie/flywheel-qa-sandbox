import { describe, expect, it, vi } from "vitest";
import { runLeadActivity } from "../lead-activity.js";

const env = {
	TEAMLEAD_API_TOKEN: "fixture",
	BRIDGE_URL: "http://127.0.0.1:9876",
};
const IDLE = {
	schema: "lead-activity.v1",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
	carrier: "claude-code",
	observedAt: "2026-09-25T20:00:00.000Z",
	source: "claude_pane",
	state: "idle",
};
const UNKNOWN = {
	...IDLE,
	state: "unknown",
	unknown: { reason: "no_turn_status_line", detail: "…" },
};
const FLEET = {
	schema: "lead-activity-fleet.v1",
	observedAt: "2026-09-25T20:00:00.000Z",
	leads: [IDLE, UNKNOWN],
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});

async function run(
	args: string[],
	fetchImpl = vi.fn<typeof fetch>(),
	over = {},
) {
	const log = vi.fn();
	const code = await runLeadActivity(args, {
		env: { ...env, ...over },
		fetchImpl,
		log,
	});
	expect(log).toHaveBeenCalledTimes(1);
	const line = String(log.mock.calls[0]![0]);
	expect(line).not.toContain("\n");
	return { code, out: JSON.parse(line), fetchImpl };
}

describe("flywheel-comm lead-activity", () => {
	it("prints one Lead's activity as one JSON line (unknown is still an answer)", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => json(UNKNOWN));
		const r = await run(
			["--project", "flywheel", "--lead", "flywheel-eng-lead"],
			fetchImpl,
		);
		expect(r.code).toBe(0);
		expect(r.out).toEqual({ ok: true, activity: UNKNOWN });
		const [url, init] = fetchImpl.mock.calls[0]!;
		const parsed = new URL(String(url));
		expect(parsed.pathname).toBe("/api/lead-activity");
		expect([...parsed.searchParams.entries()]).toEqual([
			["projectName", "flywheel"],
			["leadId", "flywheel-eng-lead"],
		]);
		expect(init).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { Authorization: "Bearer fixture" },
		});
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("prints the whole fleet with --all", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => json(FLEET));
		const r = await run(["--all"], fetchImpl);
		expect(r.code).toBe(0);
		expect(r.out).toEqual({ ok: true, fleet: FLEET });
		expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe(
			"/api/lead-activity/fleet",
		);
		expect(new URL(String(fetchImpl.mock.calls[0]![0])).search).toBe("");
	});

	it.each([
		[[]],
		[["--project", "flywheel"]],
		[["--lead", "x"]],
		[["--all", "--project", "flywheel"]],
		[["--all", "--lead", "x"]],
		[["--project", "flywheel", "--lead", "x", "--project", "y"]],
		[["--project", "fly wheel", "--lead", "x"]],
		[["--project", "flywheel", "--lead", "../etc"]],
		[["--project", "flywheel", "--lead", "x", "--bogus"]],
		[["positional"]],
		[["--all", "--bridge-url", "http://example.com"]],
	])("rejects %j before fetching", async (args) => {
		const r = await run(args);
		expect(r.code).toBe(1);
		expect(r.out.ok).toBe(false);
		expect(r.fetchImpl).not.toHaveBeenCalled();
	});

	it("requires TEAMLEAD_API_TOKEN", async () => {
		const r = await run(["--all"], vi.fn<typeof fetch>(), {
			TEAMLEAD_API_TOKEN: "",
		});
		expect(r).toMatchObject({
			code: 1,
			out: { ok: false, error: "api_token_required" },
		});
	});

	it.each([
		[404, { kind: "refused", reason: "unknown_lead" }, "unknown_lead"],
		[
			400,
			{ kind: "refused", reason: "invalid_arguments" },
			"invalid_arguments",
		],
		[401, { error: "Unauthorized" }, "bridge_http_401"],
		[
			500,
			{ kind: "refused", reason: "lead_activity_failed" },
			"bridge_http_500",
		],
	])("maps HTTP %i to a failed call", async (status, body, error) => {
		const r = await run(
			["--project", "flywheel", "--lead", "nobody"],
			vi.fn<typeof fetch>(async () => json(body, status)),
		);
		expect(r).toMatchObject({ code: 1, out: { ok: false, error } });
	});

	it("rejects a 200 whose body is not the expected schema", async () => {
		const r = await run(
			["--project", "flywheel", "--lead", "flywheel-eng-lead"],
			vi.fn<typeof fetch>(async () => json({ state: "idle" })),
		);
		expect(r).toMatchObject({
			code: 1,
			out: { ok: false, error: "unexpected_response" },
		});
		const fleet = await run(
			["--all"],
			vi.fn<typeof fetch>(async () => json(IDLE)),
		);
		expect(fleet).toMatchObject({
			code: 1,
			out: { ok: false, error: "unexpected_response" },
		});
	});

	it("reports network failure and timeout as failed calls", async () => {
		const r = await run(
			["--all"],
			vi.fn<typeof fetch>(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		expect(r).toMatchObject({
			code: 1,
			out: { ok: false, error: "bridge_unreachable" },
		});
		const log = vi.fn();
		const code = await runLeadActivity(["--all"], {
			env,
			timeoutMs: 5,
			log,
			fetchImpl: (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					),
				),
		});
		expect(code).toBe(1);
		expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
			ok: false,
			error: "timed_out",
		});
	});
});
