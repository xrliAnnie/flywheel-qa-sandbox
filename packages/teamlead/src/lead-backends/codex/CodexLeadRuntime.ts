/**
 * FLY-224 Phase 2b — CodexLeadRuntime: the lifecycle orchestrator that brings a
 * Codex Lead up in the correct order and tears it down cleanly (plan §4 + Phase 0A
 * §2/§6). This is the spine the `codex-lead-runtime` entrypoint runs; the concrete
 * steps (spawn app-server, start/resume thread, wire the 14 components, recover the
 * journal, open the Discord gateway) are INJECTED so the ordering is unit-tested
 * without starting anything real (Phase-4b guardrail).
 *
 * Start order (each step strictly after the previous):
 *   startProcess → ensureThread → wire(threadId) → recover() → startGateway()
 * The journal `recover()` (crash reconcile) MUST complete BEFORE the gateway opens,
 * so no fresh Discord input is processed until durable state is reconciled.
 *
 * Stop order (reverse): stopGateway → shutdownProcess. Stop is best-effort and
 * safe to call before start / twice. If any start step throws, the runtime
 * best-effort tears down whatever already came up, then rethrows (fail loud).
 *
 * Supervision: the runtime does NOT restart itself — launchd is the sole restarter
 * (Phase 0A §6). `healthProbe()` exposes the current verdict for the supervisor.
 */

import type { LeadHealthVerdict } from "./LeadHealthProbe.js";

export interface RuntimeWiring {
	/** Journal crash-recovery — runs BEFORE the gateway opens. */
	recover: () => Promise<void>;
	startGateway: () => Promise<void>;
	stopGateway: () => Promise<void>;
}

export interface CodexLeadRuntimeSteps {
	/** Spawn + initialize the app-server (CodexLeadProcess.start). */
	startProcess: () => Promise<void>;
	/** Start a new thread or resume the persisted one → threadId. */
	ensureThread: () => Promise<string>;
	/** Build executor/router/sender/gateway bound to the thread; return controls. */
	wire: (threadId: string) => Promise<RuntimeWiring>;
	/** Shut the app-server down (idempotent). */
	shutdownProcess: () => Promise<void>;
	/** Current health verdict (for the supervisor). */
	healthProbe?: () => LeadHealthVerdict;
	logger?: {
		info?: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	};
}

export class CodexLeadRuntime {
	private readonly steps: CodexLeadRuntimeSteps;
	private readonly logger: {
		info: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	};
	private wiring: RuntimeWiring | null = null;
	private started = false;
	private starting = false;

	constructor(steps: CodexLeadRuntimeSteps) {
		this.steps = steps;
		const l = steps.logger;
		this.logger = {
			info: l?.info ?? (() => {}),
			warn: l?.warn ?? (() => {}),
			error: l?.error ?? (() => {}),
		};
	}

	async start(): Promise<void> {
		if (this.started || this.starting) return;
		this.starting = true;
		let processUp = false;
		try {
			await this.steps.startProcess();
			processUp = true;
			const threadId = await this.steps.ensureThread();
			this.wiring = await this.steps.wire(threadId);
			// Reconcile durable journal BEFORE accepting any new Discord input.
			await this.wiring.recover();
			await this.wiring.startGateway();
			this.started = true;
			this.logger.info("CodexLeadRuntime started", { threadId });
		} catch (err) {
			this.logger.error("CodexLeadRuntime start failed → tearing down", {
				err: (err as Error).message,
			});
			// Best-effort cleanup of whatever came up, then fail loud.
			await this.safe(() => this.wiring?.stopGateway());
			if (processUp) await this.safe(() => this.steps.shutdownProcess());
			this.wiring = null;
			throw err;
		} finally {
			this.starting = false;
		}
	}

	async stop(): Promise<void> {
		// Best-effort, idempotent, reverse order.
		await this.safe(() => this.wiring?.stopGateway());
		await this.safe(() => this.steps.shutdownProcess());
		this.wiring = null;
		this.started = false;
	}

	isStarted(): boolean {
		return this.started;
	}

	healthProbe(): LeadHealthVerdict | undefined {
		return this.steps.healthProbe?.();
	}

	private async safe(
		fn: () => Promise<void> | void | undefined,
	): Promise<void> {
		try {
			await fn();
		} catch (err) {
			this.logger.warn("CodexLeadRuntime teardown step failed (ignored)", {
				err: (err as Error).message,
			});
		}
	}
}
