import type { BrainAdapter } from "flywheel-voice-core";
import { expect, it, vi } from "vitest";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};
type OpenInput = Parameters<
	ConstructorParameters<typeof CodexVoiceBackend>[0]["container"]["open"]
>[0];

const row = (requestId: string, outcome: "succeeded" | "unknown") => ({
	requestId,
	operationId: "linear.issue.update",
	targetKey: "flywheel:linear:fly-2886",
	state: outcome,
	outcome,
	errorCode: null,
});

async function open(options: {
	backgroundEnabled: boolean;
	ledger?: ReturnType<typeof row>[];
	turnLedger?: (turnId: string) => ReturnType<typeof row>[] | undefined;
	founderUserId?: string | null;
}) {
	let callbacks!: OpenInput;
	const observeFounderUtterance = vi.fn();
	const backend = new CodexVoiceBackend({
		sessionId: "session-repeat",
		voice: "marin",
		backgroundEnabled: options.backgroundEnabled,
		...(options.founderUserId === null
			? {}
			: { founderUserId: options.founderUserId ?? "founder" }),
		loadContext: vi.fn(),
		persistUtterance: async () => {},
		container: {
			open: async (input) => {
				callbacks = input;
				return {
					generation: 1,
					actionLedger: () => options.ledger ?? [],
					...(options.turnLedger
						? { turnActionLedger: options.turnLedger }
						: {}),
					observeFounderUtterance,
					transport: {
						appendAudio: () => "sent" as const,
						appendSpeech: async () => {},
						appendText: async () => {},
						cancel: async () => {},
					},
					close: async () => {},
				};
			},
		},
	});
	const session = await backend.createConversation({ brain });
	session.on("error", () => {});
	return { callbacks: () => callbacks, session, observeFounderUtterance };
}

it("forwards only speaker-attributed founder finals to the repeat confirmation gate", async () => {
	const h = await open({ backgroundEnabled: true });
	const transcript = (
		text: string,
		extra: Record<string, unknown>,
		itemId: string,
	) =>
		h.callbacks().realtime.onTranscript?.({
			generation: 1,
			itemId,
			association: "provider_item",
			final: true,
			raw: {},
			text,
			role: "user",
			...extra,
		} as never);
	transcript(
		"要，再做一次",
		{ inputOwner: { utteranceId: "u1", ownerUserId: "founder" } },
		"i1",
	);
	transcript("再做一次", {}, "i2");
	// An allowlisted QA speaker is attributed, but is not her.
	transcript(
		"对，再做一次",
		{ inputOwner: { utteranceId: "u5", ownerUserId: "qa-user" } },
		"i5",
	);
	transcript("好", { role: "assistant" }, "i3");
	transcript(
		"要",
		{ final: false, inputOwner: { utteranceId: "u4", ownerUserId: "founder" } },
		"i4",
	);
	expect(h.observeFounderUtterance.mock.calls).toEqual([["要，再做一次"]]);
	await h.session.close();
});

it("never feeds the gate without the session's founder identity", async () => {
	const h = await open({ backgroundEnabled: true, founderUserId: null });
	h.callbacks().realtime.onTranscript?.({
		generation: 1,
		itemId: "i1",
		association: "provider_item",
		role: "user",
		text: "要",
		final: true,
		inputOwner: { utteranceId: "u1", ownerUserId: "founder" },
		raw: {},
	});
	expect(h.observeFounderUtterance).not.toHaveBeenCalled();
	await h.session.close();
});

it("does not feed the gate when the background agent is disabled", async () => {
	const h = await open({ backgroundEnabled: false });
	h.callbacks().realtime.onTranscript?.({
		generation: 1,
		itemId: "i1",
		association: "provider_item",
		role: "user",
		text: "要",
		final: true,
		inputOwner: { utteranceId: "u1", ownerUserId: "founder" },
		raw: {},
	});
	expect(h.observeFounderUtterance).not.toHaveBeenCalled();
	await h.session.close();
});

it("counts a replayed older write receipt as this turn's receipt through the durable per-turn ledger", async () => {
	const older = row("123e4567-e89b-42d3-a456-426614174000", "unknown");
	const h = await open({
		backgroundEnabled: true,
		// Present before the turn starts, so the start-of-turn diff would miss it.
		ledger: [older],
		turnLedger: (turnId) => (turnId === "t-replay" ? [older] : undefined),
	});
	const terminal = vi.fn();
	h.session.on("background-turn-terminal", terminal);
	h.callbacks().background!.onTurnStarted("t-replay");
	h.callbacks().background!.onTurnTerminal({
		turnId: "t-replay",
		outcome: "completed",
		spokenSegments: ["这件刚才已经发出去了，结果还在核对，要再发一次吗？"],
	});
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({
			turnId: "t-replay",
			hadWriteReceipt: false,
			writeReceiptUnknown: true,
		}),
	);
	await h.session.close();
});

it("falls back to the start-of-turn diff when no per-turn ledger is available", async () => {
	const ledger: ReturnType<typeof row>[] = [];
	const h = await open({ backgroundEnabled: true, ledger });
	const terminal = vi.fn();
	h.session.on("background-turn-terminal", terminal);
	h.callbacks().background!.onTurnStarted("t-new");
	ledger.push(row("223e4567-e89b-42d3-a456-426614174000", "succeeded"));
	h.callbacks().background!.onTurnTerminal({
		turnId: "t-new",
		outcome: "completed",
		spokenSegments: ["改好了"],
	});
	expect(terminal).toHaveBeenCalledWith(
		expect.objectContaining({ hadWriteReceipt: true }),
	);
	await h.session.close();
});
