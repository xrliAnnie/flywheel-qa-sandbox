import type { AgentConfig } from "flywheel-config";
import type { HydratedContext } from "./PreHydrator.js";

export interface DispatchResult {
	agentName: string;
	agentConfig: AgentConfig;
	matchMethod: "label" | "haiku" | "fallback";
}

export type ClassifyFn = (
	title: string,
	description: string,
	agentNames: string[],
	agentKeywords: Record<string, string[]>,
) => Promise<string | null>;

export class AgentDispatcher {
	constructor(
		private agents: Record<string, AgentConfig>,
		private defaultAgent: string | undefined,
		private classifyFn?: ClassifyFn,
	) {}

	async dispatch(hydrated: HydratedContext): Promise<DispatchResult | null> {
		const entries = Object.entries(this.agents);
		if (entries.length === 0) return null;

		// 1. Label match (case-insensitive)
		const issueLabels = new Set(hydrated.labels.map((l) => l.toLowerCase()));
		for (const [name, config] of entries) {
			const hasMatch = config.match.labels.some((l) =>
				issueLabels.has(l.toLowerCase()),
			);
			if (hasMatch) {
				return { agentName: name, agentConfig: config, matchMethod: "label" };
			}
		}

		// 2. Haiku classify (if classifyFn provided)
		if (this.classifyFn) {
			const agentNames = entries.map(([name]) => name);
			const agentKeywords: Record<string, string[]> = {};
			for (const [name, config] of entries) {
				agentKeywords[name] = config.match.keywords;
			}

			try {
				const classified = await this.classifyFn(
					hydrated.issueTitle,
					hydrated.issueDescription,
					agentNames,
					agentKeywords,
				);
				if (classified && classified in this.agents) {
					return {
						agentName: classified,
						agentConfig: this.agents[classified]!,
						matchMethod: "haiku",
					};
				}
			} catch (err) {
				console.warn(
					`[AgentDispatcher] Classification failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 3. Default agent fallback
		if (this.defaultAgent && this.defaultAgent in this.agents) {
			return {
				agentName: this.defaultAgent,
				agentConfig: this.agents[this.defaultAgent]!,
				matchMethod: "fallback",
			};
		}

		// 4. No match
		return null;
	}
}
