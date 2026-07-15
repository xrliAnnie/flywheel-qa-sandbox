/**
 * FLY-871 R3/C9 — flywheel-rescue-lead CLI: argv parse, env fallbacks, the POST
 * to /api/rescue, and exit-code mapping (0 rescued / 1 not-rescued / 2 usage / 3
 * transport). Never throws.
 */

import { describe, expect, it, vi } from "vitest";
import { runRescueLeadCli } from "../account-heal/rescue-lead-cli.js";

function jsonResponse(status: number, body: unknown): Response {
	return {
		status,
		json: async () => body,
	} as unknown as Response;
}

const quiet = { log: () => {}, errLog: () => {} };

describe("runRescueLeadCli", () => {
	it("usage error (exit 2) when --project/--lead missing", async () => {
		const code = await runRescueLeadCli(["--lead", "x"], {
			env: {},
			fetchImpl: vi.fn(),
			...quiet,
		});
		expect(code).toBe(2);
	});

	it("transport error (exit 3) when no bridge URL", async () => {
		const code = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: { TEAMLEAD_API_TOKEN: "t" },
			fetchImpl: vi.fn(),
			...quiet,
		});
		expect(code).toBe(3);
	});

	it("transport error (exit 3) when no token", async () => {
		const code = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: { BRIDGE_URL: "http://127.0.0.1:9999" },
			fetchImpl: vi.fn(),
			...quiet,
		});
		expect(code).toBe(3);
	});

	it("posts {route:lead,...} with a Bearer token (from env only) and returns 0 on rescue", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { ok: true, target: "lead:mufasa-lead" }),
		);
		const code = await runRescueLeadCli(
			[
				"--project",
				"growth",
				"--lead",
				"mufasa-lead",
				"--alert-id",
				"a-1",
				"--bridge-url",
				"http://127.0.0.1:9999/",
			],
			{ env: { TEAMLEAD_API_TOKEN: "secret" }, fetchImpl, ...quiet },
		);
		expect(code).toBe(0);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9999/api/rescue"); // trailing slash trimmed
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer secret",
		});
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			route: "lead",
			projectName: "growth",
			leadId: "mufasa-lead",
			alertId: "a-1",
		});
	});

	it("does NOT accept a --token flag (token never enters argv — Codex R1 MEDIUM)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
		// --token is passed but must be ignored; with no env token → exit 3.
		const code = await runRescueLeadCli(
			[
				"--project",
				"p",
				"--lead",
				"l",
				"--bridge-url",
				"http://x",
				"--token",
				"leak",
			],
			{ env: {}, fetchImpl, ...quiet },
		);
		expect(code).toBe(3);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns 1 on a valid not-rescued outcome (200 ok:false)", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				ok: false,
				reason: "no_pending_login_expired_alert",
			}),
		);
		const code = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: { BRIDGE_URL: "http://x", TEAMLEAD_API_TOKEN: "t" },
			fetchImpl,
			...quiet,
		});
		expect(code).toBe(1);
	});

	it("returns 3 on 409 self-heal-disabled and on a fetch throw", async () => {
		const c409 = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: { BRIDGE_URL: "http://x", TEAMLEAD_API_TOKEN: "t" },
			fetchImpl: vi.fn(async () =>
				jsonResponse(409, { reason: "self_heal_disabled" }),
			),
			...quiet,
		});
		expect(c409).toBe(3);

		const cThrow = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: { BRIDGE_URL: "http://x", TEAMLEAD_API_TOKEN: "t" },
			fetchImpl: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			...quiet,
		});
		expect(cThrow).toBe(3);
	});

	it("uses BRIDGE_URL / TEAMLEAD_API_TOKEN env fallbacks", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
		const code = await runRescueLeadCli(["--project", "p", "--lead", "l"], {
			env: {
				BRIDGE_URL: "http://127.0.0.1:8080",
				TEAMLEAD_API_TOKEN: "envtok",
			},
			fetchImpl,
			...quiet,
		});
		expect(code).toBe(0);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:8080/api/rescue");
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer envtok",
		});
	});
});
