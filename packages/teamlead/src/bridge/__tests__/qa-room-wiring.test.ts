import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qaRoomServiceEnabled } from "../qa-room-host.js";

describe("QA room production assembly", () => {
	it("defaults to enabled on the host and disabled inside rooms, with explicit rollout control", () => {
		expect(qaRoomServiceEnabled({})).toBe(true);
		expect(qaRoomServiceEnabled({ FLYWHEEL_ISOLATION_ROOT: "/tmp/room" })).toBe(
			false,
		);
		expect(
			qaRoomServiceEnabled({
				FLYWHEEL_ISOLATION_ROOT: "/tmp/room",
				FLYWHEEL_QA_ROOM_SERVICE: "on",
			}),
		).toBe(true);
		expect(qaRoomServiceEnabled({ FLYWHEEL_QA_ROOM_SERVICE: "off" })).toBe(
			false,
		);
		expect(qaRoomServiceEnabled({ FLYWHEEL_QA_ROOM_SERVICE: "typo" })).toBe(
			false,
		);
	});
	it("mounts authenticated room routes and starts/stops its reconciler with the Bridge", () => {
		const source = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain('req.path.startsWith("/qa-rooms/")');
		expect(source).toContain('"/api/qa-rooms"');
		expect(source).toContain("createQaRoomRouter(");
		expect(source).toContain(
			"createLocalQaRoomService(store, flywheelRepoRoot)",
		);
		expect(source).toContain("qaRoomService.start()");
		expect(source).toContain("await qaRoomService.stop()");
	});
});
