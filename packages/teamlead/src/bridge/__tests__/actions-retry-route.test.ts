/**
 * FLY-245 D2 — route-level wiring of the gateway pre-bound retry dispatch
 * (plan §5.2.1) through POST /api/actions/retry:
 *   - boundary validation: gateway_request_id + successor_execution_id are
 *     both-or-neither, format-checked at the system boundary;
 *   - first attempt: the intent WAL is committed BEFORE dispatch (a dispatcher
 *     crash leaves the durable binding — the §8 D2 ② window);
 *   - replay without started evidence: re-drives with the SAME successor id;
 *   - binding conflict: rejected without any dispatch;
 *   - legacy requests (no gateway fields): byte-compatible behavior.
 * (The started-evidence convergence verdicts themselves are unit-tested in
 * retry-dispatch-wal.test.ts / started-evidence.test.ts; real-machine
 * convergence is §8.1 QA8.)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createActionRouter } from "../actions.js";
import type { IRetryDispatcher, RetryRequest } from "../retry-dispatcher.js";

let store: StateStore;
let server: Server;
let baseUrl: string;
let dispatched: RetryRequest[];
let dispatchImpl: (req: RetryRequest) => Promise<{ newExecutionId: string }>;

function makeStubDispatcher(): IRetryDispatcher {
	return {
		dispatch: vi.fn(async (req: RetryRequest) => {
			dispatched.push(req);
			const { newExecutionId } = await dispatchImpl(req);
			return { newExecutionId, oldExecutionId: req.oldExecutionId };
		}),
		getInflightIssues: () => new Set<string>(),
		hasInflightForRole: () => false,
		stopAccepting: () => {},
		drain: async () => {},
		teardownRuntimes: async () => {},
	};
}

async function postRetry(body: Record<string, unknown>) {
	const res = await fetch(`${baseUrl}/api/actions/retry`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

beforeEach(async () => {
	store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "pred-1",
		issue_id: "issue-1",
		project_name: "fly245-d2-route-test",
		status: "failed",
	});
	dispatched = [];
	dispatchImpl = async (req) => {
		const id = req.successorExecutionId ?? `gen-${dispatched.length}`;
		// Simulate Blueprint creating the successor row (waitForSession target).
		store.upsertSession({
			execution_id: id,
			issue_id: req.issueId,
			project_name: req.projectName,
			status: "running",
		});
		return { newExecutionId: id };
	};
	delete process.env.LINEAR_API_KEY;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const app = express();
	app.use(express.json());
	app.use(
		"/api/actions",
		createActionRouter(store, [], undefined, undefined, makeStubDispatcher()),
	);
	server = createServer(app);
	await new Promise<void>((res) => server.listen(0, res));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((res, rej) =>
		server.close((e) => (e ? rej(e) : res())),
	);
	vi.restoreAllMocks();
});

describe("POST /api/actions/retry — D2 boundary validation", () => {
	it("400 when gateway_request_id is sent without successor_execution_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 when successor_execution_id is sent without gateway_request_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			successor_execution_id: "11111111-2222-3333-4444-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 on a malformed successor_execution_id (boundary format check)", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
			successor_execution_id: "../etc/passwd",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 on a non-string gateway_request_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: 42,
			successor_execution_id: "11111111-2222-3333-4444-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});
});

describe("POST /api/actions/retry — D2 pre-bound dispatch flow", () => {
	const SUCC = "11111111-2222-3333-4444-555555555555";
	const gw = {
		gateway_request_id: "gwreq-12345",
		successor_execution_id: SUCC,
	};

	it("first attempt: WAL recorded, dispatcher receives the pre-bound id, lineage + dispatched persisted", async () => {
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
		expect(store.getRetryDispatchIntent("gwreq-12345")?.state).toBe(
			"dispatched",
		);
		expect(store.getSession("pred-1")?.retry_successor).toBe(SUCC);
	});

	it("② crash window: dispatcher throws AFTER the intent commit → failure response, but the durable binding survives in state=intent", async () => {
		dispatchImpl = async () => {
			throw new Error("bridge crashed mid-dispatch");
		};
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(400);
		const intent = store.getRetryDispatchIntent("gwreq-12345");
		expect(intent?.successor_execution_id).toBe(SUCC);
		expect(intent?.state).toBe("intent"); // never marked dispatched
	});

	it("replay with intent + no started evidence: re-drives with the SAME successor id", async () => {
		// the binding exists from a previous (crashed) attempt
		store.recordRetryDispatchIntent("gwreq-12345", SUCC, "pred-1");
		// default evidence checker: no CommDB for this project → no_row → re-drive
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
	});

	it("conflict: same request id with a different successor id → 400, dispatcher never called", async () => {
		store.recordRetryDispatchIntent("gwreq-12345", SUCC, "pred-1");
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
			successor_execution_id: "99999999-8888-7777-6666-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
		// binding unchanged
		expect(
			store.getRetryDispatchIntent("gwreq-12345")?.successor_execution_id,
		).toBe(SUCC);
	});

	it("legacy request (no gateway fields): dispatcher called WITHOUT a pre-bound id, no WAL row", async () => {
		const r = await postRetry({ execution_id: "pred-1" });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBeUndefined();
	});

	// Codex R2 MED-6: a POST-dispatch bookkeeping failure must NOT be reported as
	// a clean failure (the gateway would map the 4xx to `not_dispatched` and allow
	// a SECOND successor). Once dispatch() returns, the Runner is starting → the
	// response stays success with the bound successor id.
	it("MED-6: a post-dispatch StateStore error STILL reports success (dispatch already started)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(store, "setRetrySuccessor").mockImplementation(() => {
			throw new Error("state write blew up AFTER dispatch started");
		});
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200); // NOT a 4xx → gateway will not terminalize
		expect(r.json.success).toBe(true);
		expect(dispatched).toHaveLength(1); // the dispatch DID happen
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
	});

	it("MED-6: a PRE-dispatch failure still terminalizes cleanly (4xx, nothing started)", async () => {
		dispatchImpl = async () => {
			throw new Error("admission deferred — nothing started");
		};
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(400); // pre-dispatch → safe to terminalize
		expect(r.json.success).toBe(false);
	});
});

/**
 * FLY-887 R2 (Codex design R1 #2) — the retry matrix: PHASE-row retries stay
 * under the phase table.
 *
 * Discriminator = the durable `chat_thread_role` three-stage marker. Phase
 * rows: `dispatchModel` = resolvePhaseModel(role) UNCONDITIONALLY (never the
 * persisted `dispatch_model` — a pre-fix phase row may have persisted a sorter
 * pin or NULL, and replaying it would put the phase back on Sonnet) +
 * `ignoreRunnerLabelSelection: true` (a refreshed `sonnet`/vendor label cannot
 * bypass the table either — run-dispatcher previously hardcoded undefined).
 * Non-phase rows (`chat_thread_role='main'`, incl. auto-QA): byte-compatible.
 */
describe("POST /api/actions/retry — FLY-887 R2 phase-row model matrix", () => {
	it("a failed phase row (persisted phase model + sonnet label) retries on the phase table", async () => {
		store.upsertSession({
			execution_id: "phase-impl-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "implement",
			dispatch_model: "claude-fable-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "phase-impl-1" });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		// FLY-1224 (T4): the implement phase retries on the FULL codex triple —
		// never the persisted claude pin, never the sonnet label.
		expect(dispatched[0]?.dispatchModel).toBe("gpt-5.6-sol");
		expect(dispatched[0]?.dispatchVendor).toBe("codex");
		expect(dispatched[0]?.dispatchEffort).toBe("xhigh");
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBe(true);
		// FLY-1224 (R1 #1, settles FLY-840): a phase-row retry keeps its
		// shared-branch identity + phase sessionRole.
		expect(dispatched[0]?.shareParentBranch).toBe(true);
		expect(dispatched[0]?.sessionRole).toBe("implement");
	});

	it("FLY-1224 (R2 #3): a POLLUTED row (chat_thread_role=implement, session_role=main) retries as a PHASE", async () => {
		// An old/polluted row can carry the durable phase marker while its
		// session_role drifted to main. The retry must follow the DURABLE marker
		// for role + vendor + branch identity — otherwise the codex runner starts
		// in a non-phase identity on an independent branch.
		store.upsertSession({
			execution_id: "phase-impl-drift",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "implement",
			session_role: "main",
		});
		const r = await postRetry({ execution_id: "phase-impl-drift" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.sessionRole).toBe("implement");
		expect(dispatched[0]?.dispatchVendor).toBe("codex");
		expect(dispatched[0]?.shareParentBranch).toBe(true);
	});

	it("a LEGACY phase row (persisted sorter pin = sonnet) retries on the phase table, NOT the pin", async () => {
		// The pre-fix bug shape: a phase dispatched before FLY-887 R2 persisted
		// the sorter's pin. Replaying session.dispatch_model would re-land the
		// phase on Sonnet — the table must win.
		store.upsertSession({
			execution_id: "phase-qa-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "qa",
			dispatch_model: "claude-sonnet-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "phase-qa-1" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.dispatchModel).toBe("claude-opus-4-8"); // qa → Opus
		expect(dispatched[0]?.dispatchVendor).toBe("claude"); // FLY-1224: qa stays claude
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBe(true);
	});

	it("a legacy phase row with NO persisted dispatch model still retries on the phase table", async () => {
		store.upsertSession({
			execution_id: "phase-design-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
		});
		const r = await postRetry({ execution_id: "phase-design-1" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.dispatchModel).toBe("claude-fable-5"); // design → Fable
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBe(true);
	});

	it("BYTE-COMPAT sentinel: a main-row retry (auto-QA / single-session shape) is untouched", async () => {
		store.upsertSession({
			execution_id: "main-1",
			issue_id: "issue-main",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "main",
			dispatch_model: "claude-sonnet-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "main-1" });
		expect(r.status).toBe(200);
		// Exactly the pre-FLY-887 behavior: persisted dispatch model reused,
		// label layer NOT bypassed. FLY-1224: vendor/effort/shareParentBranch
		// stay undefined and sessionRole stays the persisted value (byte-compat).
		expect(dispatched[0]?.dispatchModel).toBe("claude-sonnet-5");
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBeUndefined();
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.shareParentBranch).toBeUndefined();
		expect(dispatched[0]?.sessionRole).toBe("main");
	});
});
