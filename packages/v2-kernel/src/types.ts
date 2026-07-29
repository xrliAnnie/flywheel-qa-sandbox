export interface KernelOpenOptions {
	path: string;
	/** Refuse to create a missing database, including for writable callers. */
	fileMustExist?: boolean;
	busyTimeoutMs?: number;
	synchronousMode?: "FULL" | "NORMAL";
	verbose?: (sql: string) => void;
	txBudgetMs?: number;
}

export type MigrateOptions = Omit<KernelOpenOptions, "txBudgetMs">;
