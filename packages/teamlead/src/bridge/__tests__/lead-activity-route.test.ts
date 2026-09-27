import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { masterOnlyAuthMiddleware } from "../dependency-route.js";
import type {
	LeadActivityFleetV1,
	LeadActivityV1,
} from "../lead-activity/types.js";
import { createLeadActivityRouter } from "../lead-activity-route.js";

const OBSERVED = "2026-09-25T20:00:00.000Z";
const IDLE: LeadActivityV1 = {
	schema: "lead-activity.v1",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
	carrier: "claude-code",
	observedAt: OBSERVED,
	source: "claude_pane",
	state: "idle",
};
const BUSY: LeadActivityV1 = {
	schema: "lead-activity.v1",
	projectName: "raya",
	leadId: "raya",
	carrier: "codex-app-server",
	observedAt: OBSERVED,
	source: "codex_sidecar",
	state: "busy",
	turn: {
		startedAt: "2026-09-25T19:58:25.000Z",
		elapsedMs: 95_000,
		precision: "second",
		origin: "message",
	},
	trigger: {
		kind: "issue",
		issueId: "FLY-2830",
		basis: "codex_journal_members",
	},
};

describe("lead activity routes", () => {
	const close: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const stop of close.splice(0)) await stop();
	});

	async function fixture(
		over: {
			master?: string | undefined;
			read?: (p: string, l: string) => Promise<LeadActivityV1 | undefined>;
			readFleet?: () => Promise<LeadActivityFleetV1>;
		} = {},
	) {
		const read = vi.fn(
			over.read ??
				(async (projectName: string, leadId: string) =>
					projectName === "flywheel" && leadId === "flywheel-eng-lead"
						? IDLE
						: undefined),
		);
		const readFleet = vi.fn(
			over.readFleet ??
				(async () => ({
					schema: "lead-activity-fleet.v1" as const,
					observedAt: OBSERVED,
					leads: [IDLE, BUSY],
				})),
		);
		const app = express();
		app.use(
			"/api/lead-activity",
			masterOnlyAuthMiddleware(
				"master" in over ? over.master : "master",
				"scoped",
			),
			createLeadActivityRouter({ read, readFleet }),
		);
		const server = createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		close.push(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead-activity`;
		const get = (path: string, token = "master") =>
			fetch(`${base}${path}`, {
				headers: { authorization: `Bearer ${token}` },
			});
		return { read, readFleet, get };
	}

	it("returns the validated DTO for exactly projectName + leadId", async () => {
		const f = await fixture();
		const response = await f.get(
			"?projectName=flywheel&leadId=flywheel-eng-lead",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual(IDLE);
		expect(f.read).toHaveBeenCalledExactlyOnceWith(
			"flywheel",
			"flywheel-eng-lead",
		);
	});

	it.each([
		["no query", ""],
		["a missing leadId", "?projectName=flywheel"],
		[
			"an extra parameter",
			"?projectName=flywheel&leadId=flywheel-eng-lead&issue=FLY-1",
		],
		["a repeated parameter", "?projectName=flywheel&leadId=a&leadId=b"],
		["an empty value", "?projectName=&leadId=flywheel-eng-lead"],
		["a path-like value", "?projectName=..%2Fetc&leadId=flywheel-eng-lead"],
		["a space", "?projectName=fly%20wheel&leadId=flywheel-eng-lead"],
		["an overlong value", `?projectName=flywheel&leadId=${"a".repeat(65)}`],
	])("refuses %s with 400 before reading", async (_label, query) => {
		const f = await fixture();
		const response = await f.get(query);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			kind: "refused",
			reason: "invalid_arguments",
		});
		expect(f.read).not.toHaveBeenCalled();
	});

	it("answers 404 unknown_lead for a Lead outside the roster", async () => {
		const f = await fixture();
		const response = await f.get("?projectName=flywheel&leadId=nobody");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			kind: "refused",
			reason: "unknown_lead",
		});
	});

	it("answers 500 instead of leaking an invalid DTO", async () => {
		const f = await fixture({
			read: async () => ({ ...IDLE, content: "SENTINEL body" }) as never,
			readFleet: async () => ({
				schema: "lead-activity-fleet.v1",
				observedAt: OBSERVED,
				leads: [{ ...IDLE, state: "idle", unknown: { reason: "x" } } as never],
			}),
		});
		const one = await f.get("?projectName=flywheel&leadId=flywheel-eng-lead");
		expect(one.status).toBe(500);
		expect(await one.text()).not.toContain("SENTINEL");
		expect((await f.get("/fleet")).status).toBe(500);
	});

	it("answers 500 when the service throws", async () => {
		const f = await fixture({
			read: async () => {
				throw new Error("SENTINEL internal path");
			},
		});
		const response = await f.get(
			"?projectName=flywheel&leadId=flywheel-eng-lead",
		);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("SENTINEL");
	});

	it("serves the fleet and refuses any query on it", async () => {
		const f = await fixture();
		const response = await f.get("/fleet");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schema: "lead-activity-fleet.v1",
			observedAt: OBSERVED,
			leads: [IDLE, BUSY],
		});
		const refused = await f.get("/fleet?projectName=flywheel");
		expect(refused.status).toBe(400);
		expect(f.readFleet).toHaveBeenCalledTimes(1);
	});

	it("fails before any read for missing, wrong and scoped credentials", async () => {
		for (const master of ["master", undefined]) {
			const f = await fixture({ master });
			for (const token of ["", "wrong", "scoped"]) {
				for (const path of [
					"?projectName=flywheel&leadId=flywheel-eng-lead",
					"/fleet",
				]) {
					const response = await f.get(path, token);
					expect(response.status).toBe(
						master === undefined ? 503 : token === "scoped" ? 403 : 401,
					);
				}
			}
			expect(f.read).not.toHaveBeenCalled();
			expect(f.readFleet).not.toHaveBeenCalled();
		}
	});
});
