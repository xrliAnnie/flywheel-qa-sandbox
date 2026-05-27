/**
 * FLY-162 Layer 2 — reply-guard tests.
 *
 * Two layers:
 *  1. Pure-logic unit tests for `scanIssueTokens` + `evaluateReplyGuard`
 *     (no Express, no StateStore).
 *  2. Route-level tests for `POST /api/discord/reply-guard` mounted on a real
 *     Express server (classification + flag-off + unknown project/lead fail-open).
 *
 * Plan: §12.5–§12.10.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { evaluateReplyGuard, scanIssueTokens } from "../reply-guard.js";
import { createQueryRouter, type QueryRouterOptions } from "../tools.js";

// ──────────────────────────────────────────────────────────────────────
// 1. Pure logic — scanIssueTokens
// ──────────────────────────────────────────────────────────────────────

describe("scanIssueTokens", () => {
	const prefixes = ["FLY", "GEO"];

	it("matches canonical uppercase tokens", () => {
		expect(scanIssueTokens("FLY-159 和 FLY-161 哪个先做？", prefixes)).toEqual([
			"FLY-159",
			"FLY-161",
		]);
	});

	it("is case-insensitive and normalizes to uppercase", () => {
		expect(scanIssueTokens("fly-159 vs FLY-161", prefixes)).toEqual([
			"FLY-159",
			"FLY-161",
		]);
	});

	it("matches tokens separated by a slash (no spaces)", () => {
		expect(scanIssueTokens("FLY-159/FLY-161", prefixes)).toEqual([
			"FLY-159",
			"FLY-161",
		]);
	});

	it("matches tokens inside markdown links", () => {
		expect(
			scanIssueTokens("[FLY-159](http://x) and [GEO-200](http://y)", prefixes),
		).toEqual(["FLY-159", "GEO-200"]);
	});

	it("matches tokens adjacent to Chinese punctuation", () => {
		expect(scanIssueTokens("先做FLY-159，再看GEO-12。", prefixes)).toEqual([
			"FLY-159",
			"GEO-12",
		]);
	});

	it("deduplicates repeated tokens", () => {
		expect(scanIssueTokens("FLY-159 FLY-159 fly-159", prefixes)).toEqual([
			"FLY-159",
		]);
	});

	it("ignores non-configured prefixes (HTTP-2, GPT-4)", () => {
		expect(
			scanIssueTokens("HTTP-2 and GPT-4 are not issues", prefixes),
		).toEqual([]);
	});

	it("ignores configured prefix only — does not match arbitrary ALLCAPS", () => {
		expect(scanIssueTokens("ABC-1 DEF-2", prefixes)).toEqual([]);
	});

	it("returns empty for issue-free free-form text", () => {
		expect(scanIssueTokens("how are you doing today?", prefixes)).toEqual([]);
	});

	it("returns empty for empty/undefined text", () => {
		expect(scanIssueTokens("", prefixes)).toEqual([]);
	});
});

// ──────────────────────────────────────────────────────────────────────
// 1b. Pure logic — evaluateReplyGuard
// ──────────────────────────────────────────────────────────────────────

describe("evaluateReplyGuard", () => {
	it("DENIES channel-top-level with >=1 issue token (single)", () => {
		const d = evaluateReplyGuard({
			classification: "channel-top-level",
			issueTokens: ["FLY-159"],
		});
		expect(d.allow).toBe(false);
		expect(d.reason).toBe("issue_at_top_level");
		expect(d.issues).toEqual(["FLY-159"]);
		expect(d.guidance).toContain("/api/chat-threads/send");
	});

	it("DENIES channel-top-level with >=2 issue tokens (TC-02)", () => {
		const d = evaluateReplyGuard({
			classification: "channel-top-level",
			issueTokens: ["FLY-159", "FLY-161"],
		});
		expect(d.allow).toBe(false);
		expect(d.reason).toBe("issue_at_top_level");
	});

	it("ALLOWS channel-top-level with zero issue tokens (free-form)", () => {
		expect(
			evaluateReplyGuard({
				classification: "channel-top-level",
				issueTokens: [],
			}),
		).toEqual({ allow: true });
	});

	it("ALLOWS issue-thread reply about the bound issue", () => {
		expect(
			evaluateReplyGuard({
				classification: "issue-thread",
				boundIssueIdentifier: "FLY-159",
				issueTokens: ["FLY-159"],
			}),
		).toEqual({ allow: true });
	});

	it("ALLOWS issue-thread but tags potential_wrong_thread on foreign tokens", () => {
		const d = evaluateReplyGuard({
			classification: "issue-thread",
			boundIssueIdentifier: "FLY-159",
			issueTokens: ["FLY-159", "GEO-200"],
		});
		expect(d.allow).toBe(true);
		expect(d.telemetry).toBe("potential_wrong_thread");
		expect(d.issues).toEqual(["GEO-200"]);
	});

	it("ALLOWS 'other' channels (core channel) regardless of issue tokens", () => {
		expect(
			evaluateReplyGuard({
				classification: "other",
				issueTokens: ["FLY-159", "GEO-200"],
			}),
		).toEqual({ allow: true });
	});
});

// ──────────────────────────────────────────────────────────────────────
// 2. Route-level — POST /api/discord/reply-guard
// ──────────────────────────────────────────────────────────────────────

const TEST_PROJECT: ProjectEntry = {
	projectName: "TestProject",
	projectRoot: "/tmp/test",
	leads: [
		{
			agentId: "lead-alpha",
			chatChannel: "ch-100",
			match: { labels: ["alpha"] },
			botToken: "lead-token-alpha",
		},
	],
} as ProjectEntry;

async function request(
	server: Server,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("Server not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

describe("POST /api/discord/reply-guard (route)", () => {
	let store: StateStore;
	let server: Server;

	function createTestServer(opts: QueryRouterOptions) {
		const app = express();
		app.use(express.json());
		app.use("/api", createQueryRouter(store, [TEST_PROJECT], opts));
		server = createServer(app);
		server.listen(0);
		return server;
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		if (server) server.close();
	});

	it("returns { allow: true } when guard flag is OFF (does not block)", async () => {
		createTestServer({ replyGuardEnabled: false });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "ch-100",
			text: "FLY-159 and FLY-161",
		});
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ allow: true });
	});

	it("400 when required fields are missing", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			leadId: "lead-alpha",
			chatId: "ch-100",
		});
		expect(res.status).toBe(400);
	});

	it("400 when chatId is not a string (no DB binding 500)", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: {}, // non-string — must be rejected cleanly, not reach the DB
			text: "FLY-159",
		});
		expect(res.status).toBe(400);
	});

	it("400 when a required string is empty/whitespace", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "   ",
			chatId: "ch-100",
			text: "FLY-159",
		});
		expect(res.status).toBe(400);
	});

	it("DENIES issue token at chatChannel top level", async () => {
		createTestServer({
			replyGuardEnabled: true,
			issuePrefixes: ["FLY", "GEO"],
		});
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "ch-100", // == lead-alpha.chatChannel
			text: "FLY-159 和 FLY-161 哪个先做？",
		});
		expect(res.status).toBe(200);
		expect(res.body.allow).toBe(false);
		expect(res.body.reason).toBe("issue_at_top_level");
		expect(res.body.issues).toEqual(["FLY-159", "FLY-161"]);
	});

	it("ALLOWS free-form (zero issue tokens) at chatChannel top level", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "ch-100",
			text: "on it, will update soon",
		});
		expect(res.body).toEqual({ allow: true });
	});

	it("ALLOWS issue-bound reply inside the matching issue thread", async () => {
		store.upsertChatThread(
			"thread-abc",
			"ch-100",
			"issue-uuid-1",
			"lead-alpha",
		);
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-uuid-1",
			project_name: "TestProject",
			status: "running",
			issue_identifier: "FLY-159",
			issue_title: "Some issue",
		});
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "thread-abc",
			text: "FLY-159 status: in review",
		});
		expect(res.body).toEqual({ allow: true });
	});

	it("tags potential_wrong_thread for foreign issue tokens in a thread", async () => {
		store.upsertChatThread(
			"thread-abc",
			"ch-100",
			"issue-uuid-1",
			"lead-alpha",
		);
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-uuid-1",
			project_name: "TestProject",
			status: "running",
			issue_identifier: "FLY-159",
			issue_title: "Some issue",
		});
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "thread-abc",
			text: "FLY-159 and also GEO-200",
		});
		expect(res.body.allow).toBe(true);
		expect(res.body.telemetry).toBe("potential_wrong_thread");
		expect(res.body.issues).toEqual(["GEO-200"]);
	});

	it("ALLOWS unregistered channel ('other') with issue tokens", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "TestProject",
			leadId: "lead-alpha",
			chatId: "core-channel-xyz", // not chatChannel, not a registered thread
			text: "Standup: FLY-159 and GEO-200 both progressing",
		});
		expect(res.body).toEqual({ allow: true });
	});

	it("fail-open (allow + guard_bypass) on unknown project/lead", async () => {
		createTestServer({ replyGuardEnabled: true });
		const res = await request(server, "POST", "/api/discord/reply-guard", {
			projectName: "NoSuchProject",
			leadId: "lead-alpha",
			chatId: "ch-100",
			text: "FLY-159",
		});
		expect(res.body.allow).toBe(true);
		expect(res.body.reason).toBe("guard_bypass");
	});
});
