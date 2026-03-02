import type { IFlywheelRunner } from "./flywheel-runner-types.js";

/**
 * Registry for IFlywheelRunner implementations.
 *
 * Blueprint Dispatcher uses this to get the right runner for a task.
 * Phase 1: only "claude" is registered. Phase 2+: codex, gemini, etc.
 */
export class FlywheelRunnerRegistry {
	private runners = new Map<string, IFlywheelRunner>();
	private defaultRunnerName: string | null = null;

	/**
	 * Register a runner implementation using its own name.
	 * The first registered runner becomes the default unless overridden.
	 */
	register(runner: IFlywheelRunner): void {
		this.runners.set(runner.name, runner);
		if (this.defaultRunnerName === null) {
			this.defaultRunnerName = runner.name;
		}
	}

	/**
	 * Register a runner under a custom alias.
	 * Useful when runner.name differs from the config key (e.g., TmuxRunner
	 * has name "claude-tmux" but is registered as "claude").
	 */
	registerAs(name: string, runner: IFlywheelRunner): void {
		this.runners.set(name, runner);
		if (this.defaultRunnerName === null) {
			this.defaultRunnerName = name;
		}
	}

	/**
	 * Set the default runner by name.
	 * @throws Error if the runner is not registered.
	 */
	setDefault(name: string): void {
		if (!this.runners.has(name)) {
			throw new Error(
				`Cannot set default: runner "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		this.defaultRunnerName = name;
	}

	/**
	 * Get a runner by name.
	 * @throws Error if the runner is not registered.
	 */
	get(name: string): IFlywheelRunner {
		const runner = this.runners.get(name);
		if (!runner) {
			throw new Error(
				`Runner "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		return runner;
	}

	/**
	 * Get the default runner.
	 * @throws Error if no runners are registered.
	 */
	getDefault(): IFlywheelRunner {
		if (this.defaultRunnerName === null) {
			throw new Error("No runners registered");
		}
		return this.get(this.defaultRunnerName);
	}

	/**
	 * List registered runner names.
	 */
	availableNames(): string[] {
		return [...this.runners.keys()];
	}
}
