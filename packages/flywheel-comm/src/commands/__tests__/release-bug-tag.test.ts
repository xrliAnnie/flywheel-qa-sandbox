import { expect, it, vi } from "vitest";
import { runReleaseBugTag } from "../release-bug-tag.js";

it("posts version attribution and resolves an intent with the master token", async () => {
	const fetchFn = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ intentId: "rb-test", status: "finalized" }),
				{ status: 201 },
			),
	);
	const log = vi.fn();
	const deps = {
		env: {
			TEAMLEAD_API_TOKEN: "master",
			FLYWHEEL_BRIDGE_URL: "http://localhost:9876",
		},
		fetchFn,
		log,
	};
	expect(
		await runReleaseBugTag(
			[
				"--issue",
				"FLY-2390",
				"--commit",
				"a".repeat(40),
				"--base-version",
				"1.56.0",
			],
			deps,
		),
	).toBe(0);
	expect(fetchFn.mock.calls[0]?.[0]).toBe(
		"http://localhost:9876/api/release-readiness/bug-report",
	);
	const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
	expect(JSON.parse(init.body as string)).toEqual({
		issueIdentifier: "FLY-2390",
		sourceCommit: "a".repeat(40),
		baseVersion: "1.56.0",
	});
	expect(init.headers).toMatchObject({ Authorization: "Bearer master" });
	expect(
		await runReleaseBugTag(
			["--resolve-intent", "rb-test", "--abandon", "--reason", "duplicate"],
			deps,
		),
	).toBe(0);
	expect(fetchFn.mock.calls[1]?.[0]).toBe(
		"http://localhost:9876/api/release-readiness/bug-intent/rb-test/resolve",
	);
	expect(
		JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string),
	).toEqual({ abandon: true, reason: "duplicate" });
});

it("rejects conflicting arguments before sending and returns failure for HTTP and transport errors", async () => {
	const fetchFn = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response('{"error":"rejected"}', { status: 403 }));
	const deps = { env: { TEAMLEAD_API_TOKEN: "master" }, fetchFn, log: vi.fn() };
	for (const args of [
		[],
		["--issue", "FLY-1", "--abandon"],
		["--resolve-intent", "rb", "--abandon", "--reason", " "],
		["--issue", "FLY-1", "--commit", "a".repeat(40)],
	])
		expect(await runReleaseBugTag(args, deps)).toBe(1);
	expect(fetchFn).not.toHaveBeenCalled();
	expect(await runReleaseBugTag(["--issue", "FLY-1"], deps)).toBe(1);
	fetchFn.mockRejectedValue(new Error("transport unavailable"));
	expect(await runReleaseBugTag(["--issue", "FLY-1"], deps)).toBe(1);
	expect(
		await runReleaseBugTag(["--issue", "FLY-1"], { ...deps, env: {} }),
	).toBe(1);
});
