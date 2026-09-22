import { describe, expect, it } from "vitest";
import {
	buildVoiceJoinOptions,
	loadDiscordReceiveRuntimeDiagnostic,
	parseDiscordReceiveDiagnostic,
} from "../bots/discordWiring.js";

describe("Discord receive policy wiring", () => {
	it("reports the versions loaded by the real glue entrypoint with its fixed policy", () => {
		expect(
			loadDiscordReceiveRuntimeDiagnostic({
				daveEncryption: true,
				decryptionFailureTolerance: 36,
				debug: true,
			}),
		).toEqual({
			voiceVersion: "0.19.2",
			daveyVersion: "0.1.12",
			nodeVersion: process.version,
			arch: process.arch,
			daveEncryption: true,
			decryptionFailureTolerance: 36,
			debug: true,
		});
	});

	it("pins DAVE and the audited failure tolerance on the public join options", () => {
		expect(
			buildVoiceJoinOptions(
				{
					guildId: "guild",
					channelId: "voice",
					selfMute: false,
					selfDeaf: false,
				},
				"adapter",
				"bot",
				{
					daveEncryption: true,
					decryptionFailureTolerance: 36,
					debug: true,
				},
			),
		).toEqual({
			guildId: "guild",
			channelId: "voice",
			adapterCreator: "adapter",
			selfMute: false,
			selfDeaf: false,
			group: "bot",
			daveEncryption: true,
			decryptionFailureTolerance: 36,
			debug: true,
		});
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		"rejects invalid decryption tolerance %s",
		(decryptionFailureTolerance) => {
			expect(() =>
				buildVoiceJoinOptions(
					{
						guildId: "guild",
						channelId: "voice",
						selfMute: false,
						selfDeaf: false,
					},
					"adapter",
					"bot",
					{ daveEncryption: true, decryptionFailureTolerance },
				),
			).toThrow("invalid_decryption_failure_tolerance");
		},
	);
});

describe("Discord receive debug redaction", () => {
	it.each([
		[
			"[NW] [DAVE] Preparing for transition (12, v1)",
			{ kind: "transition_preparing", transitionId: 12, protocolVersion: 1 },
		],
		[
			"[NW] [DAVE] Transition executed (v1 -> v2, id: 12)",
			{
				kind: "transition_executed",
				transitionId: 12,
				fromVersion: 1,
				toVersion: 2,
			},
		],
		[
			"[NW] [DAVE] Failed to decrypt a packet (7 consecutive fails)",
			{ kind: "decrypt_failures", consecutiveFailures: 7 },
		],
		[
			"[NW] [DAVE] Failed to decrypt a packet (reinitializing session)",
			{ kind: "decrypt_reinitializing", reinitializing: true },
		],
		[
			"[NW] [DAVE] Session downgraded",
			{ kind: "session_security", encrypted: false },
		],
		[
			"[NW] [DAVE] Session upgraded",
			{ kind: "session_security", encrypted: true },
		],
		[
			"[NW] [DAVE] Invalidating transition 12",
			{ kind: "transition_invalidated", transitionId: 12 },
		],
		[
			"[NW] [DAVE] Failed to decrypt a packet (3 pending transition[s])",
			{ kind: "decrypt_pending_transitions", pendingTransitions: 3 },
		],
		[
			"[NW] [DAVE] Session initialized for protocol version 1",
			{ kind: "session_protocol", protocolVersion: 1, reinitialized: false },
		],
		[
			"[NW] [DAVE] Session reinitialized for protocol version 2",
			{ kind: "session_protocol", protocolVersion: 2, reinitialized: true },
		],
	] as const)(
		"extracts only bounded numeric DAVE diagnostics",
		(line, expected) => {
			expect(parseDiscordReceiveDiagnostic(line)).toEqual(expected);
		},
	);

	it("drops unmatched text instead of forwarding possible secrets", () => {
		expect(
			parseDiscordReceiveDiagnostic(
				"[NW] [DAVE] token=secret-key privateKey=do-not-log",
			),
		).toEqual({ kind: "unknown" });
	});
});
