export interface LeadRuntimeConfigTarget {
	projectName: string;
	leadKey: string;
	identityDigest: string;
	carrierId: string;
	ownerEpoch: string;
	runtimeGeneration: string;
	threadId: string;
	operationId: string;
	configDigest: string;
	configGeneration: number;
	modelRegistryRevision: string;
	model: string;
	effort: string;
}
export type LeadRuntimeConfigIdentity = Pick<
	LeadRuntimeConfigTarget,
	| "projectName"
	| "leadKey"
	| "identityDigest"
	| "carrierId"
	| "ownerEpoch"
	| "runtimeGeneration"
	| "threadId"
> & { artifactBuildSha: string; bootstrapBuildSha: string };
export interface LeadRuntimeConfigReceipt extends LeadRuntimeConfigTarget {
	status: "applied";
	appliedAt: string;
	readback?: {
		source: "native_readback";
		model: string;
		effort: string;
		readAt: string;
	};
}
export type LeadRuntimeConfigResult =
	| LeadRuntimeConfigReceipt
	| {
			status: "pending_runtime" | "drifted";
			operationId: string;
	  };
interface SettingsProcess {
	on(
		event: "notification",
		listener: (method: string, params: unknown) => void,
	): unknown;
	off(
		event: "notification",
		listener: (method: string, params: unknown) => void,
	): unknown;
	updateThreadSettings(args: {
		threadId: string;
		model: string;
		effort: string;
	}): Promise<void>;
	readThreadSettings(
		threadId: string,
	): Promise<{ model: string; effort: string }>;
}
function key(target: LeadRuntimeConfigTarget): string {
	return JSON.stringify([
		target.projectName,
		target.leadKey,
		target.identityDigest,
		target.carrierId,
		target.ownerEpoch,
		target.runtimeGeneration,
		target.threadId,
		target.operationId,
		target.configDigest,
		target.configGeneration,
		target.modelRegistryRevision,
		target.model,
		target.effort,
	]);
}
function pairMatches(
	target: LeadRuntimeConfigTarget,
	value: { model: string; effort: string },
): boolean {
	return value.model === target.model && value.effort === target.effort;
}

/** Raw settings listener runs independently of turn demux. It never starts or interrupts a turn. */
export class LeadRuntimeConfigCoordinator {
	private closed = false;
	private lastReceipt?: LeadRuntimeConfigReceipt;
	private driftKey?: string;
	private waiting?: {
		target: LeadRuntimeConfigTarget;
		finish: (matched: boolean) => void;
		latestMatches?: boolean;
	};
	private flight?: Promise<LeadRuntimeConfigResult>;
	constructor(
		private readonly deps: {
			process: SettingsProcess;
			/** Read and validate registry/summary plus current carrier/thread, never launch env. */
			readAuthority: () => LeadRuntimeConfigTarget;
			/** Must persist before the caller can receive applied. */
			persistReceipt: (receipt: LeadRuntimeConfigReceipt) => void;
			initialReceipt?: LeadRuntimeConfigReceipt;
			onDrift?: (target: LeadRuntimeConfigTarget) => void;
			beforeUpdate?: (target: LeadRuntimeConfigTarget) => Promise<void>;
			applyTimeoutMs?: number;
			readTimeoutMs?: number;
			now?: () => Date;
		},
	) {
		this.lastReceipt = deps.initialReceipt;
		deps.process.on("notification", this.onNotification);
	}

	private markDrift(target: LeadRuntimeConfigTarget): void {
		this.driftKey = key(target);
		this.deps.onDrift?.(target);
	}

	private assertCurrent(target: LeadRuntimeConfigTarget): void {
		if (this.closed) throw new Error("runtime_config_closed");
		if (key(this.deps.readAuthority()) !== key(target))
			throw new Error("runtime_config_authority_changed");
	}

	private readonly onNotification = (method: string, params: unknown): void => {
		if (
			method !== "thread/settings/updated" ||
			!params ||
			typeof params !== "object"
		)
			return;
		const value = params as {
			threadId?: unknown;
			threadSettings?: { model?: unknown; effort?: unknown };
		};
		const settings = value.threadSettings;
		if (
			!settings ||
			typeof settings.model !== "string" ||
			!settings.model ||
			typeof settings.effort !== "string" ||
			!settings.effort
		)
			return;
		const pair = { model: settings.model, effort: settings.effort };
		const waiting = this.waiting;
		if (waiting && value.threadId === waiting.target.threadId) {
			waiting.latestMatches = pairMatches(waiting.target, pair);
			if (waiting.latestMatches) waiting.finish(true);
		}
		const receipt = this.lastReceipt;
		if (!receipt || value.threadId !== receipt.threadId) return;
		try {
			this.assertCurrent(receipt);
			if (!pairMatches(receipt, pair)) this.markDrift(receipt);
		} catch {
			/* stale carrier or invalid source cannot authorize a status transition */
		}
	};

	async apply(
		input: LeadRuntimeConfigTarget,
	): Promise<LeadRuntimeConfigResult> {
		const target = { ...input };
		this.assertCurrent(target);
		if (this.driftKey === key(target))
			return { status: "drifted", operationId: target.operationId };
		if (this.flight)
			return { status: "pending_runtime", operationId: target.operationId };
		const completion = Promise.resolve().then(() => this.applyOne(target));
		this.flight = completion;
		const clear = () => {
			if (this.flight === completion) this.flight = undefined;
		};
		// The RPC may outlive the caller's 10s wait. Keep the serialization lock
		// until it really settles, and observe late rejection without leaking it.
		void completion.then(clear, clear);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				completion,
				new Promise<LeadRuntimeConfigResult>((resolve) => {
					timer = setTimeout(
						() =>
							resolve({
								status: "pending_runtime",
								operationId: target.operationId,
							}),
						this.deps.applyTimeoutMs ?? 10_000,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async applyOne(
		target: LeadRuntimeConfigTarget,
	): Promise<LeadRuntimeConfigResult> {
		if (this.lastReceipt && key(this.lastReceipt) === key(target)) {
			const pair = await this.readCurrent(target);
			this.assertCurrent(target);
			if (pairMatches(target, pair)) return this.lastReceipt;
			this.markDrift(target);
			return { status: "drifted", operationId: target.operationId };
		}
		let current: { model: string; effort: string } | undefined;
		try {
			current = await this.readCurrent(target);
		} catch {
			// A readback optimization must not disable the existing mutation path.
			this.assertCurrent(target);
		}
		if (current && pairMatches(target, current))
			return this.persistApplied(target, current);
		if (this.deps.beforeUpdate) {
			await this.deps.beforeUpdate(target);
			this.assertCurrent(target);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finish!: (matched: boolean) => void;
		const notification = new Promise<boolean>((resolve) => {
			finish = resolve;
			timer = setTimeout(
				() => resolve(false),
				this.deps.applyTimeoutMs ?? 10_000,
			);
		});
		this.waiting = { target, finish };
		try {
			this.assertCurrent(target);
			await this.deps.process.updateThreadSettings({
				threadId: target.threadId,
				model: target.model,
				effort: target.effort,
			});
			this.assertCurrent(target);
			const matched = await notification;
			this.assertCurrent(target);
			if (!matched)
				return { status: "pending_runtime", operationId: target.operationId };
			if (this.waiting?.latestMatches !== true) {
				this.markDrift(target);
				return { status: "drifted", operationId: target.operationId };
			}
			return this.persistApplied(target);
		} finally {
			if (timer) clearTimeout(timer);
			finish(false);
			if (this.waiting?.target === target) this.waiting = undefined;
		}
	}

	private persistApplied(
		target: LeadRuntimeConfigTarget,
		readback?: { model: string; effort: string },
	): LeadRuntimeConfigReceipt {
		this.assertCurrent(target);
		const appliedAt = (this.deps.now?.() ?? new Date()).toISOString();
		const receipt: LeadRuntimeConfigReceipt = {
			...target,
			status: "applied",
			appliedAt,
			...(readback
				? {
						readback: {
							source: "native_readback" as const,
							model: readback.model,
							effort: readback.effort,
							readAt: appliedAt,
						},
					}
				: {}),
		};
		this.deps.persistReceipt(receipt);
		this.lastReceipt = receipt;
		this.driftKey = undefined;
		return receipt;
	}

	/** Readback alone cannot manufacture a receipt outside an explicit apply generation. */
	async readCurrent(
		target: LeadRuntimeConfigTarget,
	): Promise<{ model: string; effort: string }> {
		this.assertCurrent(target);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const pair = await Promise.race([
				this.deps.process.readThreadSettings(target.threadId),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("runtime_config_read_timeout")),
						this.deps.readTimeoutMs ?? 1_000,
					);
				}),
			]);
			this.assertCurrent(target);
			if (
				this.lastReceipt &&
				key(this.lastReceipt) === key(target) &&
				!pairMatches(target, pair)
			)
				this.markDrift(target);
			return pair;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	close(): void {
		this.closed = true;
		this.deps.process.off("notification", this.onNotification);
		this.waiting?.finish(false);
	}
}
