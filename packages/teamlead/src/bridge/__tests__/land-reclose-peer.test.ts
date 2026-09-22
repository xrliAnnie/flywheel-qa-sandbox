import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LandOperationRow, StateStore } from "../../StateStore.js";
import {
	collectVerifiedPeerChain,
	parseLandReclosePeerRequest,
	startLandReclosePeerServer,
} from "../land-reclose-peer.js";
import type {
	ReclosePeerNativeAdapter,
	ReclosePeerSnapshot,
	RecloseProcessSnapshot,
} from "../reclose-peer-native.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function processSnapshot(
	pid: number,
	parentPid: number,
	uniqueId: string,
	parentUniqueId: string,
): RecloseProcessSnapshot {
	return {
		pid,
		parentPid,
		uid: 501,
		startSeconds: String(1_700_000_000 + pid),
		startMicroseconds: pid,
		uniqueId,
		parentUniqueId,
		pidVersion: pid + 1_000,
		originalParentPidVersion: parentPid + 1_000,
	};
}

describe("land reclose native peer", () => {
	it("parses only the bounded closeout-only request tuple", () => {
		const request = {
			schemaVersion: 1 as const,
			method: "land.reclose" as const,
			operationId: "land:one",
			expectedResumeGeneration: 3,
			expectedApprovedHead: "a".repeat(40),
			reason: "retry closeout",
			requestId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
		};
		expect(parseLandReclosePeerRequest(request)).toEqual(request);
		expect(() =>
			parseLandReclosePeerRequest({ ...request, actor: "self-asserted" }),
		).toThrow("request_invalid");
	});

	it("requires a stable peer-to-holder chain and rejects runner ancestry", () => {
		const holder = processSnapshot(10, 1, "holder", "root");
		const parent = processSnapshot(20, 10, "parent", holder.uniqueId);
		const peer = {
			...processSnapshot(30, 20, "peer", parent.uniqueId),
			effectiveUid: 501,
			effectiveGid: 20,
			auditPidVersion: 1_030,
		} satisfies ReclosePeerSnapshot;
		const adapter = {
			inspectProcess: (pid: number) =>
				pid === holder.pid ? holder : pid === parent.pid ? parent : peer,
		};

		expect(
			collectVerifiedPeerChain({
				peer,
				holderPid: holder.pid,
				adapter,
				runnerRootPids: new Set(),
			}).map((item) => item.pid),
		).toEqual([30, 20, 10]);
		expect(() =>
			collectVerifiedPeerChain({
				peer,
				holderPid: holder.pid,
				adapter,
				runnerRootPids: new Set([20]),
			}),
		).toThrow("runner_peer_forbidden");
		expect(() =>
			collectVerifiedPeerChain({
				peer: { ...peer, parentUniqueId: "reused-parent" },
				holderPid: holder.pid,
				adapter,
				runnerRootPids: new Set(),
			}),
		).toThrow("peer_ancestry_indeterminate");
	});

	it("derives the actor from the accepted handle and revalidates before resume", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2662-peer-")));
		roots.push(root);
		const request = {
			schemaVersion: 1,
			method: "land.reclose",
			operationId: "land:one",
			expectedResumeGeneration: 3,
			expectedApprovedHead: "a".repeat(40),
			reason: "retry closeout",
			requestId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
		};
		const responses: string[] = [];
		let accepted = false;
		const adapter = {
			abiVersion: () => 2,
			createListener: () => 1,
			accept: () => {
				if (accepted) return null;
				accepted = true;
				return 2;
			},
			readFrame: () => ({
				complete: true as const,
				frame: JSON.stringify(request),
			}),
			writeFrame: (_handle: number, frame: string) => {
				responses.push(frame);
				return true;
			},
			getPeerSnapshot: vi.fn(),
			revalidatePeer: vi.fn(),
			inspectProcess: vi.fn(),
			close: () => true,
		} satisfies ReclosePeerNativeAdapter;
		const operation = {
			operation_id: "land:one",
			project_name: "flywheel",
			issue_id: "FLY-2662",
			approved_head: "a".repeat(40),
		} as LandOperationRow;
		const resume = vi.fn(async () => ({
			ok: true as const,
			operation,
		}));
		const assertCurrent = vi.fn();
		const server = startLandReclosePeerServer({
			adapter,
			socketPath: join(root, "reclose.sock"),
			store: {
				getLandOperation: () => operation,
			} as unknown as StateStore,
			resume,
			kick: vi.fn(),
			authorize: () => ({
				actor: "authenticated-reclose-peer:server-derived",
				assertCurrent,
			}),
			pollIntervalMs: 1,
		});
		try {
			await vi.waitFor(() => expect(responses).toHaveLength(1));
			expect(assertCurrent).toHaveBeenCalledOnce();
			expect(resume).toHaveBeenCalledWith(
				expect.objectContaining({
					actor: "authenticated-reclose-peer:server-derived",
					mode: "closeout_only",
				}),
			);
			expect(JSON.parse(responses[0]!)).toMatchObject({
				requestId: request.requestId,
				ok: true,
			});
		} finally {
			server.close();
		}
	});

	it("contains response write failures after a peer disconnects", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "fly2662-peer-write-")),
		);
		roots.push(root);
		let accepted = false;
		const close = vi.fn(() => true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const adapter = {
			abiVersion: () => 2,
			createListener: () => 1,
			accept: () => {
				if (accepted) return null;
				accepted = true;
				return 2;
			},
			readFrame: () => ({ complete: true as const, frame: "not-json" }),
			writeFrame: () => {
				throw Error("peer_write_failed: EPIPE");
			},
			getPeerSnapshot: vi.fn(),
			revalidatePeer: vi.fn(),
			inspectProcess: vi.fn(),
			close,
		} satisfies ReclosePeerNativeAdapter;
		const server = startLandReclosePeerServer({
			adapter,
			socketPath: join(root, "reclose.sock"),
			store: {
				getLandOperation: vi.fn(),
			} as unknown as StateStore,
			resume: vi.fn(),
			kick: vi.fn(),
			pollIntervalMs: 1,
		});
		try {
			await vi.waitFor(() => expect(close).toHaveBeenCalledWith(2));
			await vi.waitFor(() =>
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("peer_write_failed"),
				),
			);
		} finally {
			server.close();
			warn.mockRestore();
		}
	});
});
