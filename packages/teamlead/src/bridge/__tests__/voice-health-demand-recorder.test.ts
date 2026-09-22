import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { VoiceHealthDemandSnapshot } from "../../StateStore.js";
import {
	createVoiceHealthDemandRecorder,
	voiceHealthDemandPayload,
} from "../voice-health-demand-recorder.js";

function snapshot(
	input: Partial<VoiceHealthDemandSnapshot> = {},
): VoiceHealthDemandSnapshot {
	return {
		demandSourceId: "10000000-0000-4000-8000-000000000001",
		revision: 2,
		eventHighWater: 2,
		afterCursor: 0,
		nextCursor: 2,
		hasMore: false,
		gap: false,
		sourceStatus: "available",
		state: "required",
		observedAt: "2026-09-18T20:00:00.000Z",
		digest: "a".repeat(64),
		demandIdentities: [
			{
				demandId: "meeting-1",
				attemptId: "10000000-0000-4000-8000-000000000002",
				projectId: "flywheel",
				meetingId: "meeting-1",
			},
		],
		events: [
			{
				eventSeq: 1,
				mutation: "insert",
				eventKind: "required",
				demandId: "meeting-1",
				attemptId: "10000000-0000-4000-8000-000000000002",
				projectId: "flywheel",
				meetingId: "meeting-1",
				previousState: null,
				state: "provisioning",
				observedAt: "2026-09-18T19:59:00.000Z",
				cancelRequested: false,
				endingStarted: false,
				ended: false,
			},
			{
				eventSeq: 2,
				mutation: "update",
				eventKind: "failed",
				demandId: "meeting-1",
				attemptId: "10000000-0000-4000-8000-000000000002",
				projectId: "flywheel",
				meetingId: "meeting-1",
				previousState: "provisioning",
				state: "failed",
				observedAt: "2026-09-18T20:00:00.000Z",
				reasonClass: "session_create_failed",
				cancelRequested: false,
				endingStarted: false,
				ended: true,
			},
		],
		...input,
	};
}

describe("voice health demand recorder", () => {
	it("projects only the helper's closed schema", () => {
		expect(voiceHealthDemandPayload(snapshot(), false)).toEqual({
			demandSourceId: "10000000-0000-4000-8000-000000000001",
			revision: 2,
			digest: "a".repeat(64),
			state: "required",
			observedAt: "2026-09-18T20:00:00.000Z",
			identities: [
				{
					demandId: "meeting-1",
					attemptId: "10000000-0000-4000-8000-000000000002",
					projectId: "flywheel",
					meetingId: "meeting-1",
				},
			],
			refreshObservedAt: false,
			sourceStatus: "available",
			pageAfterCursor: 0,
			pageNextCursor: 2,
			eventHighWater: 2,
			hasMore: false,
			gap: false,
			events: [
				{
					eventSeq: 1,
					eventKind: "required",
					demandId: "meeting-1",
					attemptId: "10000000-0000-4000-8000-000000000002",
					observedAt: "2026-09-18T19:59:00.000Z",
				},
				{
					eventSeq: 2,
					eventKind: "failed",
					demandId: "meeting-1",
					attemptId: "10000000-0000-4000-8000-000000000002",
					observedAt: "2026-09-18T20:00:00.000Z",
					reasonClass: "session_create_failed",
				},
			],
		});
	});

	// FLY-2693 review R5 (fail-closed-demand-never-reaches-helper): degraded
	// StateStore authority is projected through as an explicit sourceStatus so
	// the helper can publish unknown/unavailable; it is never dropped here.
	it("projects degraded StateStore authority as an explicit fail-closed status", () => {
		for (const sourceStatus of [
			"trigger_invalid",
			"change_gap",
			"demand_overflow",
		] as const) {
			const payload = voiceHealthDemandPayload(
				snapshot({
					sourceStatus,
					state: "unknown",
					demandIdentities: [],
					events: [],
					gap: sourceStatus === "change_gap",
				}),
				false,
			);
			expect(payload).toEqual({
				demandSourceId: "10000000-0000-4000-8000-000000000001",
				revision: 2,
				digest: "a".repeat(64),
				state: "unknown",
				observedAt: "2026-09-18T20:00:00.000Z",
				identities: [],
				refreshObservedAt: false,
				sourceStatus,
			});
		}
		expect(voiceHealthDemandPayload(snapshot(), true)).toMatchObject({
			sourceStatus: "available",
			events: expect.any(Array),
		});
	});

	it("writes bounded JSON over stdin and accepts only closed receipts", async () => {
		let input = "";
		const execFile = vi.fn((_file, _args, _options, callback) => {
			const child = new EventEmitter() as ChildProcess;
			child.stdin = new EventEmitter() as ChildProcess["stdin"];
			Object.assign(child.stdin!, {
				once: child.stdin!.once.bind(child.stdin),
				end: (chunk: string) => {
					input = chunk;
					callback(null, '{"status":"recorded"}', "");
				},
			});
			return child;
		});
		const record = createVoiceHealthDemandRecorder({
			helperPath: "/trusted/voice-health.py",
			stateRoot: "/trusted/state",
			execFile,
		});
		await expect(record(snapshot())).resolves.toBeUndefined();
		expect(execFile).toHaveBeenCalledWith(
			"python3",
			[
				"/trusted/voice-health.py",
				"--state-root",
				"/trusted/state",
				"record-demand",
			],
			expect.objectContaining({ shell: false, timeout: 500 }),
			expect.any(Function),
		);
		expect(JSON.parse(input)).toEqual(
			voiceHealthDemandPayload(snapshot(), false),
		);
	});
});
