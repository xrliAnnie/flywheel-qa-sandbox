import type { RoomIO } from "flywheel-voice-core";
import { createRoomIO, type RoomIOOptions } from "./RoomIO.js";

export interface RoomIOActivation {
	sessionId: string;
	generation: number;
	outputConnection: unknown;
	assertLease(): void;
}

export interface RoomIOAdapter {
	activate(input: RoomIOActivation): Promise<RoomIO>;
	deactivate(room: RoomIO): Promise<void>;
}

export interface BorrowedRoomIOAdapterOptions {
	deps: RoomIOOptions["deps"];
	token: string;
	inputClient: NonNullable<
		NonNullable<RoomIOOptions["borrowedConnections"]>["inputClient"]
	>;
	inputConnection: unknown;
	outputClient: NonNullable<
		NonNullable<RoomIOOptions["borrowedConnections"]>["outputClient"]
	>;
	inputBotUserId: string;
	outputBotUserId: string;
	guildId: string;
	voiceChannelId: string;
	threadId: string;
	founderUserId: string;
	qaAllowUserIds: string[];
	allowedClipPaths?: readonly string[];
	buildSha?: string | null;
	onDiagnostic?(record: Record<string, unknown>): void;
	onError(error: Error): void;
}

/** One physical input receiver and one physical output player, both owned by
 * the canonical RoomIO implementation. The resident ears connection is
 * borrowed; the per-session mouth connection is released on deactivate. */
export function createBorrowedRoomIOAdapter(
	options: BorrowedRoomIOAdapterOptions,
): RoomIOAdapter {
	return {
		activate: async (input) => {
			const room = createRoomIO({
				sessionId: input.sessionId,
				generation: input.generation,
				roomKey: `${options.guildId}:${options.voiceChannelId}`,
				buildSha: options.buildSha ?? null,
				...(options.allowedClipPaths
					? { allowedClipPaths: options.allowedClipPaths }
					: {}),
				deps: options.deps,
				token: options.token,
				expectedBotUserId: options.outputBotUserId,
				expectedInputBotUserId: options.inputBotUserId,
				expectedOutputBotUserId: options.outputBotUserId,
				borrowedConnections: {
					inputClient: options.inputClient,
					inputConnection: options.inputConnection,
					inputOwnership: "borrowed",
					outputClient: options.outputClient,
					outputConnection: input.outputConnection,
					outputOwnership: "owned",
				},
				guildId: options.guildId,
				voiceChannelId: options.voiceChannelId,
				threadId: options.threadId,
				founderUserId: options.founderUserId,
				qaAllowUserIds: options.qaAllowUserIds,
				assertLease: input.assertLease,
				onDiagnostic: options.onDiagnostic,
				onError: options.onError,
			});
			try {
				await room.start();
				return room;
			} catch (error) {
				await room.stop().catch(() => undefined);
				throw error;
			}
		},
		deactivate: (room) => room.stop(),
	};
}
