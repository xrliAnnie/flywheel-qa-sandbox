import { describe, expect, it, vi } from "vitest";
import {
	CodexLeadInboxProtocolError,
	CodexLeadInboxRejectedError,
} from "../../../lead-backends/codex/CodexLeadInboxSocket.js";
import {
	type CodexLeadActivityDeps,
	readCodexLeadActivity,
} from "../codex-lead-activity.js";

const NOW = Date.parse("2026-09-25T20:00:00.000Z");
const START = NOW - 95_000;

function snapshot(over: Record<string, unknown> = {}) {
	return {
		schema: "turn-state.v1",
		generation: "gen-1",
		connected: true,
		seeded: true,
		activeTurns: [],
		...over,
	};
}
const messageTurn = (binding: Record<string, unknown>, extra = {}) => ({
	origin: "message",
	turnId: "turn-1",
	startedAtMs: START,
	binding,
	...extra,
});

function deps(over: Partial<CodexLeadActivityDeps> = {}) {
	return {
		resolveSocketPath: vi.fn(async () => "/tmp/lead-inbox.sock"),
		resolveAuthSecret: vi.fn(() => "bot-token"),
		probeCapabilities: vi.fn(async () => ({
			protocolVersions: [1, 2] as [1, 2],
			features: ["discord_route_v2", "turn_state_v1"] as never,
			socketOwnerId: "owner",
		})),
		readTurnState: vi.fn(async () => snapshot() as unknown),
		attribute: vi.fn(() => ({
			kind: "issue" as const,
			issueId: "FLY-2830",
			basis: "codex_journal_members" as const,
		})),
		now: () => NOW,
		...over,
	};
}

async function read(over: Partial<CodexLeadActivityDeps> = {}) {
	const d = deps(over);
	return { d, result: await readCodexLeadActivity("flywheel", "mufasa", d) };
}

describe("readCodexLeadActivity — sidecar table (plan §5.4)", () => {
	it("idle when the seeded snapshot has no active turn", async () => {
		const { d, result } = await read();
		expect(result).toEqual({ observedAtMs: NOW, reading: { state: "idle" } });
		expect(d.probeCapabilities).toHaveBeenCalledWith({
			socketPath: "/tmp/lead-inbox.sock",
			leadId: "mufasa",
			authSecret: "bot-token",
			timeoutMs: 3_000,
		});
		expect(d.readTurnState).toHaveBeenCalledWith({
			socketPath: "/tmp/lead-inbox.sock",
			leadId: "mufasa",
			authSecret: "bot-token",
			timeoutMs: 3_000,
		});
		expect(d.resolveSocketPath).toHaveBeenCalledWith("flywheel", "mufasa");
	});

	it("busy from the earliest active turn, attributed through the bound deliveries", async () => {
		const { d, result } = await read({
			readTurnState: async () =>
				snapshot({
					activeTurns: [
						{
							origin: "founder_terminal",
							turnId: "late",
							startedAtMs: NOW - 5_000,
						},
						messageTurn({ status: "bound", deliveryIds: ["d-1", "d-2"] }),
					],
				}),
		});
		expect(result.reading).toEqual({
			state: "busy",
			turn: {
				startedAt: new Date(START).toISOString(),
				elapsedMs: 95_000,
				precision: "second",
				origin: "message",
			},
			trigger: {
				kind: "issue",
				issueId: "FLY-2830",
				basis: "codex_journal_members",
			},
		});
		expect(d.attribute).toHaveBeenCalledWith("flywheel", "mufasa", [
			"d-1",
			"d-2",
		]);
	});

	it.each([
		["founder_terminal", undefined, "founder_terminal_turn"],
		["unknown", undefined, "turn_origin_unknown"],
		["message", { status: "pending" }, "turn_not_yet_bound"],
		["message", { status: "ambiguous" }, "ambiguous_turn_binding"],
		["message", { status: "no_members" }, "no_delivery_binding"],
		["message", { status: "overflow" }, "candidate_overflow"],
		["message", { status: "unavailable" }, "attribution_unavailable"],
	])(
		"busy %s turn with binding %j → undetermined %s",
		async (origin, binding, reason) => {
			const turn =
				binding === undefined
					? { origin, turnId: "t", startedAtMs: START }
					: { origin, turnId: "t", startedAtMs: START, binding };
			const { d, result } = await read({
				readTurnState: async () => snapshot({ activeTurns: [turn] }),
			});
			expect(result.reading).toMatchObject({
				state: "busy",
				turn: { origin },
				trigger: {
					kind: "undetermined",
					reason,
					detail: expect.stringContaining("判断不了"),
				},
			});
			expect(d.attribute).not.toHaveBeenCalled();
		},
	);

	it("keeps busy when attribution throws", async () => {
		const { result } = await read({
			readTurnState: async () =>
				snapshot({
					activeTurns: [messageTurn({ status: "bound", deliveryIds: ["d-1"] })],
				}),
			attribute: () => {
				throw new Error("boom");
			},
		});
		expect(result.reading).toMatchObject({
			state: "busy",
			trigger: { reason: "attribution_unavailable" },
		});
	});

	it("clamps a start within the future-skew window to the observation time", async () => {
		const { result } = await read({
			readTurnState: async () =>
				snapshot({
					activeTurns: [
						{ origin: "unknown", turnId: "t", startedAtMs: NOW + 3_000 },
					],
				}),
		});
		expect(result.reading).toMatchObject({
			state: "busy",
			turn: { startedAt: new Date(NOW).toISOString(), elapsedMs: 0 },
		});
	});

	it.each([
		[
			"no bot token",
			{ resolveAuthSecret: () => undefined },
			"sidecar_unreachable",
		],
		[
			"an unresolvable state dir",
			{
				resolveSocketPath: async () => {
					throw new Error(
						"FLYWHEEL_CODEX_LEAD_STATE_DIRS has no absolute path",
					);
				},
			},
			"sidecar_unreachable",
		],
		[
			"a dead socket",
			{
				probeCapabilities: async () => {
					throw new Error("connect ENOENT");
				},
			},
			"sidecar_unreachable",
		],
		[
			"an auth rejection",
			{
				probeCapabilities: async () => {
					throw new CodexLeadInboxRejectedError("authentication rejected");
				},
			},
			"sidecar_unreachable",
		],
		[
			"an old sidecar without the feature",
			{
				probeCapabilities: async () => ({
					protocolVersions: [1, 2] as [1, 2],
					features: ["discord_route_v2"] as never,
					socketOwnerId: "o",
				}),
			},
			"sidecar_lacks_turn_state",
		],
		[
			"a sidecar that rejects the method",
			{
				readTurnState: async () => {
					throw new CodexLeadInboxRejectedError("unsupported inbox method");
				},
			},
			"sidecar_lacks_turn_state",
		],
		[
			"a read timeout",
			{
				readTurnState: async () => {
					throw new Error("Codex Lead inbox timeout after 3000ms");
				},
			},
			"sidecar_unreachable",
		],
		[
			"malformed capabilities",
			{
				probeCapabilities: async () => ({ features: "turn_state_v1" }) as never,
			},
			"sidecar_protocol_invalid",
		],
		[
			"a malformed reply envelope",
			{
				readTurnState: async () => {
					throw new CodexLeadInboxProtocolError("invalid_envelope");
				},
			},
			"sidecar_protocol_invalid",
		],
		[
			"a non-JSON reply",
			{
				readTurnState: async () => {
					throw new CodexLeadInboxProtocolError("invalid_json");
				},
			},
			"sidecar_protocol_invalid",
		],
		[
			"a disconnected observer",
			{
				readTurnState: async () =>
					snapshot({ connected: false, seeded: false }),
			},
			"observer_disconnected",
		],
		[
			"an unseeded tracker",
			{ readTurnState: async () => snapshot({ seeded: false }) },
			"turn_state_not_seeded",
		],
	] as const)("unknown for %s — never idle", async (_label, over, reason) => {
		const { result } = await read(over as Partial<CodexLeadActivityDeps>);
		expect(result.reading).toEqual({ state: "unknown", reason });
	});
});

describe("readCodexLeadActivity — strict snapshot schema", () => {
	const turn = { origin: "unknown", turnId: "t", startedAtMs: START };
	it.each([
		["a null reply", null],
		[
			"a missing field",
			{
				schema: "turn-state.v1",
				generation: "g",
				connected: true,
				seeded: true,
			},
		],
		["an extra field", snapshot({ note: "x" })],
		["a wrong schema", snapshot({ schema: "turn-state.v2" })],
		["a non-boolean seeded", snapshot({ seeded: "yes" })],
		["activeTurns not an array", snapshot({ activeTurns: {} })],
		[
			"more than four active turns",
			snapshot({
				activeTurns: [1, 2, 3, 4, 5].map((i) => ({ ...turn, turnId: `t${i}` })),
			}),
		],
		[
			"an oversized turn id",
			snapshot({ activeTurns: [{ ...turn, turnId: "x".repeat(129) }] }),
		],
		["an empty turn id", snapshot({ activeTurns: [{ ...turn, turnId: "" }] })],
		["duplicate turn ids", snapshot({ activeTurns: [turn, turn] })],
		[
			"a string start",
			snapshot({ activeTurns: [{ ...turn, startedAtMs: "1" }] }),
		],
		[
			"a fractional start",
			snapshot({ activeTurns: [{ ...turn, startedAtMs: START + 0.5 }] }),
		],
		[
			"a start beyond the skew window",
			snapshot({ activeTurns: [{ ...turn, startedAtMs: NOW + 5_001 }] }),
		],
		[
			"an unknown origin",
			snapshot({ activeTurns: [{ ...turn, origin: "cron" }] }),
		],
		[
			"a founder turn carrying a binding",
			snapshot({
				activeTurns: [
					{
						...turn,
						origin: "founder_terminal",
						binding: { status: "pending" },
					},
				],
			}),
		],
		[
			"an unknown turn carrying a binding",
			snapshot({ activeTurns: [{ ...turn, binding: { status: "pending" } }] }),
		],
		[
			"a message turn without a binding",
			snapshot({ activeTurns: [{ ...turn, origin: "message" }] }),
		],
		[
			"an unknown binding status",
			snapshot({ activeTurns: [messageTurn({ status: "guess" })] }),
		],
		[
			"a binding with extra keys",
			snapshot({
				activeTurns: [messageTurn({ status: "pending", deliveryIds: [] })],
			}),
		],
		[
			"a bound binding with no ids",
			snapshot({
				activeTurns: [messageTurn({ status: "bound", deliveryIds: [] })],
			}),
		],
		[
			"a bound binding with 65 ids",
			snapshot({
				activeTurns: [
					messageTurn({
						status: "bound",
						deliveryIds: Array.from({ length: 65 }, (_, i) => `d${i}`),
					}),
				],
			}),
		],
		[
			"a bound binding with an oversized id",
			snapshot({
				activeTurns: [
					messageTurn({ status: "bound", deliveryIds: ["x".repeat(201)] }),
				],
			}),
		],
		[
			"a bound binding with a non-string id",
			snapshot({
				activeTurns: [messageTurn({ status: "bound", deliveryIds: [7] })],
			}),
		],
		[
			"an extra field on a turn",
			snapshot({ activeTurns: [{ ...turn, text: "body" }] }),
		],
	])("answers sidecar_protocol_invalid for %s", async (_label, value) => {
		const { d, result } = await read({
			readTurnState: async () => value as unknown,
		});
		expect(result.reading).toEqual({
			state: "unknown",
			reason: "sidecar_protocol_invalid",
		});
		expect(d.attribute).not.toHaveBeenCalled();
	});
});
