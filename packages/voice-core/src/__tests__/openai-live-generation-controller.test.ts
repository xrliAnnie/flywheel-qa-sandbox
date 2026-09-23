import { describe, expect, it, vi } from "vitest";
import { LiveGenerationController } from "../backends/openai-live/LiveGenerationController.js";
import type { OpenAiLiveSocket } from "../backends/openai-live/LiveSession.js";
import type {
	OpenAiLiveClientEvent,
	OpenAiLiveSessionConfig,
} from "../backends/openai-live/liveProtocol.js";

class FakeSocket implements OpenAiLiveSocket {
	readonly sent: OpenAiLiveClientEvent[] = [];
	closed = 0;
	private messageHandler: (raw: string | Buffer) => void = () => {};

	send(event: OpenAiLiveClientEvent): void {
		this.sent.push(event);
	}

	onMessage(handler: (raw: string | Buffer) => void): () => void {
		this.messageHandler = handler;
		return () => {
			this.messageHandler = () => {};
		};
	}

	onClose(_handler: (error?: Error) => void): () => void {
		return () => {};
	}

	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	close(): void {
		this.closed += 1;
	}

	receive(event: Record<string, unknown>): void {
		this.messageHandler(JSON.stringify(event));
	}

	started(generation: number): void {
		this.receive({
			type: "session.started",
			session: {
				id: `live-${generation}`,
				model: "gpt-live-1",
				status: "active",
				audio: { format: { type: "audio/pcm", rate: 24_000 } },
				delegation: { type: "client" },
			},
		});
	}
}

const config: OpenAiLiveSessionConfig = {
	model: "gpt-live-1",
	instructions: "Answer simply; delegate work.",
	voice: "marin",
	delegation: "client",
	audio: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
};

function makeController(): {
	controller: LiveGenerationController;
	sockets: FakeSocket[];
	cancelLocalOutput: ReturnType<typeof vi.fn>;
} {
	const sockets: FakeSocket[] = [];
	const cancelLocalOutput = vi.fn();
	let eventId = 0;
	const controller = new LiveGenerationController({
		config,
		connectSocket: async () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		nextEventId: () => `event-${++eventId}`,
		retirementDeadlineMs: 100,
		cancelLocalOutput,
	});
	return { controller, sockets, cancelLocalOutput };
}

describe("LiveGenerationController", () => {
	it("cancels locally before retiring the old socket and admits a fresh generation", async () => {
		const { controller, sockets, cancelLocalOutput } = makeController();
		const audio = vi.fn();
		controller.on("audio", audio);
		const starting = controller.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		await expect(starting).resolves.toBe(1);
		expect(controller.turnCancelOrSuppress).toBe(true);

		const replacing = controller.cancelAndReplace("barge-in");
		const repeated = controller.cancelAndReplace("barge-in");
		expect(repeated).toBe(replacing);
		expect(controller.turnCancelOrSuppress).toBe(false);
		expect(cancelLocalOutput).toHaveBeenCalledWith(1, "barge-in");
		expect(cancelLocalOutput).toHaveBeenCalledOnce();
		sockets[0]?.receive({
			type: "session.output_audio.delta",
			delta: Buffer.from("late").toString("base64"),
		});
		expect(audio).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(sockets[0]?.sent.at(-1)?.type).toBe("session.close"),
		);
		sockets[0]?.receive({ type: "session.closed" });
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		sockets[1]?.started(2);
		await expect(replacing).resolves.toBe(2);
		expect(controller.currentGeneration).toBe(2);
		expect(controller.turnCancelOrSuppress).toBe(true);
	});

	it("flushes local output and disables the capability on provider failure", async () => {
		const { controller, sockets, cancelLocalOutput } = makeController();
		const errors = vi.fn();
		controller.on("error", errors);
		const starting = controller.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		await starting;

		sockets[0]?.receive({
			type: "session.error",
			error: { message: "quota exhausted" },
		});
		expect(cancelLocalOutput).toHaveBeenCalledWith(1, "provider-failure");
		expect(controller.turnCancelOrSuppress).toBe(false);
		expect(errors).toHaveBeenCalledOnce();
	});

	it("can retire an admission that has not reached session.started", async () => {
		const { controller, sockets, cancelLocalOutput } = makeController();
		const starting = controller.start();
		const rejectedStart = expect(starting).rejects.toMatchObject({
			code: "cancelled",
		});
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const replacing = controller.cancelAndReplace("announcer-takeover");
		expect(cancelLocalOutput).toHaveBeenCalledWith(1, "announcer-takeover");
		await vi.waitFor(() =>
			expect(sockets[0]?.sent.at(-1)?.type).toBe("session.close"),
		);
		sockets[0]?.receive({ type: "session.closed" });
		await rejectedStart;
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		sockets[1]?.started(2);
		await expect(replacing).resolves.toBe(2);
	});

	it("seals a delegated generation before admitting its replacement", async () => {
		const { controller, sockets, cancelLocalOutput } = makeController();
		const retired = vi.fn();
		controller.on("retired", retired);
		const starting = controller.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		await starting;

		const replacing = controller.cancelAndReplace("delegation-sealed");
		expect(cancelLocalOutput).toHaveBeenCalledWith(1, "delegation-sealed");
		expect(controller.turnCancelOrSuppress).toBe(false);
		sockets[0]?.receive({ type: "session.closed" });
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		expect(retired).toHaveBeenCalledWith({
			generation: 1,
			reason: "delegation-sealed",
			finalization: "provider_connection_closed",
		});
		sockets[1]?.started(2);
		await expect(replacing).resolves.toBe(2);
	});

	it("closes without reconnecting and refuses later effects", async () => {
		const { controller, sockets, cancelLocalOutput } = makeController();
		const starting = controller.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0]?.started(1);
		await starting;
		const closing = controller.close();
		expect(cancelLocalOutput).toHaveBeenCalledWith(1, "session-close");
		sockets[0]?.receive({ type: "session.closed" });
		await closing;
		expect(sockets).toHaveLength(1);
		expect(controller.turnCancelOrSuppress).toBe(false);
		await expect(controller.start()).rejects.toThrow(/controller is closed/);
	});
});
