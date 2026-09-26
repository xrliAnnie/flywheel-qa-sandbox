/** FLY-2919: the physical execution verdict has no window or workflow-status input. */
export type ExecutionAdapter =
	| "codex-tmux"
	| "claude-tmux"
	| "kimi-tmux"
	| "antigravity-tmux";

export interface ExecutionProcessIdentity {
	pid: number;
	startIdentity: string;
	hostBootId: string;
}

export interface ExecutionProcessBinding extends ExecutionProcessIdentity {
	version: 1;
	adapter: ExecutionAdapter;
	pgid: number;
	executable: string;
	cwd: string;
	nonce: string;
	nativeSessionId: string | null;
	writers: ExecutionProcessIdentity[];
}

export interface BodyIdentity {
	executionId: string;
	activationId: string | null;
	generation: number;
	lifecycleRevision: number;
	adapter: ExecutionAdapter;
}

export interface BodyObservation {
	identity: BodyIdentity;
	ownerToken: string;
	spawnEpoch: number;
	verdict: "alive" | "dead" | "unknown";
	observedAt: string;
	expiresAt: string;
	bindingDigest: string;
	reason: string;
}

export interface ExecutionProcessSample {
	/** Start of the bounded OS capture, not the time a cached sample was read. */
	sampledAtMs: number;
	hostBootId: string;
	/** A complete OS census, with no argv-derived executable identity. */
	processes: Array<{
		pid: number;
		ppid: number;
		pgid: number;
		startIdentity: string;
		state: "running" | "zombie";
	}>;
	/** Exact accepted worker's executable/cwd, read independently of its argv. */
	worker: { executable: string; cwd: string } | null;
	/** Independent daemon socket/group evidence; only required for Codex. */
	daemon?: "alive" | "absent" | "unknown";
	/** Failure to attribute an execution's detached writers cannot prove death. */
	writersComplete: boolean;
	/** Nonce-attributed detached writers discovered by the independent OS census. */
	discoveredWriters?: ExecutionProcessIdentity[];
	/** Subset attributed by exact inherited nonce, independently of process group. */
	nonceWriters?: ExecutionProcessIdentity[];
	/** Only explicitly registered pure viewers can be excluded from writer checks. */
	viewers: ExecutionProcessIdentity[];
}

export interface ExecutionProcessObservationInput {
	identity: BodyIdentity;
	ownerToken: string;
	spawnEpoch: number;
	binding: ExecutionProcessBinding | null;
	bindingDigest: string;
	controller: ExecutionProcessIdentity;
	spawnInflight: boolean;
	restartInProgress: boolean;
	/** A persisted receipt matching this exact owner/epoch/binding. */
	ownerDrained: boolean;
	/** Durable exact-owner close CAS revokes further spawn/restart authority. */
	ownerClosed?: boolean;
	/** A valid FLY-2211 recovery claim with remaining budget takes precedence. */
	recoveryActive: boolean;
	sample: ExecutionProcessSample | null;
	nowMs: number;
}

export function observeExecutionProcesses(
	input: ExecutionProcessObservationInput,
): BodyObservation {
	const clockValid = validTime(input.nowMs);
	const sampledAtMs = input.sample?.sampledAtMs ?? input.nowMs;
	const timestamp = validTime(sampledAtMs) ? sampledAtMs : 0;
	const observation: BodyObservation = {
		identity: { ...input.identity },
		ownerToken: input.ownerToken,
		spawnEpoch: input.spawnEpoch,
		verdict: "unknown",
		observedAt: new Date(timestamp).toISOString(),
		expiresAt: new Date(timestamp + 10_000).toISOString(),
		bindingDigest: input.bindingDigest,
		reason: "process_evidence_unavailable",
	};
	const result = (
		verdict: BodyObservation["verdict"],
		reason: string,
	): BodyObservation => ({ ...observation, verdict, reason });
	const mismatch = () => result("unknown", "process_identity_mismatch");
	const binding = input.binding;
	const sample = input.sample;
	if (
		!clockValid ||
		!validTime(sampledAtMs) ||
		input.nowMs - sampledAtMs < 0 ||
		input.nowMs - sampledAtMs > 5_000
	)
		return result("unknown", "process_sample_expired");
	if (!binding || !sample) return observation;
	const writers = [...binding.writers, ...(sample.discoveredWriters ?? [])];
	if (
		binding.version !== 1 ||
		binding.adapter !== input.identity.adapter ||
		!validIdentity(binding) ||
		!validPid(binding.pgid) ||
		!validIdentity(input.controller) ||
		binding.hostBootId !== sample.hostBootId ||
		input.controller.hostBootId !== sample.hostBootId ||
		!Number.isSafeInteger(input.spawnEpoch) ||
		input.spawnEpoch < 1 ||
		!Number.isSafeInteger(input.identity.generation) ||
		input.identity.generation < 1 ||
		!Number.isSafeInteger(input.identity.lifecycleRevision) ||
		input.identity.lifecycleRevision < 0 ||
		!validText(input.ownerToken) ||
		!validText(input.identity.executionId) ||
		(input.identity.activationId !== null &&
			!validText(input.identity.activationId)) ||
		!/^[a-f0-9]{64}$/.test(input.bindingDigest) ||
		writers.length > 4096 ||
		sample.processes.length > 100_000 ||
		writers.some(
			(writer) =>
				!validIdentity(writer) || writer.hostBootId !== sample.hostBootId,
		) ||
		sample.viewers.some(
			(viewer) =>
				!validIdentity(viewer) || viewer.hostBootId !== sample.hostBootId,
		)
	)
		return mismatch();
	const processes = new Map<
		number,
		ExecutionProcessSample["processes"][number]
	>();
	for (const process of sample.processes) {
		if (
			!Number.isSafeInteger(process.pid) ||
			process.pid < 1 ||
			!Number.isSafeInteger(process.ppid) ||
			process.ppid < 0 ||
			!Number.isSafeInteger(process.pgid) ||
			process.pgid < 0 ||
			!validText(process.startIdentity) ||
			(process.state !== "running" && process.state !== "zombie") ||
			processes.has(process.pid)
		)
			return mismatch();
		processes.set(process.pid, process);
	}
	for (const identity of [binding, input.controller, ...writers]) {
		const found = processes.get(identity.pid);
		if (found && found.startIdentity !== identity.startIdentity)
			return mismatch();
	}
	if (
		input.spawnInflight ||
		(input.restartInProgress && !input.ownerClosed) ||
		input.recoveryActive
	)
		return result("unknown", "controller_recovery_active");
	const worker = processes.get(binding.pid);
	if (worker?.state === "running") {
		if (
			worker.pgid !== binding.pgid ||
			!sample.worker ||
			sample.worker.executable !== binding.executable ||
			sample.worker.cwd !== binding.cwd
		)
			return mismatch();
		if (binding.adapter === "codex-tmux" && sample.daemon !== "alive")
			return observation;
		return result("alive", "accepted_worker_alive");
	}
	const controller = processes.get(input.controller.pid);
	if (
		controller?.state === "running" &&
		!input.ownerDrained &&
		!input.ownerClosed
	)
		return result("unknown", "controller_recovery_active");
	if (!sample.writersComplete) return observation;
	if (binding.adapter === "codex-tmux" && sample.daemon !== "absent")
		return observation;
	const knownWriters = new Set(writers.map((writer) => writer.pid));
	for (const process of processes.values()) {
		if (process.state === "zombie") continue;
		if (knownWriters.has(process.pid))
			return result("unknown", "writers_remain");
		if (process.pgid !== binding.pgid) continue;
		const viewer = sample.viewers.some(
			(candidate) =>
				candidate.pid === process.pid &&
				candidate.startIdentity === process.startIdentity,
		);
		if (!viewer) return result("unknown", "writers_remain");
	}
	return result("dead", "writers_and_controller_gone");
}

/** Consumers call this again inside their synchronous lifecycle CAS. */
export function isCurrentBodyObservation(
	observation: BodyObservation,
	current: Pick<
		ExecutionProcessObservationInput,
		"identity" | "ownerToken" | "spawnEpoch" | "bindingDigest" | "nowMs"
	>,
): boolean {
	const observedAt = Date.parse(observation.observedAt);
	const expiresAt = Date.parse(observation.expiresAt);
	return (
		validTime(current.nowMs) &&
		Number.isFinite(observedAt) &&
		Number.isFinite(expiresAt) &&
		observedAt <= current.nowMs &&
		current.nowMs < expiresAt &&
		expiresAt - observedAt === 10_000 &&
		observation.ownerToken === current.ownerToken &&
		observation.spawnEpoch === current.spawnEpoch &&
		observation.bindingDigest === current.bindingDigest &&
		observation.identity.executionId === current.identity.executionId &&
		observation.identity.activationId === current.identity.activationId &&
		observation.identity.generation === current.identity.generation &&
		observation.identity.lifecycleRevision ===
			current.identity.lifecycleRevision &&
		observation.identity.adapter === current.identity.adapter
	);
}

function validTime(value: number): boolean {
	return (
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 8_640_000_000_000_000 - 10_000
	);
}

function validPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

function validText(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/\p{Cc}/u.test(value)
	);
}

function validIdentity(identity: ExecutionProcessIdentity): boolean {
	return (
		validPid(identity.pid) &&
		validText(identity.startIdentity) &&
		validText(identity.hostBootId)
	);
}
