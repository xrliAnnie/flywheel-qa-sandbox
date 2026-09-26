import { describe, expect, it } from "vitest";
import {
	type ExecutionAdapter,
	type ExecutionProcessObservationInput,
	isCurrentBodyObservation,
	observeExecutionProcesses,
} from "../src/execution-process-liveness.js";

function fixture(
	adapter: ExecutionAdapter = "codex-tmux",
): ExecutionProcessObservationInput {
	return {
		identity: {
			executionId: "exec-1",
			activationId: "activation-1",
			generation: 2,
			lifecycleRevision: 3,
			adapter,
		},
		ownerToken: "owner-1",
		spawnEpoch: 4,
		bindingDigest: "a".repeat(64),
		binding: {
			version: 1,
			adapter,
			pid: 200,
			pgid: 200,
			startIdentity: "worker-start",
			hostBootId: "boot-1",
			executable: "/opt/worker",
			cwd: "/work",
			nonce: "exec-1-spawn-4",
			nativeSessionId: null,
			writers: [],
		},
		controller: {
			pid: 100,
			startIdentity: "controller-start",
			hostBootId: "boot-1",
		},
		spawnInflight: false,
		restartInProgress: false,
		ownerDrained: false,
		recoveryActive: false,
		nowMs: 100_000,
		sample: {
			sampledAtMs: 100_000,
			hostBootId: "boot-1",
			processes: [
				{
					pid: 100,
					ppid: 1,
					pgid: 100,
					startIdentity: "controller-start",
					state: "running",
				},
				{
					pid: 200,
					ppid: 100,
					pgid: 200,
					startIdentity: "worker-start",
					state: "running",
				},
			],
			worker: { executable: "/opt/worker", cwd: "/work" },
			daemon: "alive",
			writersComplete: true,
			viewers: [],
		},
	};
}

function gone(input = fixture()): ExecutionProcessObservationInput {
	input.sample!.processes = [];
	input.sample!.worker = null;
	input.sample!.daemon = "absent";
	return input;
}

describe("FLY-2919 execution process truth", () => {
	it.each(["detached", "foreign_boot", "pid_reused"])(
		"retains independently discovered %s writers",
		(kind) => {
			const input = gone();
			Object.assign(input.sample!, {
				discoveredWriters: [
					{
						pid: 300,
						startIdentity: "writer-start",
						hostBootId: kind === "foreign_boot" ? "boot-2" : "boot-1",
					},
				],
			});
			input.sample!.processes.push({
				pid: 300,
				pgid: 300,
				ppid: 1,
				startIdentity: kind === "pid_reused" ? "other-start" : "writer-start",
				state: "running",
			});
			expect(observeExecutionProcesses(input).verdict).toBe("unknown");
		},
	);
	it.each(["expired", "future", "invalid_clock"])(
		"refuses %s sampling time",
		(kind) => {
			const input = gone();
			if (kind === "expired") input.nowMs += 5_001;
			if (kind === "future") input.sample!.sampledAtMs += 1;
			if (kind === "invalid_clock") input.nowMs = NaN;
			expect(observeExecutionProcesses(input).verdict).toBe("unknown");
		},
	);

	it.each([
		"executionId",
		"activationId",
		"generation",
		"lifecycleRevision",
		"adapter",
		"ownerToken",
		"spawnEpoch",
		"bindingDigest",
		"expired",
		"future",
	])("rejects stale %s observation before a consumer CAS", (key) => {
		const input = gone();
		const observation = observeExecutionProcesses(input);
		expect(isCurrentBodyObservation(observation, input)).toBe(true);
		if (key === "executionId") input.identity.executionId = "exec-2";
		if (key === "activationId") input.identity.activationId = "activation-2";
		if (key === "generation") input.identity.generation++;
		if (key === "lifecycleRevision") input.identity.lifecycleRevision++;
		if (key === "adapter") input.identity.adapter = "claude-tmux";
		if (key === "ownerToken") input.ownerToken = "owner-2";
		if (key === "spawnEpoch") input.spawnEpoch++;
		if (key === "bindingDigest") input.bindingDigest = "b".repeat(64);
		if (key === "expired") input.nowMs += 10_000;
		if (key === "future") input.nowMs--;
		expect(isCurrentBodyObservation(observation, input)).toBe(false);
	});

	it("cannot turn an accepted writer into a viewer to prove death", () => {
		const input = gone();
		const writer = {
			pid: 300,
			startIdentity: "writer-start",
			hostBootId: "boot-1",
		};
		input.binding!.writers.push(writer);
		input.sample!.viewers.push(writer);
		input.sample!.processes.push({
			pid: 300,
			pgid: 200,
			ppid: 1,
			startIdentity: "writer-start",
			state: "running",
		});
		expect(observeExecutionProcesses(input).verdict).toBe("unknown");
	});
	for (const adapter of [
		"codex-tmux",
		"claude-tmux",
		"kimi-tmux",
		"antigravity-tmux",
	] as const) {
		it.each(["absent", "present", "pending"])(
			`${adapter}: window %s cannot kill a live worker or preserve a dead body`,
			(windowState) => {
				const live = { ...fixture(adapter), windowState };
				expect(observeExecutionProcesses(live).verdict).toBe("alive");
				const dead = { ...gone(fixture(adapter)), windowState };
				expect(observeExecutionProcesses(dead)).toMatchObject({
					verdict: "dead",
					reason: "writers_and_controller_gone",
				});
			},
		);
	}

	it("binds a verdict to the complete owner identity and ten-second observation interval", () => {
		const input = fixture();
		expect(observeExecutionProcesses(input)).toMatchObject({
			identity: input.identity,
			ownerToken: "owner-1",
			spawnEpoch: 4,
			bindingDigest: input.bindingDigest,
			observedAt: new Date(100_000).toISOString(),
			expiresAt: new Date(110_000).toISOString(),
			verdict: "alive",
		});
	});

	it.each([
		"pid_reused",
		"boot",
		"executable",
		"cwd",
		"adapter",
		"duplicate_pid",
		"malformed_pid",
	])("refuses %s identity instead of authorizing death", (kind) => {
		const input = fixture();
		if (kind === "pid_reused")
			input.sample!.processes[1]!.startIdentity = "foreign-start";
		if (kind === "boot") input.sample!.hostBootId = "boot-2";
		if (kind === "executable") input.sample!.worker!.executable = "/foreign";
		if (kind === "cwd") input.sample!.worker!.cwd = "/foreign";
		if (kind === "adapter") input.binding!.adapter = "claude-tmux";
		if (kind === "duplicate_pid")
			input.sample!.processes.push({ ...input.sample!.processes[1]! });
		if (kind === "malformed_pid") input.sample!.processes[1]!.pid = NaN;
		expect(observeExecutionProcesses(input)).toMatchObject({
			verdict: "unknown",
			reason: "process_identity_mismatch",
		});
	});

	it.each(["binding", "sample", "writer_census", "socket"])(
		"missing %s evidence stays unknown",
		(kind) => {
			const input = gone();
			if (kind === "binding") input.binding = null;
			if (kind === "sample") input.sample = null;
			if (kind === "writer_census") input.sample!.writersComplete = false;
			if (kind === "socket") input.sample!.daemon = "unknown";
			expect(observeExecutionProcesses(input).verdict).toBe("unknown");
		},
	);

	it.each(["spawnInflight", "restartInProgress", "recoveryActive"] as const)(
		"%s fences death while the worker is absent",
		(key) => {
			const input = gone();
			input[key] = true;
			expect(observeExecutionProcesses(input)).toMatchObject({
				verdict: "unknown",
				reason: "controller_recovery_active",
			});
		},
	);

	it("a live exact controller fences an absent daemon across the whole goal", () => {
		const input = gone();
		input.sample!.processes.push({
			pid: 100,
			ppid: 1,
			pgid: 100,
			startIdentity: "controller-start",
			state: "running",
		});
		expect(observeExecutionProcesses(input)).toMatchObject({
			verdict: "unknown",
			reason: "controller_recovery_active",
		});
		input.ownerDrained = true;
		expect(observeExecutionProcesses(input).verdict).toBe("dead");
	});

	it.each(["reparented", "detached", "zombie", "pid_reused"])(
		"tracks a previously accepted %s writer after its parent exited",
		(kind) => {
			const input = gone();
			input.binding!.writers = [
				{ pid: 300, startIdentity: "writer-start", hostBootId: "boot-1" },
			];
			input.sample!.processes.push({
				pid: 300,
				ppid: 1,
				pgid: kind === "detached" ? 300 : 200,
				startIdentity: kind === "pid_reused" ? "foreign-start" : "writer-start",
				state: kind === "zombie" ? "zombie" : "running",
			});
			expect(observeExecutionProcesses(input).verdict).toBe(
				kind === "zombie" ? "dead" : "unknown",
			);
		},
	);

	it("a remaining group member prevents death even when it was not present at initial binding", () => {
		const input = gone();
		input.sample!.processes.push({
			pid: 300,
			ppid: 1,
			pgid: 200,
			startIdentity: "dev-server-start",
			state: "running",
		});
		expect(observeExecutionProcesses(input)).toMatchObject({
			verdict: "unknown",
			reason: "writers_remain",
		});
	});

	it("only exact registered viewer identities are excluded", () => {
		const input = gone();
		input.sample!.processes.push({
			pid: 300,
			ppid: 1,
			pgid: 200,
			startIdentity: "viewer-start",
			state: "running",
		});
		input.sample!.viewers.push({
			pid: 300,
			startIdentity: "viewer-start",
			hostBootId: "boot-1",
		});
		expect(observeExecutionProcesses(input).verdict).toBe("dead");
		input.sample!.viewers[0]!.startIdentity = "stale-viewer";
		expect(observeExecutionProcesses(input).verdict).toBe("unknown");
	});
});
