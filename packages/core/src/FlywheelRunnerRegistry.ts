/**
 * @deprecated Use AdapterRegistry instead (GEO-157).
 * This file provides backward-compatible FlywheelRunnerRegistry for scripts
 * that register IFlywheelRunner instances (which have `name` instead of `type`).
 * Will be removed in a future version.
 */
import type { IFlywheelRunner } from "./flywheel-runner-types.js";

/**
 * @deprecated Use AdapterRegistry instead.
 * Compat wrapper that bridges IFlywheelRunner (name-based) registration.
 */
export class FlywheelRunnerRegistry {
	private runners = new Map<string, IFlywheelRunner>();
	private defaultRunnerName: string | null = null;

	register(runner: IFlywheelRunner): void {
		this.runners.set(runner.name, runner);
		if (this.defaultRunnerName === null) {
			this.defaultRunnerName = runner.name;
		}
	}

	registerAs(name: string, runner: IFlywheelRunner): void {
		this.runners.set(name, runner);
		if (this.defaultRunnerName === null) {
			this.defaultRunnerName = name;
		}
	}

	setDefault(name: string): void {
		if (!this.runners.has(name)) {
			throw new Error(
				`Cannot set default: runner "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		this.defaultRunnerName = name;
	}

	get(name: string): IFlywheelRunner {
		const runner = this.runners.get(name);
		if (!runner) {
			throw new Error(
				`Runner "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		return runner;
	}

	getDefault(): IFlywheelRunner {
		if (this.defaultRunnerName === null) {
			throw new Error("No runners registered");
		}
		return this.get(this.defaultRunnerName);
	}

	availableNames(): string[] {
		return [...this.runners.keys()];
	}
}
