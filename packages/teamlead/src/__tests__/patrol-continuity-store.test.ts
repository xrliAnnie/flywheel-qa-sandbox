import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ContinuityObservation,
	sampleContinuity,
} from "../patrol-continuity.js";
import { runPatrolContinuity } from "../patrol-continuity-cli.js";
import { acquireProcessLifetimeFileLock } from "../process-lock.js";

const dirs: string[] = [];
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "patrol-store-"));
	dirs.push(dir);
	return {
		path: join(dir, "flywheel.v2.json"),
		project: "flywheel",
		lead: "eng",
	};
}
const at = 1787248277000;
function observation(nowMs = at): ContinuityObservation {
	return {
		identity: {
			project: "flywheel",
			lead: "eng",
			executionId: "exec",
			activationId: "legacy:exec",
			runId: null,
			nodeId: null,
			attempt: null,
			turnEpoch: null,
			bindingGeneration: "one",
			repoSourceIdentity: "root:repo:branch",
		},
		sampledAtMs: nowMs,
		semanticState: {
			sessionStatus: "running",
			sessionStage: "implement",
			nodeState: null,
			turnRelation: "legacy",
			effectiveWait: null,
		},
		refs: [
			{
				repoIdentity: "owner/repo",
				fullRef: "refs/heads/work",
				headSha: "a".repeat(40),
				observedAtMs: nowMs,
			},
		],
		ownershipComplete: true,
		sourcesComplete: true,
		eventsComplete: true,
		canAttributeRemote: true,
		sourceCursors: { stageEventId: 0, workflowEventSeq: 0 },
	};
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
describe("continuity sidecar", () => {
	it.each(["true", "false"])(
		"CLI prunes retired entries only with complete inventory=%s",
		async (complete) => {
			const input = fixture();
			const stateDir = join(input.path, "..");
			const path = join(
				stateDir,
				"patrol-continuity",
				input.lead,
				`${input.project}.v2.json`,
			);
			const nowMs = Date.now();
			await sampleContinuity({
				...input,
				path,
				nowMs,
				executionIds: ["exec"],
				collect: async () => [observation(nowMs)],
			});
			const inventory = join(stateDir, "executions.json");
			writeFileSync(inventory, "[]");
			expect(
				await runPatrolContinuity([
					"sample",
					"--project",
					input.project,
					"--lead",
					input.lead,
					"--state-dir",
					stateDir,
					"--executions-file",
					inventory,
					"--inventory-complete",
					complete,
				]),
			).toBe(0);
			expect(
				Object.keys(JSON.parse(readFileSync(path, "utf8")).entries),
			).toHaveLength(complete === "true" ? 0 : 1);
		},
	);

	it("persists baseline and resumes negative coverage with restrictive mode", async () => {
		const input = fixture();
		await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => [observation()],
		});
		const result = await sampleContinuity({
			...input,
			nowMs: at + 3600000,
			executionIds: ["exec"],
			collect: async () => [observation(at + 3600000)],
		});
		expect(result.facts.exec.activity).toBe("STALLED_60M");
		expect(statSync(input.path).mode & 0o777).toBe(0o600);
	});
	it.each([
		"{bad",
		JSON.stringify({ version: 1 }),
		JSON.stringify({
			version: 2,
			project: "other",
			lead: "eng",
			sampledAtMs: at,
			entries: {},
		}),
	])("preserves corrupt or mismatched bytes: %s", async (bytes) => {
		const input = fixture();
		writeFileSync(input.path, bytes);
		const result = await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => [observation()],
		});
		expect(result.facts.exec.activity).toBe("UNKNOWN");
		expect(readFileSync(input.path, "utf8")).toBe(bytes);
	});
	it("refuses an overlapping sampler then permits a new one after lock release", async () => {
		const input = fixture();
		let release!: () => void;
		let entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		const hold = new Promise<void>((r) => {
			release = r;
		});
		const first = sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => {
				entered();
				await hold;
				return [observation()];
			},
		});
		await ready;
		const second = await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => [observation()],
		});
		expect(second.facts.exec.reason).toBe("lock_conflict");
		release();
		await first;
		expect(
			(
				await sampleContinuity({
					...input,
					nowMs: at,
					executionIds: ["exec"],
					collect: async () => [observation()],
				})
			).facts.exec.activity,
		).toBe("OBSERVING");
	});
	it("preserves a coverage break when failed identity collection returns an unknown key", async () => {
		const input = fixture();
		await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => [observation()],
		});
		const bad = observation(at + 1000);
		bad.identity.activationId = "unavailable:exec";
		bad.ownershipComplete = false;
		await sampleContinuity({
			...input,
			nowMs: at + 1000,
			executionIds: ["exec"],
			collect: async () => [bad],
		});
		const resumed = await sampleContinuity({
			...input,
			nowMs: at + 3600000,
			executionIds: ["exec"],
			collect: async () => [observation(at + 3600000)],
		});
		expect(resumed.facts.exec.activity).toBe("OBSERVING");
	});
	it("releases the kernel lock after SIGKILL without publishing the lost writer", async () => {
		const input = fixture();
		let pid: number | undefined;
		let release!: () => void;
		let entered!: () => void;
		let observedLoss!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		const held = new Promise<void>((r) => {
			release = r;
		});
		const lost = new Promise<void>((r) => {
			observedLoss = r;
		});
		const first = sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			acquireLock: async (path, options) => {
				const lock = await acquireProcessLifetimeFileLock(path, {
					...options,
					onLost: (error) => {
						options?.onLost?.(error);
						observedLoss();
					},
				});
				if (lock.status === "acquired") pid = lock.handle.helperPid;
				return lock;
			},
			collect: async () => {
				entered();
				await held;
				return [observation()];
			},
		});
		await ready;
		expect(pid).toBeDefined();
		process.kill(pid!, "SIGKILL");
		await lost;
		release();
		expect((await first).facts.exec.reason).toBe("lock_lost");
		expect(
			(
				await sampleContinuity({
					...input,
					nowMs: at,
					executionIds: ["exec"],
					collect: async () => [observation()],
				})
			).facts.exec.activity,
		).toBe("OBSERVING");
	});

	it("does not publish after loss of the lock", async () => {
		const input = fixture();
		let lost: (error: string) => void = () => {};
		const result = await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			acquireLock: async (_path, opts) => {
				lost = opts?.onLost ?? lost;
				return { status: "acquired", handle: { close: async () => {} } };
			},
			collect: async () => {
				lost("gone");
				return [observation()];
			},
		});
		expect(result.facts.exec.reason).toBe("lock_lost");
		expect(() => readFileSync(input.path)).toThrow();
	});
	it("breaks coverage after collection failure and never treats the outage as quiet time", async () => {
		const input = fixture();
		await sampleContinuity({
			...input,
			nowMs: at,
			executionIds: ["exec"],
			collect: async () => [observation()],
		});
		const failed = await sampleContinuity({
			...input,
			nowMs: at + 1000,
			executionIds: ["exec"],
			collect: async () => {
				throw Error("private data");
			},
		});
		expect(failed.facts.exec.reason).toBe("collection_failed");
		expect(JSON.stringify(failed)).not.toContain("private data");
		const resumed = await sampleContinuity({
			...input,
			nowMs: at + 3600000,
			executionIds: ["exec"],
			collect: async () => [observation(at + 3600000)],
		});
		expect(resumed.facts.exec.activity).toBe("OBSERVING");
	});
});
