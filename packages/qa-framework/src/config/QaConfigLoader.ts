import { parse } from "yaml";
import { type QaConfig, QaConfigSchema } from "./types.js";

/** Function signature for reading a file — injected for testability */
export type ReadFileFn = (path: string) => Promise<string>;

/**
 * Loads and validates qa-config.yaml using Zod schema.
 *
 * Accepts a readFile function for dependency injection (testable without fs).
 */
export class QaConfigLoader {
	constructor(private readFile: ReadFileFn) {}

	async load(configPath: string): Promise<QaConfig> {
		const content = await this.readFile(configPath);
		const raw = parse(content);
		return QaConfigSchema.parse(raw);
	}
}
