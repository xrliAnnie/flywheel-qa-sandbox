import type { IAdapter } from "./adapter-types.js";

/**
 * Registry for IAdapter implementations.
 *
 * Blueprint/DagDispatcher uses this to get the right adapter for a task.
 * Replaces FlywheelRunnerRegistry (GEO-157).
 */
export class AdapterRegistry {
	private adapters = new Map<string, IAdapter>();
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
	 * Set the default adapter by name.
	 * @throws Error if the adapter is not registered.
	 */
	setDefault(name: string): void {
		if (!this.adapters.has(name)) {
			throw new Error(
				`Cannot set default: adapter "${name}" is not registered. Available: ${this.availableNames().join(", ")}`,
			);
		}
		this.defaultAdapterName = name;
	}

	/**
	 * Get an adapter by name.
	 * @throws Error if the adapter is not registered.
	 */
	get(name: string): IAdapter {
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
	 * List registered adapter names.
	 */
	availableNames(): string[] {
		return [...this.adapters.keys()];
	}
}
