/**
 * FLY-245 F-a — LifecycleOrchestrator: the end-to-end glue binding the Phase D
 * primitives (D-b claim, D-c verify, D-e founder observation, D-f state
 * machine, D2 retry pre-binding) into the §5.6 flow:
 *
 *   request → CommDB question (binding+TTL) + durable store row + Discord
 *   confirmation → founder reaction/token observed (exact id) → gateway writes
 *   the STRUCTURED response (the irreversible authorization edge) → verify →
 *   atomic claim → revision re-check → dispatch → message edited, poll stops.
 *
 * Every Discord/Bridge/DB surface is injected; real bindings live in
 * gateway-main (Phase F-b). The model can only reach `createRequest` — the
 * execute path runs strictly behind the founder-confirmation edge.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LifecycleOrchestrator,
	type LifecycleOrchestratorDeps,
	type ResolvedLifecycleTarget,
} from "../lifecycle-orchestrator.js";
import { LifecycleRequestStore } from "../lifecycle-requests.js";

const FOUNDER = "annie-discord-987";
const LEAD = "product-lead";
const CHAN = "chan-1";

let dir: string;
let store: LifecycleRequestStore;
let nowMs: number;

const TARGET: ResolvedLifecycleTarget = {
	execId: "exec-1",
	issueId: "FLY-9",
	role: "main",
	status: "awaiting_review",
	revision: 3,
	project: "geoforge3d",
};

interface Harness {
	orch: LifecycleOrchestrator;
	deps: {
		insertQuestion: ReturnType<typeof vi.fn>;
		insertResponse: ReturnType<typeof vi.fn>;
		claimConsent: ReturnType<typeof vi.fn>;
		getResponse: ReturnType<typeof vi.fn>;
		verify: ReturnType<typeof vi.fn>;
		currentRevision: ReturnType<typeof vi.fn>;
		sendConfirmation: ReturnType<typeof vi.fn>;
		editMessage: ReturnType<typeof vi.fn>;
		checkReaction: ReturnType<typeof vi.fn>;
		fetchRecentMessages: ReturnType<typeof vi.fn>;
		dispatch: ReturnType<typeof vi.fn>;
		postcondition: ReturnType<typeof vi.fn>;
	};
}

function makeHarness(
	overrides: Partial<Harness["deps"]> = {},
	idSeed = 0,
): Harness {
	let n = idSeed;
	const deps = {
		insertQuestion: vi.fn(() => `q-${++n}`),
		insertResponse: vi.fn(),
		claimConsent: vi.fn(() => true),
		getResponse: vi.fn(() => undefined),
		verify: vi.fn(() => ({ allowed: true, reason: "approved" })),
		currentRevision: vi.fn(() => 3),
		sendConfirmation: vi.fn(async () => ({
			channelId: CHAN,
			messageId: `msg-${++n}`,
		})),
		editMessage: vi.fn(async () => {}),
		checkReaction: vi.fn(async () => ({
			confirmed: false,
			reason: "not_yet" as const,
		})),
		fetchRecentMessages: vi.fn(async () => []),
		dispatch: vi.fn(async () => ({ kind: "success" as const })),
		postcondition: vi.fn(async () => "needs_reconfirm" as const),
		...overrides,
	};
	const orchDeps: LifecycleOrchestratorDeps = {
		store,
		founderId: FOUNDER,
		leadId: LEAD,
		ttlMs: 600_000,
		now: () => nowMs,
		ids: { requestId: () => `req-${++n}`, nonce: () => `nonce-${++n}` },
		newSuccessorExecId: () => `succ-${++n}`,
		comm: {
			insertQuestion: deps.insertQuestion,
			insertResponse: deps.insertResponse,
			claimConsent: deps.claimConsent,
			getResponse: deps.getResponse,
		},
		verify: deps.verify,
		currentRevision: deps.currentRevision,
		discord: {
			sendConfirmation: deps.sendConfirmation,
			editMessage: deps.editMessage,
			checkReaction: deps.checkReaction,
			fetchRecentMessages: deps.fetchRecentMessages,
		},
		dispatch: deps.dispatch,
		postcondition: deps.postcondition,
	};
	return { orch: new LifecycleOrchestrator(orchDeps), deps };
}

beforeEach(() => {
	nowMs = 1_000_000;
	dir = mkdtempSync(join(tmpdir(), "fly245-orch-"));
	store = new LifecycleRequestStore(join(dir, "lr.db"), () => nowMs);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("createRequest (F-a)", () => {
	it("registers the CommDB question (checkpoint + binding JSON + TTL), the store row, and the confirmation message", async () => {
		const { orch, deps } = makeHarness();
		const { requestId } = await orch.createRequest(TARGET, "terminate");

		// CommDB question: lead → founder, runner_lifecycle checkpoint, full binding.
		expect(deps.insertQuestion).toHaveBeenCalledTimes(1);
		const [from, to, content, opts] = deps.insertQuestion.mock.calls[0] as [
			string,
			string,
			string,
			{ checkpoint: string; ttlSeconds: number },
		];
		expect(from).toBe(LEAD);
		expect(to).toBe(FOUNDER);
		expect(opts.checkpoint).toBe("runner_lifecycle:terminate");
		expect(opts.ttlSeconds).toBe(600);
		const binding = JSON.parse(content);
		expect(binding.target_execution_id).toBe("exec-1");
		expect(binding.action).toBe("terminate");
		expect(binding.lifecycle_revision).toBe(3);
		expect(binding.project).toBe("geoforge3d");
		expect(typeof binding.nonce).toBe("string");

		// Durable row, message ids persisted (§5.6 restart-resume contract).
		const row = store.get(requestId);
		expect(row?.state).toBe("requested");
		expect(row?.questionId).toMatch(/^q-/);
		expect(row?.channelId).toBe(CHAN);
		expect(row?.messageId).toMatch(/^msg-/);
		expect(row?.nonce).toBe(binding.nonce);

		// Confirmation text shows the full target (plan §5.4) + both confirm paths.
		const text = (deps.sendConfirmation.mock.calls[0] as [string])[0];
		expect(text).toContain("FLY-9");
		expect(text).toContain("exec-1");
		expect(text).toContain("terminate");
		expect(text).toContain("revision 3");
		expect(text).toContain(`confirm ${binding.nonce}`);
	});

	it("retry requests PRE-BIND the successor execution id (D2, before any dispatch)", async () => {
		const { orch } = makeHarness();
		const { requestId } = await orch.createRequest(
			{ ...TARGET, status: "failed" },
			"retry",
		);
		expect(store.get(requestId)?.successorExecId).toMatch(/^succ-/);
	});

	it("non-lifecycle actions are refused (ship-gate actions never enter this path)", async () => {
		const { orch } = makeHarness();
		await expect(orch.createRequest(TARGET, "approve")).rejects.toThrow(
			/not a .*lifecycle/i,
		);
		await expect(orch.createRequest(TARGET, "frobnicate")).rejects.toThrow();
	});

	it("ineligible target status is refused (SSOT eligibleStatuses)", async () => {
		const { orch } = makeHarness();
		await expect(
			orch.createRequest({ ...TARGET, status: "running" }, "reject"),
		).rejects.toThrow(/status/i);
	});
});

describe("observeOnce — founder confirmation edge (F-a)", () => {
	it("reaction confirmed → structured response WRITTEN AS the founder id → verify+claim+dispatch → succeeded + message edited", async () => {
		const { orch, deps } = makeHarness({
			checkReaction: vi.fn(async () => ({
				confirmed: true,
				reason: "confirmed" as const,
			})),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		await orch.observeOnce();

		// the irreversible authorization edge: gateway writes the structured
		// response with from_agent = founder (D-c contract).
		expect(deps.insertResponse).toHaveBeenCalledTimes(1);
		const [parentId, fromAgent, content] = deps.insertResponse.mock
			.calls[0] as [string, string, string];
		expect(parentId).toBe(store.get(requestId)?.questionId);
		expect(fromAgent).toBe(FOUNDER);
		const resp = JSON.parse(content);
		expect(resp).toEqual({
			approved: true,
			action: "terminate",
			execId: "exec-1",
			revision: 3,
		});

		// full execute chain ran in order behind the edge
		expect(deps.verify).toHaveBeenCalledTimes(1);
		expect(deps.claimConsent).toHaveBeenCalledTimes(1);
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
		expect(store.get(requestId)?.state).toBe("succeeded");
		// terminal outcome edited into the confirmation message
		expect(deps.editMessage).toHaveBeenCalled();
		const editText = deps.editMessage.mock.calls.at(-1)?.[2] as string;
		expect(editText).toMatch(/executed/i);
	});

	// Codex code-review R1 MED-9: crash AFTER writing the founder response but
	// BEFORE flipping the row to `confirmed` left a durable response + a
	// `requested` row. Recovery must LATCH on the existing response, even if the
	// founder un-reacted in the meantime (the edge is irreversible), and must NOT
	// double-write (unique-response constraint would wedge the row).
	it("MED-9: latches on an existing durable response even after an un-react (no re-insert)", async () => {
		const existing = {
			from_agent: FOUNDER,
			content: JSON.stringify({
				approved: true,
				action: "terminate",
				execId: "exec-1",
				revision: 3,
			}),
		};
		const { orch, deps } = makeHarness({
			// the reaction is GONE now (un-react after the crash) — must not matter
			checkReaction: vi.fn(async () => ({
				confirmed: false,
				reason: "not_yet" as const,
			})),
			fetchRecentMessages: vi.fn(async () => []),
			getResponse: vi.fn(() => existing),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		await orch.observeOnce();

		// latched → executed via the normal verify/claim/dispatch chain
		expect(deps.verify).toHaveBeenCalledTimes(1);
		expect(deps.claimConsent).toHaveBeenCalledTimes(1);
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
		expect(store.get(requestId)?.state).toBe("succeeded");
		// idempotent: the durable response is NOT written a second time
		expect(deps.insertResponse).not.toHaveBeenCalled();
	});

	it("not-yet / http_error / rate_limited are all NON-approval — row stays requested, nothing written", async () => {
		for (const reason of ["not_yet", "http_error", "rate_limited"] as const) {
			const { orch, deps } = makeHarness({
				checkReaction: vi.fn(async () => ({ confirmed: false, reason })),
			});
			const { requestId } = await orch.createRequest(TARGET, "terminate");
			await orch.observeOnce();
			expect(store.get(requestId)?.state).toBe("requested");
			expect(deps.insertResponse).not.toHaveBeenCalled();
			expect(deps.dispatch).not.toHaveBeenCalled();
			store.close();
			rmSync(dir, { recursive: true, force: true });
			dir = mkdtempSync(join(tmpdir(), "fly245-orch-"));
			store = new LifecycleRequestStore(join(dir, "lr.db"), () => nowMs);
		}
	});

	it("founder token reply `confirm <nonce>` confirms (exact author + channel + nonce)", async () => {
		const harness = makeHarness();
		const { orch, deps } = harness;
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		const nonce = store.get(requestId)?.nonce as string;
		deps.fetchRecentMessages.mockResolvedValue([
			{ text: `confirm ${nonce}`, authorId: FOUNDER, channelId: CHAN },
		]);
		await orch.observeOnce();
		expect(store.get(requestId)?.state).toBe("succeeded");
	});

	it("a NON-founder token reply never confirms", async () => {
		const { orch, deps } = makeHarness();
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		const nonce = store.get(requestId)?.nonce as string;
		deps.fetchRecentMessages.mockResolvedValue([
			{ text: `confirm ${nonce}`, authorId: "impostor", channelId: CHAN },
		]);
		await orch.observeOnce();
		expect(store.get(requestId)?.state).toBe("requested");
		expect(deps.dispatch).not.toHaveBeenCalled();
	});

	it("expired requested rows die (failed_retryable/expired) and the message is edited", async () => {
		const { orch, deps } = makeHarness();
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		nowMs += 600_001;
		await orch.observeOnce();
		expect(store.get(requestId)?.state).toBe("failed_retryable");
		expect(store.get(requestId)?.outcome).toBe("expired");
		expect(deps.editMessage).toHaveBeenCalled();
	});

	it("verify denial behind the edge fail-closes (no dispatch), message edited", async () => {
		const { orch, deps } = makeHarness({
			checkReaction: vi.fn(async () => ({
				confirmed: true,
				reason: "confirmed" as const,
			})),
			verify: vi.fn(() => ({ allowed: false, reason: "revision_stale" })),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		await orch.observeOnce();
		expect(store.get(requestId)?.state).toBe("failed_retryable");
		expect(deps.dispatch).not.toHaveBeenCalled();
	});

	it("terminal rows are not re-observed (poll stops; un-react can never revoke)", async () => {
		const checkReaction = vi.fn(async () => ({
			confirmed: true,
			reason: "confirmed" as const,
		}));
		const { orch, deps } = makeHarness({ checkReaction });
		await orch.createRequest(TARGET, "terminate");
		await orch.observeOnce();
		const callsAfterFirst = checkReaction.mock.calls.length;
		await orch.observeOnce(); // founder un-reacts / anything — irrelevant now
		expect(checkReaction.mock.calls.length).toBe(callsAfterFirst);
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
	});
});

describe("recover (F-a restart)", () => {
	it("resume_execute rows are driven to completion", async () => {
		const { orch, deps } = makeHarness({
			checkReaction: vi.fn(async () => ({
				confirmed: true,
				reason: "confirmed" as const,
			})),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		// simulate: confirmed persisted, then crash before execute
		store.transition(requestId, "requested", "confirmed");
		await orch.recover();
		expect(store.get(requestId)?.state).toBe("succeeded");
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it("retry_safe_reexecute rows re-drive WITHOUT a second claim", async () => {
		const { orch, deps } = makeHarness({
			postcondition: vi.fn(async () => "retry_safe" as const),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		store.transition(requestId, "requested", "confirmed");
		store.transition(requestId, "confirmed", "claimed");
		await orch.recover();
		expect(store.get(requestId)?.state).toBe("succeeded");
		expect(deps.claimConsent).not.toHaveBeenCalled(); // claim already consumed
		expect(deps.dispatch).toHaveBeenCalledTimes(1);
	});

	it("resend_confirmation rows get a fresh message with persisted ids", async () => {
		const { orch, deps } = makeHarness();
		// a row whose confirmation message was never durably sent
		store.create({
			requestId: "req-x",
			questionId: "q-x",
			action: "terminate",
			execId: "exec-1",
			lifecycleRevision: 3,
			nonce: "nonce-x",
			project: "geoforge3d",
			leadId: LEAD,
			ttlMs: 600_000,
		});
		await orch.recover();
		expect(deps.sendConfirmation).toHaveBeenCalledTimes(1);
		expect(store.get("req-x")?.messageId).toBeTruthy();
	});

	it("needs_reconfirm rows stay parked (never auto-replayed), message edited best-effort", async () => {
		const { orch, deps } = makeHarness({
			postcondition: vi.fn(async () => "needs_reconfirm" as const),
		});
		const { requestId } = await orch.createRequest(TARGET, "terminate");
		store.transition(requestId, "requested", "confirmed");
		store.transition(requestId, "confirmed", "claimed");
		await orch.recover();
		expect(store.get(requestId)?.state).toBe("ambiguous");
		expect(deps.dispatch).not.toHaveBeenCalled();
	});
});
