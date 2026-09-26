import type { PassThrough } from "node:stream";
import { vi } from "vitest";

/**
 * A stand-in for the discord.js AudioPlayer: it takes one frame per 20ms slot
 * from the current resource, and a resource reports how many frames were taken
 * through playbackDuration, as @discordjs/voice AudioResource does.
 */
export function simulatedPlayer() {
	type Resource = {
		frames: Buffer[];
		playbackDuration: number;
		stream: { destroyed: boolean };
	};
	const resources: Resource[] = [];
	let current: Resource | undefined;
	const heard: Array<Buffer | null> = [];
	return {
		resources,
		heard,
		player: {
			play: vi.fn((resource: unknown) => {
				current = resource as Resource;
			}),
			stop: vi.fn(),
		},
		createResource: (source: { kind: "raw-stream"; stream: PassThrough }) => {
			const resource: Resource = {
				frames: [],
				playbackDuration: 0,
				stream: source.stream,
			};
			source.stream.on("data", (frame: Buffer) => resource.frames.push(frame));
			resources.push(resource);
			return resource;
		},
		/** The player's audio cycle: one slot, one frame if one is queued. */
		read: () => {
			const resource = current;
			const index = resource ? resource.playbackDuration / 20 : 0;
			const frame = resource?.frames[index];
			if (resource && frame) resource.playbackDuration += 20;
			heard.push(frame ?? null);
		},
	};
}
