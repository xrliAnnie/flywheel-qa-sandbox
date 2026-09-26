import { describe, expect, it, vi } from "vitest";
import { startGlawLeaseHeartbeat } from "../huddle/GlawLeaseHeartbeat.js";
import type { ResidentVoiceLease } from "../resident-voice-session.js";

function leaseFixture() {
	let onLost: ((error: Error) => void) | undefined;
	const stopRenewing = vi.fn();
	const lease = {
		assertActive: vi.fn(),
		startRenewing: vi.fn((listener: (error: Error) => void) => {
			onLost = listener;
			return stopRenewing;
		}),
	} as unknown as ResidentVoiceLease;
	return { lease, stopRenewing, lose: (error: Error) => onLost?.(error) };
}

describe("startGlawLeaseHeartbeat", () => {
	it("renews for the meeting lifetime, tears down on loss, and ignores stale loss after stop", async () => {
		const fixture = leaseFixture();
		const onLost = vi.fn(async () => undefined);
		const log = vi.fn();
		const heartbeat = startGlawLeaseHeartbeat({
			lease: fixture.lease,
			onLost,
			log,
		});

		expect(fixture.lease.startRenewing).toHaveBeenCalledOnce();
		heartbeat.assertHealthy();
		expect(fixture.lease.assertActive).toHaveBeenCalledOnce();

		fixture.lose(new Error("resident_voice_lease_lost"));
		await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce());
		expect(() => heartbeat.assertHealthy()).toThrow(
			"resident_voice_lease_lost",
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("resident lease lost"),
		);

		heartbeat.stop();
		heartbeat.stop();
		expect(fixture.stopRenewing).toHaveBeenCalledOnce();
		fixture.lose(new Error("stale renewal"));
		await Promise.resolve();
		expect(onLost).toHaveBeenCalledOnce();
	});
});
