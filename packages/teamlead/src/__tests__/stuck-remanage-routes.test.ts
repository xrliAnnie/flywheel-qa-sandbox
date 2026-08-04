/**
 * Tests for scoped detection acknowledgements and the restricted recovery nudge.
 * Every nudge refusal remains audited.
 */

import type http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintOutput } from "../bridge/pane-fingerprint.js";
import type { CaptureError, CaptureResult } from "../bridge/session-capture.js";
import {
	createLeadDetectionAckRouter,
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
	app.use(
		"/api/leads",
		createLeadDetectionAckRouter({
			store,
			projects,
			auth: over.auth,
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
	it("applies the injected auth middleware to retained session routes", async () => {
		const denied: express.RequestHandler = (_req, res) => {
			res.status(401).json({ error: "nope" });
		};
		const h2 = await boot({ auth: denied });
		try {
			const nudge = await post(h2, "/api/sessions/exec-1/recovery-nudge", {
				leadId: "product-lead",
				episode_fingerprint: STUCK_FP,
			});
			const ack = await post(h2, "/api/sessions/exec-1/detection-ack", {
				leadId: "product-lead",
				kind: "detection_stuck_confirmed",
				episode_fingerprint: "fp",
				disposition: "ack",
			});
			expect(nudge.status).toBe(401);
			expect(ack.status).toBe(401);
			expect(h2.sendKeys).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) =>
				h2.server.close((err) => (err ? reject(err) : resolve())),
			);
			h2.store.close();
		}
	});
});

/**
 * FLY-1048 PR-C (C3-w): the detection-escalation ACK endpoint — the Lead's
 * disposition receipt for a UNIFIED-flow episode. The authorization invariant
 * (Codex R1 #3 of the 1073 continuation plan) is that this route reuses the
 * session-route checks — route auth middleware, leadId required,
 * session existence, matchesLead owner/scope — before any detection row is
 * written; it must never become a parallel weakly-authenticated endpoint.
 */
describe("POST /:executionId/detection-ack (FLY-1048 C3-w)", () => {
	const KIND = "detection_stuck_confirmed";
	const FP = "fp:episode-1";

	async function closeH(h2: Awaited<ReturnType<typeof boot>>) {
		await new Promise<void>((resolve, reject) =>
			h2.server.close((err) => (err ? reject(err) : resolve())),
		);
		h2.store.close();
	}

	function seedEpisode(
		store: StateStore,
		targetKey = "exec-1",
		fingerprint = FP,
		sourceReceiptId?: string,
	): void {
		store.upsertDetectionEscalation({
			targetKey,
			kind: KIND,
			episodeFingerprint: fingerprint,
			issueId: "FLY-1",
			ownerLeadId: "product-lead",
			firstDetectedAtMs: 0,
			sourceReceiptId,
		});
		store.markDetectionEscalationLeadNotified(
			targetKey,
			KIND,
			fingerprint,
			1_000,
		);
	}

	const valid = {
		leadId: "product-lead",
		kind: KIND,
		episode_fingerprint: FP,
		disposition: "ack",
	};

	it("is mounted BEHIND the router auth middleware", async () => {
		const authed = await boot({
			auth: (_req, res) => {
				res.status(401).json({ error: "unauthorized" });
			},
		});
		try {
			seedEpisode(authed.store);
			const r = await post(authed, "/api/sessions/exec-1/detection-ack", valid);
			expect(r.status).toBe(401);
			expect(
				authed.store.getDetectionEscalation("exec-1", KIND, FP)?.status,
			).toBe("LEAD_NOTIFIED");
		} finally {
			await closeH(authed);
		}
	});

	it("400 when leadId is missing", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			leadId: "",
		});
		expect(r.status).toBe(400);
	});

	it("400 when kind is missing", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			kind: "",
		});
		expect(r.status).toBe(400);
	});

	it("400 when episode_fingerprint is missing", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			episode_fingerprint: "",
		});
		expect(r.status).toBe(400);
		expect(r.json.error).toBe(
			"episode_fingerprint is required (from the detection_escalation event)",
		);
	});

	it("closes an oversized legacy fingerprint instead of stranding the episode", async () => {
		const oversized = `receipt-chain:${"x".repeat(240)}`;
		seedEpisode(h.store, "exec-1", oversized);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			episode_fingerprint: oversized,
		});

		expect(r.status).toBe(200);
		expect(
			h.store.getDetectionEscalation("exec-1", KIND, oversized)?.status,
		).toBe("ACKED");
		const audit = h.store
			.getEventsByExecution("exec-1")
			.find((event) => event.event_type === "detection_escalation_disposition");
		expect((audit?.payload as { fingerprint?: string }).fingerprint).toMatch(
			/^sha256:[a-f0-9]{64}$/,
		);
	});

	it("reports an unmatched oversized fingerprint as too long, not missing", async () => {
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			episode_fingerprint: "x".repeat(240),
		});

		expect(r.status).toBe(404);
		expect(r.json.error).toMatch(/too long/i);
		expect(r.json.error).not.toMatch(/required/i);
	});

	it("400 on an unknown disposition", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			disposition: "snooze",
		});
		expect(r.status).toBe(400);
	});

	it("404 when the session does not exist", async () => {
		const r = await post(h, "/api/sessions/ghost-exec/detection-ack", valid);
		expect(r.status).toBe(404);
	});

	it("403 when the session is outside the lead's scope", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			leadId: "some-other-lead",
		});
		expect(r.status).toBe(403);
		expect(h.store.getDetectionEscalation("exec-1", KIND, FP)?.status).toBe(
			"LEAD_NOTIFIED",
		);
	});

	it("404 when no matching detection episode row exists", async () => {
		const r = await post(h, "/api/sessions/exec-1/detection-ack", valid);
		expect(r.status).toBe(404);
	});

	it("ack → ACKED with lead_ack_at_ms stamped + an audit trace row", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", valid);
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, status: "ACKED" });
		const row = h.store.getDetectionEscalation("exec-1", KIND, FP)!;
		expect(row.status).toBe("ACKED");
		expect(row.lead_ack_at_ms).not.toBeNull();
		const audits = h.store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "detection_escalation_disposition");
		expect(audits).toHaveLength(1);
	});

	it("resolve → RESOLVED", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			disposition: "resolve",
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, status: "RESOLVED" });
		expect(h.store.getDetectionEscalation("exec-1", KIND, FP)?.status).toBe(
			"RESOLVED",
		);
	});

	it("dismiss → RESOLVED", async () => {
		seedEpisode(h.store);
		const r = await post(h, "/api/sessions/exec-1/detection-ack", {
			...valid,
			disposition: "dismiss",
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ok: true, status: "RESOLVED" });
	});
});

describe("POST /api/leads/:leadId/detection-ack (FLY-1448)", () => {
	const KIND = "receipt_unprocessed";
	const FP = "receipt-root-1";
	const valid = {
		projectName: "geo",
		kind: KIND,
		episode_fingerprint: FP,
		disposition: "ack",
	};

	function seedLeadEpisode(
		targetKey = "geo:product-lead",
		ownerLeadId: string | null = "product-lead",
		fingerprint = FP,
		sourceReceiptId?: string,
	): void {
		h.store.upsertDetectionEscalation({
			targetKey,
			kind: KIND,
			episodeFingerprint: fingerprint,
			issueId: "FLY-1",
			ownerLeadId,
			firstDetectedAtMs: 1_000,
			sourceReceiptId,
		});
		h.store.markDetectionEscalationLeadNotified(
			targetKey,
			KIND,
			fingerprint,
			2_000,
		);
	}

	it("derives the target server-side and atomically prepares the disposition receipt", async () => {
		seedLeadEpisode();
		const r = await post(h, "/api/leads/product-lead/detection-ack", valid);

		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			ok: true,
			status: "ACKED",
			receiptPrepared: true,
		});
		expect(
			h.store.getDetectionEscalation("geo:product-lead", KIND, FP)?.status,
		).toBe("ACKED");
	});

	it("round-trips a bounded parent receipt id to close an oversized fingerprint", async () => {
		const oversized = `receipt-chain:${"x".repeat(240)}`;
		const parentId = "receipt-parent-1";
		seedLeadEpisode("geo:product-lead", "product-lead", oversized, parentId);

		const r = await post(h, "/api/leads/product-lead/detection-ack", {
			...valid,
			episode_fingerprint: parentId,
		});

		expect(r.status).toBe(200);
		expect(
			h.store.getDetectionEscalation("geo:product-lead", KIND, oversized)
				?.status,
		).toBe("ACKED");
	});

	it("rejects raw target injection and cross-project/cross-lead attempts", async () => {
		seedLeadEpisode();
		const raw = await post(h, "/api/leads/product-lead/detection-ack", {
			...valid,
			target_key: "other:product-lead",
		});
		const project = await post(h, "/api/leads/product-lead/detection-ack", {
			...valid,
			projectName: "other",
		});
		const lead = await post(h, "/api/leads/other-lead/detection-ack", valid);

		expect(raw.status).toBe(400);
		expect(project.status).not.toBe(200);
		expect(lead.status).not.toBe(200);
		expect(
			h.store.getDetectionEscalation("geo:product-lead", KIND, FP)?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("fails closed on a missing or conflicting owner", async () => {
		seedLeadEpisode("geo:product-lead", null);
		const missing = await post(
			h,
			"/api/leads/product-lead/detection-ack",
			valid,
		);
		expect(missing.status).toBe(403);

		const conflictingFingerprint = "receipt-root-2";
		seedLeadEpisode("geo:product-lead", "other-lead", conflictingFingerprint);
		const conflict = await post(h, "/api/leads/product-lead/detection-ack", {
			...valid,
			episode_fingerprint: conflictingFingerprint,
		});
		expect(conflict.status).toBe(403);
	});
});

/**
 * FLY-1048 PR-C (C4a): bidirectional ACK/resolution mirror between the OLD
 * stuck_dispositions receipts and the NEW detection_escalations episodes.
 *
 * detection_escalations is the single source of truth; stuck_dispositions
 * stays a compatible read/write view. The mirror is deliberately scoped to
 * the case-c kind (detection_stuck_confirmed) — gap/delivery kinds have their
 * own detection-ack lifecycle and are NOT what a stuck receipt describes.
 * Mirror failures must never fail the request (trace-row posture).
 */
