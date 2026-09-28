import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeResetCardRuntime } from "../account-heal/reset-card-probe.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly2896-probe-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

function runtime(fetchFn: typeof fetch) {
	return makeResetCardRuntime({
		dir: join(root, "claude-quota"),
		poolDir: join(root, "pool"),
		storePath: join(root, "claude-accounts.json"),
		baseUrl: "http://127.0.0.1:9",
		fetchFn,
		readCliVersion: async () => "2.1.283",
	});
}

describe("makeResetCardRuntime", () => {
	it("reads display cards from the same account-detail cache, without HTTP", () => {
		const fetchFn = vi.fn();
		const rc = runtime(fetchFn);
		expect(rc.readAccountCards?.().size).toBe(0);
		mkdirSync(join(root, "claude-quota"));
		writeFileSync(
			join(root, "claude-quota", "account-details.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-25T23:05:00.000Z",
				accounts: [
					{
						name: "personal",
						observedAt: "2026-09-25T23:05:00.000Z",
						subscription: "active",
						usageStatus: "ok",
						prepaid: { known: false, cards: null },
						note: null,
						resetGrants: {
							known: true,
							reason: null,
							grants: [
								{
									resetsLeft: 1,
									resetsTotal: 1,
									endsAt: "2026-10-22T16:00:00.000Z",
								},
							],
						},
					},
				],
			}),
		);
		expect(rc.readAccountCards?.().get("personal")).toEqual([
			{ count: 1, endsAt: "2026-10-22T16:00:00.000Z" },
		]);
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("reads usage + the card block with the CLI UA, GET only", async () => {
		const fetchFn = vi.fn(async () =>
			json(200, {
				five_hour: { utilization: 12, resets_at: "2026-09-26T03:00:00+00:00" },
				seven_day: { utilization: 100, resets_at: "2026-10-01T02:00:00+00:00" },
				cedar_ember: {
					eligible: true,
					at_limit: true,
					exhausted: ["seven_day"],
					grants: [
						{
							id: "opus55-launch-promax-20260921",
							resets_total: 1,
							resets_left: 1,
							ends_at: "2026-10-22T16:00:00+00:00",
							clears: ["five_hour", "seven_day"],
							usable_now: true,
						},
					],
					next_grant_id: "opus55-launch-promax-20260921",
				},
			}),
		);
		const read = await runtime(
			fetchFn as unknown as typeof fetch,
		).fetchCardStatus("tok", "2.1.283");
		expect("ok" in read && read.ok.usage.sevenD.pct).toBe(100);
		expect("ok" in read && read.ok.cedar.nextGrantId).toBe(
			"opus55-launch-promax-20260921",
		);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"http://127.0.0.1:9/api/oauth/usage?cedar_ember=1&skip_spend=1",
		);
		expect(init.method).toBe("GET");
		expect(init.redirect).toBe("error");
		expect(init.headers).toMatchObject({
			"User-Agent": "claude-cli/2.1.283 (external, cli)",
		});
	});

	it("reports a missing card block and bad statuses as errors, never as zero cards", async () => {
		const noBlock = runtime((async () =>
			json(200, {
				five_hour: { utilization: 1, resets_at: null },
				seven_day: { utilization: 1, resets_at: null },
			})) as unknown as typeof fetch);
		expect(await noBlock.fetchCardStatus("tok", "2.1.283")).toEqual({
			error: "cedar_absent",
		});
		const denied = runtime((async () =>
			json(403, {})) as unknown as typeof fetch);
		expect(await denied.fetchCardStatus("tok", "2.1.283")).toEqual({
			error: "forbidden",
		});
	});

	it("parses the profile down to org uuid + subscription", async () => {
		const rc = runtime((async () =>
			json(200, {
				organization: {
					uuid: "12345678-1234-4abc-8def-1234567890ab",
					subscription_status: "canceled",
				},
			})) as unknown as typeof fetch);
		expect(await rc.fetchProfile("tok")).toEqual({
			ok: {
				organizationUuid: "12345678-1234-4abc-8def-1234567890ab",
				subscription: "canceled",
			},
		});
	});

	it("refuses a test origin without an injected fetch", () => {
		expect(() =>
			makeResetCardRuntime({
				dir: root,
				poolDir: root,
				storePath: join(root, "s.json"),
				baseUrl: "http://127.0.0.1:9",
			}),
		).toThrow(/fetch_injection/);
	});
});
