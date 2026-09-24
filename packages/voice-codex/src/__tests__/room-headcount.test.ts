import { describe, expect, it, vi } from "vitest";
import { ChannelHeadcount } from "../room-headcount.js";

type VoiceStateEvent = {
	userId: string;
	isBot: boolean;
	fromChannelId: string | null;
	toChannelId: string | null;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function harness() {
	let emit!: (event: VoiceStateEvent) => void;
	const unsubscribe = vi.fn();
	const reads: Array<ReturnType<typeof deferred<number>>> = [];
	const deps = {
		onVoiceStateUpdate: vi.fn(
			(_client: unknown, cb: (event: VoiceStateEvent) => void) => {
				emit = cb;
				return unsubscribe;
			},
		),
		voiceChannelHumanCount: vi.fn(
			(_client: unknown, _guildId: string, _channelId: string) => {
				const read = deferred<number>();
				reads.push(read);
				return read.promise;
			},
		),
		other: "kept",
	};
	const onError = vi.fn();
	const headcount = new ChannelHeadcount({
		guildId: "guild",
		voiceChannelId: "voice",
		onError,
	});
	const wrapped = headcount.wrap(deps);
	const seen: VoiceStateEvent[] = [];
	const off = wrapped.onVoiceStateUpdate("client", (event) => {
		// The count must already be unknown when the room hears the event.
		seen.push(event);
		observedDuringCallback.push(headcount.current());
	});
	const observedDuringCallback: Array<number | null> = [];
	return {
		headcount,
		deps,
		wrapped,
		reads,
		onError,
		seen,
		off,
		unsubscribe,
		observedDuringCallback,
		emit: (event: VoiceStateEvent) => emit(event),
	};
}

const join = (userId: string, isBot = false): VoiceStateEvent => ({
	userId,
	isBot,
	fromChannelId: null,
	toChannelId: "voice",
});

describe("ChannelHeadcount (FLY-2796 review R1)", () => {
	it("is unknown until the first read of the channel lands", async () => {
		const test = harness();
		expect(test.deps.voiceChannelHumanCount).toHaveBeenCalledWith(
			"client",
			"guild",
			"voice",
		);
		expect(test.headcount.current()).toBeNull();
		test.reads[0]!.resolve(1);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(1));
	});

	it("forgets the count the moment anyone else joins, then reads it again", async () => {
		const test = harness();
		test.reads[0]!.resolve(1);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(1));

		test.emit(join("guest"));
		expect(test.headcount.current()).toBeNull();
		expect(test.observedDuringCallback).toEqual([null]);
		expect(test.seen).toEqual([join("guest")]);

		test.reads[1]!.resolve(2);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(2));
	});

	it("also forgets it when someone leaves the channel", async () => {
		const test = harness();
		test.reads[0]!.resolve(2);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(2));
		test.emit({
			userId: "guest",
			isBot: false,
			fromChannelId: "voice",
			toChannelId: null,
		});
		expect(test.headcount.current()).toBeNull();
		test.reads[1]!.resolve(1);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(1));
	});

	it("never lets an older read overwrite a newer change", async () => {
		const test = harness();
		test.emit(join("guest"));
		// The first read (from before the join) lands last and must be ignored.
		test.reads[1]!.resolve(2);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(2));
		test.reads[0]!.resolve(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(test.headcount.current()).toBe(2);
	});

	it("ignores bots and other channels", async () => {
		const test = harness();
		test.reads[0]!.resolve(1);
		await vi.waitFor(() => expect(test.headcount.current()).toBe(1));
		test.emit(join("some-bot", true));
		test.emit({
			userId: "guest",
			isBot: false,
			fromChannelId: "elsewhere",
			toChannelId: "another",
		});
		expect(test.headcount.current()).toBe(1);
		expect(test.deps.voiceChannelHumanCount).toHaveBeenCalledOnce();
		expect(test.seen).toHaveLength(2);
	});

	it("stays unknown and reports when the read fails", async () => {
		const test = harness();
		test.reads[0]!.reject(new Error("guild fetch failed"));
		await vi.waitFor(() => expect(test.onError).toHaveBeenCalledOnce());
		expect(test.headcount.current()).toBeNull();
	});

	it("stays unknown when the deps cannot count humans", () => {
		const headcount = new ChannelHeadcount({
			guildId: "guild",
			voiceChannelId: "voice",
		});
		const wrapped = headcount.wrap({
			onVoiceStateUpdate: () => () => undefined,
		});
		wrapped.onVoiceStateUpdate("client", () => undefined);
		expect(headcount.current()).toBeNull();
	});

	it("keeps every other dep and hands back the room's unsubscribe", () => {
		const test = harness();
		expect(test.wrapped.other).toBe("kept");
		expect(test.wrapped.voiceChannelHumanCount).toBe(
			test.deps.voiceChannelHumanCount,
		);
		test.off();
		expect(test.unsubscribe).toHaveBeenCalledOnce();
	});
});
