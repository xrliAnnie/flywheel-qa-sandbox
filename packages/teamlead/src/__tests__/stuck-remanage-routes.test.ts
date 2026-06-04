/**
 * FLY-195: tests for the Lead remanage endpoints (plan §3.4 + §3.5).
 *
 * The recovery-nudge gates are the FLY-175 safety boundary of this feature —
 * every refusal path is asserted, and every attempt (sent or refused) must
 * leave an audit row (Codex R1 HIGH-2).
 */

import type http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureError, CaptureResult } from "../bridge/session-capture.js";
import { fingerprintOutput } from "../bridge/stuck-candidate.js";
import {
	createStuckRemanageRouter,
	NUDGE_ALLOWLIST,
	type StuckRemanageRouterOptions,
} from "../bridge/stuck-remanage-routes.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		projectRepo: "x/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

/** A realistic frozen frame: idle input box at the bottom (current TUI). */
const STUCK_FRAME = [
	"⎿ API Error: Stream idle timeout - partial response received",
	"────────────────────────────────────── @runner ──",
	"❯ ",
	"──────────────────────────────────────────────────",
	"  Opus 4.8 | runner | ctx 40%",
	"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");
const STUCK_FP = fingerprintOutput(STUCK_FRAME);

interface Harness {
	store: StateStore;
	baseUrl: string;
	server: http.Server;
	sendKeys: ReturnType<typeof vi.fn>;
	setCapture: (r: CaptureResult | CaptureError) => void;
	setPendingGate: (fn: () => boolean) => void;
}

async function boot(
	over: Partial<StuckRemanageRouterOptions> = {},
): Promise<Harness> {
	const store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-1",
		project_name: "geo",
		status: "running",
		issue_labels: JSON.stringify(["Product"]),
	});

	let captureResult: CaptureResult | CaptureError = {
		output: STUCK_FRAME,
		tmux_target: "geo:@1",
		lines: 100,
		captured_at: "now",
	};
	let pendingGateFn: () => boolean = () => false;
	const sendKeys = vi.fn(async () => ({ sent: true }));

	const app = express();
	app.use(express.json());
	app.use(
		"/api/sessions",
		createStuckRemanageRouter({
			store,
			projects,
			captureSessionFn: async () => captureResult,
			hasPendingGate: () => pendingGateFn(),
			sendKeys,
			getTmuxTarget: () => ({ tmuxWindow: "geo:@1", sessionName: "geo" }),
			...over,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		store,
		server,
		baseUrl: `http://127.0.0.1:${port}`,
		sendKeys,
		setCapture: (r) => {
			captureResult = r;
		},
		setPendingGate: (fn) => {
			pendingGateFn = fn;
		},
	};
}

async function post(
	h: Harness,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${h.baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

function nudgeAudits(h: Harness) {
	return h.store
		.getEventsByExecution("exec-1")
		.filter((e) => e.event_type === "runner_recovery_nudge");
}

let h: Harness;

beforeEach(async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	h = await boot();
});

afterEach(async () => {
	await new Promise<void>((resolve, reject) =>
		h.server.close((err) => (err ? reject(err) : resolve())),
	);
	h.store.close();
	vi.restoreAllMocks();
});

describe("POST /:executionId/stuck-disposition (plan §3.4)", () => {
	const valid = {
		leadId: "product-lead",
		episode_fingerprint: STUCK_FP,
		disposition: "false_positive",
		note: "long compile",
	};

	it("writes the disposition + audit event", async () => {
		const r = await post(h, "/api/sessions/exec-1/stuck-disposition", valid);
		expect(r.status).toBe(200);
		const row = h.store.getStuckDisposition("exec-1", STUCK_FP);
		expect(row?.disposition).toBe("false_positive");
		expect(row?.noted_by).toBe("product-lead");
		const audits = h.store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "stuck_disposition_set");
		expect(audits).toHaveLength(1);
	});

	it("400 without leadId", async () => {
		const { leadId: _l, ...rest } = valid;
		const r = await post(h, "/api/sessions/exec-1/stuck-disposition", rest);
		expect(r.status).toBe(400);
	});

	it("400 on malformed fingerprint", async () => {
		const r = await post(h, "/api/sessions/exec-1/stuck-disposition", {
			...valid,
			episode_fingerprint: "not-a-fingerprint",
		});
		expect(r.status).toBe(400);
	});

	it("400 on handled_remanaged (implicit-only) and unknown values", async () => {
		for (const disposition of ["handled_remanaged", "lgtm", ""]) {
			const r = await post(h, "/api/sessions/exec-1/stuck-disposition", {
				...valid,
				disposition,
			});
			expect(r.status).toBe(400);
		}
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)).toBeUndefined();
	});

	it("snooze requires a future snooze_until_ms", async () => {
		const bad = await post(h, "/api/sessions/exec-1/stuck-disposition", {
			...valid,
			disposition: "snooze",
		});
		expect(bad.status).toBe(400);
		const past = await post(h, "/api/sessions/exec-1/stuck-disposition", {
			...valid,
			disposition: "snooze",
			snooze_until_ms: 1,
		});
		expect(past.status).toBe(400);
		const ok = await post(h, "/api/sessions/exec-1/stuck-disposition", {
			...valid,
			disposition: "snooze",
			snooze_until_ms: Date.now() + 60_000,
		});
		expect(ok.status).toBe(200);
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)?.disposition).toBe(
			"snooze",
		);
	});

	it("404 for an unknown session", async () => {
		const r = await post(h, "/api/sessions/nope/stuck-disposition", valid);
		expect(r.status).toBe(404);
	});

	it("403 for an out-of-scope lead", async () => {
		const r = await post(h, "/api/sessions/exec-1/stuck-disposition", {
			...valid,
			leadId: "ops-lead",
		});
		expect(r.status).toBe(403);
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)).toBeUndefined();
	});
});

describe("POST /:executionId/recovery-nudge (plan §3.5 — restricted primitive)", () => {
	const valid = {
		leadId: "product-lead",
		episode_fingerprint: STUCK_FP,
	};

	it("sends the allowlisted phrase when ALL gates pass; records implicit handled_remanaged + audit", async () => {
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(200);
		expect(r.json.nudged).toBe(true);
		expect(h.sendKeys).toHaveBeenCalledWith("geo:@1", "continue");
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)?.disposition).toBe(
			"handled_remanaged",
		);
		// Two-phase audit (Codex PR R1 MEDIUM-1): durable "attempt" BEFORE the
		// keystroke, "sent" after.
		const audits = nudgeAudits(h);
		expect(audits.map((a) => (a.payload as { result: string }).result)).toEqual(
			["attempt", "sent"],
		);
	});

	it("MEDIUM-1: audit store down on a refusal path → 503, refusal not silently degraded", async () => {
		vi.spyOn(h.store, "insertEvent").mockImplementation(() => {
			throw new Error("disk full");
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", {
			...valid,
			phrase: "ship it",
		});
		expect(r.status).toBe(503);
		expect(String(r.json.error)).toContain("audit store unavailable");
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("MEDIUM-1: audit store down with ALL gates passing → 503 and NO keystroke is sent", async () => {
		vi.spyOn(h.store, "insertEvent").mockImplementation(() => {
			throw new Error("disk full");
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(503);
		expect(String(r.json.error)).toContain("no keystroke sent");
		expect(h.sendKeys).not.toHaveBeenCalled();
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)).toBeUndefined();
	});

	it("disposition write failure AFTER a sent nudge → 200 with warning (nudge already out, fails safe)", async () => {
		vi.spyOn(h.store, "setStuckDisposition").mockImplementation(() => {
			throw new Error("db locked");
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(200);
		expect(r.json.nudged).toBe(true);
		expect(String(r.json.warning)).toContain("handled_remanaged");
		expect(h.sendKeys).toHaveBeenCalledTimes(1);
		// trail still complete: attempt + sent
		expect(
			nudgeAudits(h).map((a) => (a.payload as { result: string }).result),
		).toEqual(["attempt", "sent"]);
	});

	it("refuses any phrase outside the allowlist (audited)", async () => {
		expect(NUDGE_ALLOWLIST).toEqual(["continue"]);
		for (const phrase of [
			"continue\napprove",
			"ship it",
			"yes",
			"continue ",
			"CONTINUE",
		]) {
			const r = await post(h, "/api/sessions/exec-1/recovery-nudge", {
				...valid,
				phrase,
			});
			expect(r.status).toBe(400);
		}
		expect(h.sendKeys).not.toHaveBeenCalled();
		expect(nudgeAudits(h).length).toBe(5);
	});

	it("refuses when status is not running (FLY-191 review states protected)", async () => {
		for (const status of ["awaiting_review", "approved_to_ship", "completed"]) {
			h.store.upsertSession({
				execution_id: "exec-1",
				issue_id: "FLY-1",
				project_name: "geo",
				status,
			});
			const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
			expect(r.status).toBe(409);
		}
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("refuses on the needs_review gray zone", async () => {
		h.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1",
			project_name: "geo",
			status: "running",
			decision_route: "needs_review",
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(409);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("refuses when a gate question is pending; fails CLOSED on probe error", async () => {
		h.setPendingGate(() => true);
		const r1 = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r1.status).toBe(409);
		h.setPendingGate(() => {
			throw new Error("commdb locked");
		});
		const r2 = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r2.status).toBe(503);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("refuses fail-closed when the live capture errors", async () => {
		h.setCapture({ error: "tmux window not found", status: 502 });
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(503);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("refuses when the live output no longer matches the episode fingerprint", async () => {
		h.setCapture({
			output: `${STUCK_FRAME}\n⎿ resumed work...`,
			tmux_target: "geo:@1",
			lines: 100,
			captured_at: "now",
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(409);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("refuses when no idle input box is visible (fingerprint matches a non-prompt frame)", async () => {
		const noBox = "⎿ Running tests...\n  PASS 12/12";
		h.setCapture({
			output: noBox,
			tmux_target: "geo:@1",
			lines: 100,
			captured_at: "now",
		});
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", {
			...valid,
			episode_fingerprint: fingerprintOutput(noBox),
		});
		expect(r.status).toBe(409);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("403 for an out-of-scope lead (audited refusal)", async () => {
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", {
			...valid,
			leadId: "ops-lead",
		});
		expect(r.status).toBe(403);
		expect(h.sendKeys).not.toHaveBeenCalled();
	});

	it("502 when tmux send fails — no handled_remanaged is recorded", async () => {
		h.sendKeys.mockResolvedValueOnce({ sent: false, error: "no server" });
		const r = await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		expect(r.status).toBe(502);
		expect(h.store.getStuckDisposition("exec-1", STUCK_FP)).toBeUndefined();
		const audits = nudgeAudits(h);
		expect((audits.at(-1)!.payload as { result: string }).result).toBe(
			"refused",
		);
	});

	it("404 for an unknown session", async () => {
		const r = await post(h, "/api/sessions/ghost/recovery-nudge", valid);
		expect(r.status).toBe(404);
	});

	it("every refusal leaves an audit row (HIGH-2)", async () => {
		await post(h, "/api/sessions/exec-1/recovery-nudge", {
			...valid,
			phrase: "rm -rf /",
		});
		h.setPendingGate(() => true);
		await post(h, "/api/sessions/exec-1/recovery-nudge", valid);
		const audits = nudgeAudits(h);
		expect(audits.length).toBe(2);
		for (const a of audits) {
			expect((a.payload as { result: string }).result).toBe("refused");
		}
	});
});

describe("auth wiring", () => {
	it("applies the injected auth middleware to both routes", async () => {
		const denied: express.RequestHandler = (_req, res) => {
			res.status(401).json({ error: "nope" });
		};
		const h2 = await boot({ auth: denied });
		try {
			const r1 = await post(h2, "/api/sessions/exec-1/stuck-disposition", {
				leadId: "product-lead",
				episode_fingerprint: STUCK_FP,
				disposition: "false_positive",
			});
			const r2 = await post(h2, "/api/sessions/exec-1/recovery-nudge", {
				leadId: "product-lead",
				episode_fingerprint: STUCK_FP,
			});
			expect(r1.status).toBe(401);
			expect(r2.status).toBe(401);
			expect(h2.sendKeys).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) =>
				h2.server.close((err) => (err ? reject(err) : resolve())),
			);
			h2.store.close();
		}
	});
});
