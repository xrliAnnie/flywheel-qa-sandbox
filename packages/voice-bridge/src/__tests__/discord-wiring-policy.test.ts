import { describe, expect, it, vi } from "vitest";
import {
	buildVoiceJoinOptions,
	joinVoiceConnection,
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

/**
 * FLY-2701 review R4 (MEDIUM): joining creates the connection first and only
 * then waits up to 15s for it to become Ready. On the failure path the caller
 * never receives a handle, so nothing upstream can take the bot back out — the
 * connection is registered with @discordjs/voice and simply left there. The
 * same hole swallows an aborted start: the room's own cleanup can only reach
 * fields it already owns.
 */
describe("Discord voice join cleans up what it created", () => {
	const opts = {
		guildId: "100000000000000001",
		channelId: "100000000000000002",
		selfMute: false,
		selfDeaf: false,
	};

	function fakes(entersState: () => Promise<void>) {
		const destroy = vi.fn();
		const connection = { destroy, state: {} };
		return {
			destroy,
			connection,
			voice: {
				joinVoiceChannel: vi.fn(() => connection),
				entersState: vi.fn(entersState),
				VoiceConnectionStatus: { Ready: "ready" },
			},
			client: {
				user: { id: "100000000000000005" },
				guilds: {
					fetch: vi.fn(async () => ({ voiceAdapterCreator: () => {} })),
				},
			},
		};
	}

	it("destroys the connection when it never becomes ready", async () => {
		const test = fakes(async () => {
			throw new Error("entersState timed out");
		});

		await expect(
			joinVoiceConnection({
				voice: test.voice,
				client: test.client,
				opts,
			}),
		).rejects.toThrow("entersState timed out");

		expect(test.destroy).toHaveBeenCalledTimes(1);
	});

	it("destroys a connection created after the start was already aborted", async () => {
		const controller = new AbortController();
		const test = fakes(async () => {
			controller.abort(new Error("other branch failed"));
		});

		await expect(
			joinVoiceConnection({
				voice: test.voice,
				client: test.client,
				opts,
				signal: controller.signal,
			}),
		).rejects.toThrow();

		expect(test.destroy).toHaveBeenCalledTimes(1);
	});

	it("never creates a connection for a start that was aborted first", async () => {
		const controller = new AbortController();
		controller.abort(new Error("other branch failed"));
		const test = fakes(async () => {});

		await expect(
			joinVoiceConnection({
				voice: test.voice,
				client: test.client,
				opts,
				signal: controller.signal,
			}),
		).rejects.toThrow();

		expect(test.voice.joinVoiceChannel).not.toHaveBeenCalled();
		expect(test.destroy).not.toHaveBeenCalled();
	});

	it("hands back a connection that came up normally", async () => {
		const test = fakes(async () => {});

		await expect(
			joinVoiceConnection({
				voice: test.voice,
				client: test.client,
				opts,
			}),
		).resolves.toBe(test.connection);
		expect(test.destroy).not.toHaveBeenCalled();
	});
});
