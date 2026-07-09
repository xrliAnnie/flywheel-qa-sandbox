/**
 * FLY-545 P1 — ConversationOptions.extraTools dispatch contract.
 *
 * The current backend declares ask_lead and handles ONLY ask_lead internally.
 * A declared-but-unhandled tool would let a Live turn hang forever (the model
 * waits for a function response). extraTools gives the orchestrator a dispatch
 * path: declaration + handler; results are injected as function responses
 * (default WHEN_IDLE). Cancellation contract is identical to ask_lead:
 * tool-call-cancellation / manual interrupt / close all abort the handler and
 * suppress the late response. An UNKNOWN tool name gets an explicit error
 * response — never silence (plan.md §5.1, Codex R1 #2).
 */
import { describe, expect, it, vi } from "vitest";
import {
	GeminiLiveBackend,
	type GeminiModelProfile,
} from "../backends/gemini/GeminiLiveBackend.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
	LiveServerEvent,
} from "../backends/gemini/transport.js";
import type { LiveToolSpec, VoiceError } from "../types.js";
import { FakeBrain } from "./fakes.js";

class FakeConnection implements LiveConnection {
	toolResponses: { callId: string; output: string; scheduling?: string }[] = [];
	closed = false;
	private cb?: (e: LiveServerEvent) => void;
	constructor(readonly params: LiveConnectParams) {}
	sendAudio(): void {}
	sendText(): void {}
	sendToolResponse(callId: string, output: string, scheduling?: string): void {
		this.toolResponses.push({ callId, output, scheduling });
	}
	onEvent(cb: (e: LiveServerEvent) => void): void {
		this.cb = cb;
	}
	emit(e: LiveServerEvent): void {
		this.cb?.(e);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeTransport implements GeminiLiveTransport {
	lastConnection?: FakeConnection;
	async connect(params: LiveConnectParams): Promise<LiveConnection> {
		this.lastConnection = new FakeConnection(params);
		return this.lastConnection;
	}
}

const profile: GeminiModelProfile = {
	model: "gemini-3.1-flash-live-preview",
	asyncFunctionCalling: true,
};

const ISSUE_STATUS_DECLARATION = {
	name: "issue_status",
	description: "Query Linear issue status. Read-only.",
	parameters: {
		type: "OBJECT",
		properties: { query: { type: "STRING", description: "id or keyword" } },
		required: ["query"],
	},
};

function issueStatusTool(
	handler: LiveToolSpec["handler"] = async () => "FLY-545: In Progress",
): LiveToolSpec {
	return { declaration: ISSUE_STATUS_DECLARATION, handler };
}

async function setup(extraTools?: LiveToolSpec[]) {
	const transport = new FakeTransport();
	const backend = new GeminiLiveBackend({ transport, profile });
	const brain = new FakeBrain(["brain says hi"]);
	const session = await backend.createConversation({
		brain,
		...(extraTools ? { extraTools } : {}),
	});
	const conn = transport.lastConnection;
	if (!conn) throw new Error("transport never connected");
	return { session, conn, brain };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("extraTools declarations", () => {
	it("passes extra declarations to the transport after ask_lead", async () => {
		const { conn } = await setup([issueStatusTool()]);
		expect(conn.params.tools.map((t) => t.name)).toEqual([
			"ask_lead",
			"issue_status",
		]);
		expect(conn.params.tools[1]).toEqual(ISSUE_STATUS_DECLARATION);
	});

	it("defaults to ask_lead only (byte-compat when extraTools omitted)", async () => {
		const { conn } = await setup();
		expect(conn.params.tools.map((t) => t.name)).toEqual(["ask_lead"]);
	});
});

describe("extraTools dispatch", () => {
	it("runs the handler and injects exactly one when_idle function response", async () => {
		const handler = vi.fn(async (args: unknown) => {
			expect(args).toEqual({ query: "FLY-545" });
			return "FLY-545: In Progress";
		});
		const { conn } = await setup([issueStatusTool(handler)]);
		conn.emit({
			type: "tool-call",
			callId: "c1",
			name: "issue_status",
			args: { query: "FLY-545" },
		});
		await flush();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(conn.toolResponses).toEqual([
			{ callId: "c1", output: "FLY-545: In Progress", scheduling: "when_idle" },
		]);
	});

	it("still emits the tool-call event for observers", async () => {
		const { session, conn } = await setup([issueStatusTool()]);
		const seen: { name: string }[] = [];
		session.on("tool-call", (e) => seen.push({ name: e.name }));
		conn.emit({
			type: "tool-call",
			callId: "c1",
			name: "issue_status",
			args: {},
		});
		await flush();
		expect(seen).toEqual([{ name: "issue_status" }]);
	});

	it("keeps ask_lead routed to the brain when extraTools are present", async () => {
		const { conn } = await setup([issueStatusTool()]);
		conn.emit({
			type: "tool-call",
			callId: "c-ask",
			name: "ask_lead",
			args: { question: "status?" },
		});
		await flush();
		expect(conn.toolResponses).toEqual([
			{ callId: "c-ask", output: "brain says hi", scheduling: undefined },
		]);
	});

	it("answers an UNKNOWN tool name with an explicit error response (never silent)", async () => {
		const { conn } = await setup([issueStatusTool()]);
		conn.emit({
			type: "tool-call",
			callId: "c2",
			name: "mystery_tool",
			args: {},
		});
		await flush();
		expect(conn.toolResponses).toHaveLength(1);
		expect(conn.toolResponses[0]!.callId).toBe("c2");
		expect(conn.toolResponses[0]!.output).toContain("mystery_tool");
		expect(conn.toolResponses[0]!.output).toMatch(/no handler|unknown/i);
	});

	it("surfaces a handler failure as an explicit response + error event", async () => {
		const { session, conn } = await setup([
			issueStatusTool(async () => {
				throw new Error("bridge down");
			}),
		]);
		const errors: VoiceError[] = [];
		session.on("error", (e) => errors.push(e));
		conn.emit({
			type: "tool-call",
			callId: "c3",
			name: "issue_status",
			args: {},
		});
		await flush();
		expect(conn.toolResponses).toHaveLength(1);
		expect(conn.toolResponses[0]!.output).toMatch(/could not|failed/i);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain("issue_status");
	});
});

describe("extraTools cancellation (same contract as ask_lead)", () => {
	function deferredTool() {
		let resolve!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolve = r;
		});
		const signals: AbortSignal[] = [];
		const tool = issueStatusTool(async (_args, { signal }) => {
			signals.push(signal);
			return gate;
		});
		return { tool, resolve, signals };
	}

	it("manual interrupt aborts the in-flight handler and suppresses the late response", async () => {
		const { tool, resolve, signals } = deferredTool();
		const { session, conn } = await setup([tool]);
		conn.emit({
			type: "tool-call",
			callId: "c4",
			name: "issue_status",
			args: {},
		});
		await flush();
		session.interrupt();
		expect(signals[0]!.aborted).toBe(true);
		resolve("too late");
		await flush();
		expect(conn.toolResponses).toHaveLength(0);
	});

	it("tool-call-cancellation aborts the matching in-flight handler", async () => {
		const { tool, resolve, signals } = deferredTool();
		const { conn } = await setup([tool]);
		conn.emit({
			type: "tool-call",
			callId: "c5",
			name: "issue_status",
			args: {},
		});
		await flush();
		conn.emit({ type: "tool-call-cancellation", callIds: ["c5"] });
		expect(signals[0]!.aborted).toBe(true);
		resolve("too late");
		await flush();
		expect(conn.toolResponses).toHaveLength(0);
	});

	it("close() aborts in-flight handlers", async () => {
		const { tool, resolve, signals } = deferredTool();
		const { session, conn } = await setup([tool]);
		conn.emit({
			type: "tool-call",
			callId: "c6",
			name: "issue_status",
			args: {},
		});
		await flush();
		await session.close();
		expect(signals[0]!.aborted).toBe(true);
		resolve("too late");
		await flush();
		expect(conn.toolResponses).toHaveLength(0);
	});

	it("drops a tool-call that arrives after the turn was cancelled", async () => {
		const handler = vi.fn(async () => "never");
		const { session, conn } = await setup([issueStatusTool(handler)]);
		session.interrupt();
		conn.emit({
			type: "tool-call",
			callId: "c7",
			name: "issue_status",
			args: {},
		});
		await flush();
		expect(handler).not.toHaveBeenCalled();
		expect(conn.toolResponses).toHaveLength(0);
	});
});
