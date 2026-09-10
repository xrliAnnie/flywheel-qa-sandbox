import { describe, expect, it } from "vitest";
import { SpeakerAttribution } from "../speaker-attribution.js";

describe("speaking epoch attribution", () => {
	it("attributes a delayed founder final sixty seconds after speech ends only once", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("founder", 0);
		attribution.speakingEnd("founder", 100);
		expect(attribution.consumeOwner(60_100)).toBe("founder");
		expect(attribution.consumeOwner(60_101)).toBeNull();
	});

	it("rejects mixed unconsumed owners instead of assigning A's late final to B", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("founder", 0);
		attribution.speakingEnd("founder", 100);
		attribution.speakingStart("qa", 200);
		expect(attribution.consumeOwner(300)).toBeNull();
	});

	it("rejects a crossed owner boundary regardless of elapsed time", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("qa", 0);
		attribution.speakingEnd("qa", 100);
		attribution.speakingStart("founder", 6_000);
		expect(attribution.consumeOwner(6_100)).toBeNull();
		expect(attribution.consumeOwner(6_200)).toBe("founder");
	});

	it("attributes split intervals of the same owner", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("founder", 0);
		attribution.speakingEnd("founder", 100);
		attribution.speakingStart("founder", 200);
		attribution.speakingEnd("founder", 300);
		expect(attribution.consumeOwner(3_000)).toBe("founder");
	});

	it("retains unconsumed speech until a final and leaves absent speech unknown", () => {
		const attribution = new SpeakerAttribution();
		expect(attribution.consumeOwner(0)).toBeNull();
		attribution.speakingStart("founder", 100);
		attribution.speakingEnd("founder", 200);
		expect(attribution.consumeOwner(500_000)).toBe("founder");
		expect(attribution.consumeOwner(500_001)).toBeNull();
	});

	it("continues attributing active speech and closes only the matching open epoch", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("founder", 0);
		attribution.speakingEnd("other", 1);
		expect(attribution.consumeOwner(200)).toBe("founder");
		attribution.speakingEnd("founder", 201);
		expect(attribution.consumeOwner(301)).toBe("founder");
		expect(attribution.consumeOwner(302)).toBeNull();
	});

	it("consumes mixed ended owners so a new epoch can be attributed", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("qa", 0);
		attribution.speakingEnd("qa", 100);
		attribution.speakingStart("founder", 200);
		attribution.speakingEnd("founder", 300);
		expect(attribution.consumeOwner(60_000)).toBeNull();
		expect(attribution.consumeOwner(60_001)).toBeNull();
		attribution.speakingStart("founder", 60_100);
		attribution.speakingEnd("founder", 60_200);
		expect(attribution.consumeOwner(120_000)).toBe("founder");
	});

	it("does not evict an unconsumed different owner after many split intervals", () => {
		const attribution = new SpeakerAttribution();
		attribution.speakingStart("qa", 0);
		attribution.speakingEnd("qa", 1);
		for (let at = 2; at < 500; at += 2) {
			attribution.speakingStart("founder", at);
			attribution.speakingEnd("founder", at + 1);
		}
		expect(attribution.consumeOwner(60_000)).toBeNull();
	});

	it("validates owner and timestamps", () => {
		const attribution = new SpeakerAttribution();
		expect(() => attribution.speakingStart("", 0)).toThrow();
		expect(() => attribution.speakingStart("a", Number.NaN)).toThrow();
		expect(() => attribution.speakingEnd("a", -1)).toThrow();
		expect(() => attribution.consumeOwner(Number.POSITIVE_INFINITY)).toThrow();
	});
});
