export interface KernelOpenOptions {
	path: string;
	busyTimeoutMs?: number;
	synchronousMode?: "FULL" | "NORMAL";
	verbose?: (sql: string) => void;
	txBudgetMs?: number;
}

export type MigrateOptions = Omit<KernelOpenOptions, "txBudgetMs">;
