import { describe, expect, it, vi } from "vitest";
import {
	type LeadInterruptCommandDeps,
	runLeadInterruptCommand,
} from "../commands/lead-interrupt.js";
import type { LeadWriteAuthorization } from "../lead-lease.js";

const ENV = {
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
	TEAMLEAD_API_TOKEN: "master-token",
	FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
	FLYWHEEL_PROJECT_NAME: "flywheel",
};

function harness(
	options: {
		authorization?: LeadWriteAuthorization;
		responses?: Array<{ status: number; body: unknown }>;
		stdin?: string;
		env?: Record<string, string | undefined>;
	} = {},
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const responses = [...(options.responses ?? [])];
	const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = responses.shift() ?? { status: 200, body: {} };
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	const out: string[] = [];
	const err: string[] = [];
	const authorize = vi.fn(
		() =>
			options.authorization ?? {
				disposition: "lease_validated" as const,
				identityDigest: "d".repeat(64),
				leaseClaim: {
					leaseKey: "flywheel/flywheel-eng-lead",
					generation: 7,
					identityDigest: "d".repeat(64),
				},
			},
	);
	const deps: LeadInterruptCommandDeps = {
		env: { ...ENV, ...(options.env ?? {}) },
		fetchImpl,
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		readStdin: async () => options.stdin ?? "",
		authorize,
	};
	return { deps, calls, out, err, authorize };
}

function jsonBody(init: RequestInit): Record<string, unknown> {
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("FLY-2883 flywheel-comm lead-interrupt", () => {
	it("pending posts the Lead identity and prints each letter with its provenance", async () => {
		const h = harness({
			responses: [
				{
					status: 200,
					body: {
						interrupts: [
							{
								interruptId: "li_00000000-0000-4000-8000-000000000001",
								founderMessageId: "300000000000000001",
								body: "你现在在做什么?",
								createdAt: "2026-09-25T20:00:00.000Z",
								relayedBy: "voice_session",
								notFounderTyped: true,
							},
						],
					},
				},
			],
		});
		expect(await runLeadInterruptCommand(["pending"], h.deps)).toBe(0);
		expect(h.authorize).toHaveBeenCalledWith("flywheel-eng-lead", h.deps.env);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.url).toBe(
			"http://127.0.0.1:9876/api/lead-interrupts/pending/query",
		);
		expect(h.calls[0]!.init.method).toBe("POST");
		expect(new Headers(h.calls[0]!.init.headers).get("authorization")).toBe(
			"Bearer master-token",
		);
		expect(jsonBody(h.calls[0]!.init)).toEqual({
			project: "flywheel",
			leadId: "flywheel-eng-lead",
			identityDigest: "d".repeat(64),
			leaseClaim: { leaseKey: "flywheel/flywheel-eng-lead", generation: 7 },
		});
		const printed = h.out.join("\n");
		expect(printed).toContain("li_00000000-0000-4000-8000-000000000001");
		expect(printed).toContain("你现在在做什么?");
		expect(printed).toContain("不是 founder 本人");
		expect(printed).toContain(
			"flywheel-comm lead-interrupt reply li_00000000-0000-4000-8000-000000000001 --text-stdin",
		);
	});

	it("pending --json prints the Bridge payload verbatim", async () => {
		const h = harness({
			responses: [{ status: 200, body: { interrupts: [] } }],
		});
		expect(await runLeadInterruptCommand(["pending", "--json"], h.deps)).toBe(
			0,
		);
		expect(JSON.parse(h.out.join(""))).toEqual({ interrupts: [] });
	});

	it("reply reads the text from stdin and posts it by interrupt id", async () => {
		const h = harness({
			stdin: "在改投递循环,五分钟后好\n",
			responses: [
				{
					status: 200,
					body: {
						interruptId: "li_00000000-0000-4000-8000-000000000001",
						state: "replied",
						replayed: false,
					},
				},
			],
		});
		expect(
			await runLeadInterruptCommand(
				["reply", "li_00000000-0000-4000-8000-000000000001", "--text-stdin"],
				h.deps,
			),
		).toBe(0);
		expect(h.calls[0]!.url).toBe(
			"http://127.0.0.1:9876/api/lead-interrupts/li_00000000-0000-4000-8000-000000000001/reply",
		);
		expect(jsonBody(h.calls[0]!.init)).toMatchObject({
			project: "flywheel",
			leadId: "flywheel-eng-lead",
			text: "在改投递循环,五分钟后好\n",
		});
		expect(h.out.join("\n")).toContain("replied");
	});

	it("routes a Codex carrier claim through the loopback carrier POST", async () => {
		const h = harness({
			authorization: {
				disposition: "carrier_passthrough",
				identityDigest: "d".repeat(64),
				carrierClaim: "carrier-secret",
			},
			responses: [{ status: 200, body: { interrupts: [] } }],
		});
		expect(await runLeadInterruptCommand(["pending"], h.deps)).toBe(0);
		expect(jsonBody(h.calls[0]!.init)).toEqual({
			project: "flywheel",
			leadId: "flywheel-eng-lead",
			identityDigest: "d".repeat(64),
			carrierClaim: "carrier-secret",
		});
		expect(h.calls[0]!.init.redirect).toBe("error");
	});

	it("surfaces the Bridge error code and exits non-zero", async () => {
		const h = harness({
			stdin: "x",
			responses: [{ status: 409, body: { error: "already_replied" } }],
		});
		expect(
			await runLeadInterruptCommand(
				["reply", "li_00000000-0000-4000-8000-000000000001", "--text-stdin"],
				h.deps,
			),
		).toBe(1);
		expect(h.err.join("\n")).toContain("already_replied");
	});

	it.each([
		[["reply", "not-an-id", "--text-stdin"]],
		[["reply", "li_00000000-0000-4000-8000-000000000001"]],
		[["unknown"]],
		[[]],
	])("rejects malformed usage %j without calling the Bridge", async (args) => {
		const h = harness();
		expect(await runLeadInterruptCommand(args, h.deps)).toBe(2);
		expect(h.calls).toHaveLength(0);
	});

	it("fails before any request when the Lead cannot be authorized", async () => {
		const h = harness();
		h.authorize.mockImplementation(() => {
			throw new Error("identity integrity failed");
		});
		expect(await runLeadInterruptCommand(["pending"], h.deps)).toBe(1);
		expect(h.calls).toHaveLength(0);
		expect(h.err.join("\n")).toContain("identity integrity failed");
	});

	it("requires the Bridge URL and API token", async () => {
		const h = harness({ env: { TEAMLEAD_API_TOKEN: undefined } });
		expect(await runLeadInterruptCommand(["pending"], h.deps)).toBe(1);
		expect(h.calls).toHaveLength(0);
	});
});
