import type { IAdapter } from "./adapter-types.js";

/**
 * Registry for IAdapter implementations.
 *
 * Blueprint/DagDispatcher uses this to get the right adapter for a task.
 * Replaces FlywheelRunnerRegistry (GEO-157).
 */
export class AdapterRegistry {
	private adapters = new Map<string, IAdapter>();
	private factories = new Map<string, () => IAdapter>();
	private defaultAdapterName: string | null = null;

	/**
	 * Register an adapter using its own type as the key.
	 * The first registered adapter becomes the default unless overridden.
	 */
	register(adapter: IAdapter): void {
		this.adapters.set(adapter.type, adapter);
		if (this.defaultAdapterName === null) {
			this.defaultAdapterName = adapter.type;
		}
	}

	/**
	 * Register an adapter under a custom alias.
	 * Useful when adapter.type differs from the config key (e.g., TmuxAdapter
	 * has type "claude-tmux" but is registered as "claude").
	 */
	registerAs(name: string, adapter: IAdapter): void {
		this.adapters.set(name, adapter);
		if (this.defaultAdapterName === null) {
			this.defaultAdapterName = name;
		}
	}

	/**
	 * FLY-123: Register a factory under a name. `get(name)` invokes the
	 * factory on EVERY call, returning a fresh adapter instance per
	 * execution.
	 *
	 * Why factories (Codex design review R1 #6): the production
	 * `makeAdapter` closure this registry replaces constructed a fresh
	 * `TmuxAdapter` per execution. Registering singleton INSTANCES would
	 * silently change the lifetime of instance-level mutable state
	 * (`preflightDone`, Codex watcher/session state) — two concurrent
	 * Runners would share one instance. Factory registration preserves the
	 * per-execution-fresh semantics byte-compatibly.
	 */
	registerFactory(name: string, factory: () => IAdapter): void {
		this.factories.set(name, factory);
		if (this.defaultAdapterName === null) {
			this.defaultAdapterName = name;
		}
	}

	/**
	 * Set the default adapter by name.
	 * @throws Error if the adapter is not registered.
	 */
	setDefault(name: string): void {
		if (!this.adapters.has(name) && !this.factories.has(name)) {
			throw new Error(
				`Cannot set default: adapter "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		this.defaultAdapterName = name;
	}

	/**
	 * Get an adapter by name.
	 *
	 * Factory registrations (`registerFactory`) take precedence and return a
	 * NEW instance per call; instance registrations (`register`/`registerAs`)
	 * return the singleton.
	 *
	 * @throws Error if the adapter is not registered.
	 */
	get(name: string): IAdapter {
		const factory = this.factories.get(name);
		if (factory) {
			return factory();
		}
		const adapter = this.adapters.get(name);
		if (!adapter) {
			throw new Error(
				`Adapter "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		return adapter;
	}

	/**
	 * Get the default adapter.
	 * @throws Error if no adapters are registered.
	 */
	getDefault(): IAdapter {
		if (this.defaultAdapterName === null) {
			throw new Error("No adapters registered");
		}
		return this.get(this.defaultAdapterName);
	}

	/**
	 * List registered adapter names (instances + factories).
	 */
	availableNames(): string[] {
		return [...new Set([...this.adapters.keys(), ...this.factories.keys()])];
	}
}
