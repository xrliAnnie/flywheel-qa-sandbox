import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
	type ApprovedRedeem,
	bindApproval,
	redeemResetCard,
} from "../account-heal/reset-card-redeem.js";
import {
	FOUNDER_ID,
	GRANT_ID,
	OTHER_PROPOSAL_ID,
	REQUEST_ID,
	sampleConsent,
	sampleProposal,
} from "./reset-card-test-fixtures.js";

const ORG = "12345678-1234-4abc-8def-1234567890ab";

function approved(): ApprovedRedeem {
	const bound = bindApproval(sampleProposal(), sampleConsent());
	if (!("ok" in bound)) throw new Error("fixture should bind");
	return bound.ok;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("bindApproval", () => {
	it("binds a matching approved consent", () => {
		const bound = bindApproval(sampleProposal(), sampleConsent());
		expect("ok" in bound && bound.ok).toMatchObject({
			target: "business",
			grantId: GRANT_ID,
			founderId: FOUNDER_ID,
		});
	});

	it.each([
		[
			"proposal id mismatch",
			sampleConsent(sampleProposal(), { proposalId: OTHER_PROPOSAL_ID }),
			"proposal_mismatch",
		],
		[
			"digest mismatch",
			sampleConsent(sampleProposal(), { digest: "c".repeat(64) }),
			"digest_mismatch",
		],
		[
			"not approved",
			sampleConsent(sampleProposal(), { state: "posted" }),
			"not_approved",
		],
		[
			"rejected",
			sampleConsent(sampleProposal(), { state: "rejected" }),
			"not_approved",
		],
		[
			"founder missing",
			sampleConsent(sampleProposal(), { founderId: null }),
			"founder_missing",
		],
		[
			"decided after expiry",
			sampleConsent(sampleProposal(), {
				decidedAt: "2026-09-26T01:05:00.001Z",
			}),
			"decided_after_expiry",
		],
		[
			"decision missing",
			sampleConsent(sampleProposal(), { decidedAt: null }),
			"decided_after_expiry",
		],
	])("refuses %s", (_label, consent, refused) => {
		expect(bindApproval(sampleProposal(), consent)).toEqual({ refused });
	});
});

describe("redeemResetCard", () => {
	it("POSTs exactly the CLI's request once", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(200, {
				result: "reset",
				resets_left: 0,
				cleared: ["seven_day"],
			}),
		);
		const outcome = await redeemResetCard(approved(), {
			accessToken: "tok",
			orgUuid: ORG,
			cliVersion: "2.1.283",
			requestId: REQUEST_ID,
			baseUrl: "http://127.0.0.1:9",
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(outcome).toEqual({
			kind: "reset",
			resetsLeft: 0,
			cleared: ["seven_day"],
		});
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			`http://127.0.0.1:9/api/organizations/${ORG}/reset_rate_limits`,
		);
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("error");
		expect(JSON.parse(String(init.body))).toEqual({
			program: "cedar_ember",
			grant_id: GRANT_ID,
			request_id: REQUEST_ID,
		});
		expect(init.headers).toMatchObject({
			Authorization: "Bearer tok",
			"User-Agent": "claude-cli/2.1.283 (external, cli)",
			"anthropic-beta": "oauth-2025-04-20",
			"Content-Type": "application/json",
		});
	});

	it("does not retry after a 401", async () => {
		const fetchFn = vi.fn(async () => jsonResponse(401, {}));
		const outcome = await redeemResetCard(approved(), {
			accessToken: "tok",
			orgUuid: ORG,
			cliVersion: "2.1.283",
			requestId: REQUEST_ID,
			baseUrl: "http://127.0.0.1:9",
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(outcome).toEqual({ kind: "not_spent", cause: "auth_error" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("classifies a thrown fetch and a timeout as unconfirmed", async () => {
		const base = {
			accessToken: "tok",
			orgUuid: ORG,
			cliVersion: "2.1.283",
			requestId: REQUEST_ID,
			baseUrl: "http://127.0.0.1:9",
		};
		await expect(
			redeemResetCard(approved(), {
				...base,
				fetchFn: (async () => {
					throw new TypeError("connect refused");
				}) as unknown as typeof fetch,
			}),
		).resolves.toEqual({ kind: "unconfirmed", cause: "network" });
		await expect(
			redeemResetCard(approved(), {
				...base,
				timeoutMs: 5,
				fetchFn: ((_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					})) as unknown as typeof fetch,
			}),
		).resolves.toEqual({ kind: "unconfirmed", cause: "timeout" });
	});

	it("refuses a test origin without an injected fetch, and forged approvals", async () => {
		await expect(
			redeemResetCard(approved(), {
				accessToken: "tok",
				orgUuid: ORG,
				cliVersion: "2.1.283",
				requestId: REQUEST_ID,
				baseUrl: "http://127.0.0.1:9",
			}),
		).rejects.toThrow(/fetch_injection/);
		const forged = {
			proposalId: "x",
			target: "business",
			grantId: GRANT_ID,
		} as unknown as ApprovedRedeem;
		const fetchFn = vi.fn();
		await expect(
			redeemResetCard(forged, {
				accessToken: "tok",
				orgUuid: ORG,
				cliVersion: "2.1.283",
				requestId: REQUEST_ID,
				baseUrl: "http://127.0.0.1:9",
				fetchFn: fetchFn as unknown as typeof fetch,
			}),
		).rejects.toThrow(/ApprovedRedeem/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("never reads the environment for its origin", async () => {
		const before = process.env.FLYWHEEL_QUOTA_API_BASE;
		process.env.FLYWHEEL_QUOTA_API_BASE = "http://evil.invalid";
		try {
			const fetchFn = vi.fn(async () =>
				jsonResponse(200, { result: "cooldown" }),
			);
			await redeemResetCard(approved(), {
				accessToken: "tok",
				orgUuid: ORG,
				cliVersion: "2.1.283",
				requestId: REQUEST_ID,
				baseUrl: "http://127.0.0.1:9",
				fetchFn: fetchFn as unknown as typeof fetch,
			});
			expect(String(fetchFn.mock.calls[0]?.[0])).toContain("127.0.0.1:9");
		} finally {
			if (before === undefined) delete process.env.FLYWHEEL_QUOTA_API_BASE;
			else process.env.FLYWHEEL_QUOTA_API_BASE = before;
		}
	});
});

describe("negative guards (I1)", () => {
	const SRC = join(__dirname, "..");

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((entry) => {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				return entry === "__tests__" || entry === "node_modules"
					? []
					: sourceFiles(path);
			}
			return /\.(ts|mts|cts)$/.test(entry) && !/\.test\.ts$/.test(entry)
				? [path]
				: [];
		});
	}

	/** String/template literal text only — comments never count. */
	function literals(path: string): string[] {
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const found: string[] = [];
		const visit = (node: ts.Node) => {
			if (
				ts.isStringLiteral(node) ||
				ts.isNoSubstitutionTemplateLiteral(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)
			) {
				found.push(node.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return found;
	}

	it("only reset-card-redeem.ts holds the redeem endpoint literal", () => {
		// Cheap text prefilter first; only mentioning files are parsed.
		const holders = sourceFiles(SRC)
			.filter((path) =>
				readFileSync(path, "utf8").includes("reset_rate_limits"),
			)
			.filter((path) =>
				literals(path).some((text) => text.includes("reset_rate_limits")),
			);
		expect(holders.map((path) => relative(SRC, path))).toEqual([
			join("account-heal", "reset-card-redeem.ts"),
		]);
	});

	it("never names the other reset program", () => {
		const holders = sourceFiles(SRC).filter((path) =>
			readFileSync(path, "utf8").includes("juniper_tide"),
		);
		expect(holders).toEqual([]);
	});

	it("the account-detail observer still only issues GETs", () => {
		const observer = readFileSync(
			join(SRC, "claude-quota", "account-detail-observer.ts"),
			"utf8",
		);
		expect(observer).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
		expect(observer).toMatch(/method:\s*"GET"/);
	});
});
