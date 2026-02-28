/**
 * ProcedureAnalyzer - Intelligent analysis of agent sessions to determine procedures
 *
 * TODO: only ClaudeRunner supported in Phase 1
 * Previously used SimpleClaudeRunner, SimpleGeminiRunner, SimpleCodexRunner, SimpleCursorRunner
 * from deleted packages. Now falls back to "code" classification without AI routing.
 */

import {
	type CyrusAgentSession,
	createLogger,
	type ILogger,
} from "flywheel-core";
import { getProcedureForClassification, PROCEDURES } from "./registry.js";
import type {
	ProcedureAnalysisDecision,
	ProcedureDefinition,
	ProcedureMetadata,
	RequestClassification,
	SubroutineDefinition,
} from "./types.js";

export type SimpleRunnerType = "claude" | "gemini" | "codex" | "cursor";

export interface ProcedureAnalyzerConfig {
	flywheelHome: string;
	model?: string;
	timeoutMs?: number;
	runnerType?: SimpleRunnerType; // Default: "claude"
	logger?: ILogger;
}

export class ProcedureAnalyzer {
	private procedures: Map<string, ProcedureDefinition> = new Map();
	private logger: ILogger;

	constructor(config: ProcedureAnalyzerConfig) {
		this.logger =
			config.logger ?? createLogger({ component: "ProcedureAnalyzer" });

		// Load all predefined procedures from registry
		this.loadPredefinedProcedures();
	}

	/**
	 * Load predefined procedures from registry
	 */
	private loadPredefinedProcedures(): void {
		for (const [name, procedure] of Object.entries(PROCEDURES)) {
			this.procedures.set(name, procedure);
		}
	}

	/**
	 * Analyze a request and determine which procedure to use.
	 * TODO: only ClaudeRunner supported in Phase 1 -- AI routing removed,
	 * falls back to "code" (full-development) classification.
	 */
	async determineRoutine(
		_requestText: string,
	): Promise<ProcedureAnalysisDecision> {
		const classification: RequestClassification = "code";
		const procedureName = getProcedureForClassification(classification);
		const procedure = this.procedures.get(procedureName);

		if (!procedure) {
			throw new Error(`Procedure "${procedureName}" not found in registry`);
		}

		return {
			classification,
			procedure,
			reasoning:
				"Phase 1 stub: AI routing removed, defaulting to full-development",
		};
	}

	/**
	 * Get the next subroutine for a session
	 * Returns null if procedure is complete
	 */
	getNextSubroutine(session: CyrusAgentSession): SubroutineDefinition | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			return null;
		}

		const procedure = this.procedures.get(procedureMetadata.procedureName);

		if (!procedure) {
			this.logger.error(
				`Procedure "${procedureMetadata.procedureName}" not found`,
			);
			return null;
		}

		const nextIndex = procedureMetadata.currentSubroutineIndex + 1;

		if (nextIndex >= procedure.subroutines.length) {
			return null;
		}

		return procedure.subroutines[nextIndex] ?? null;
	}

	/**
	 * Get the current subroutine for a session
	 */
	getCurrentSubroutine(
		session: CyrusAgentSession,
	): SubroutineDefinition | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			return null;
		}

		const procedure = this.procedures.get(procedureMetadata.procedureName);

		if (!procedure) {
			return null;
		}

		const currentIndex = procedureMetadata.currentSubroutineIndex;

		if (currentIndex < 0 || currentIndex >= procedure.subroutines.length) {
			return null;
		}

		return procedure.subroutines[currentIndex] ?? null;
	}

	/**
	 * Initialize procedure metadata for a new session
	 */
	initializeProcedureMetadata(
		session: CyrusAgentSession,
		procedure: ProcedureDefinition,
	): void {
		if (!session.metadata) {
			session.metadata = {};
		}

		session.metadata.procedure = {
			procedureName: procedure.name,
			currentSubroutineIndex: 0,
			subroutineHistory: [],
		} satisfies ProcedureMetadata;
	}

	/**
	 * Record subroutine completion and advance to next
	 */
	advanceToNextSubroutine(
		session: CyrusAgentSession,
		sessionId: string | null,
		result?: string,
	): void {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			throw new Error("Cannot advance: session has no procedure metadata");
		}

		const currentSubroutine = this.getCurrentSubroutine(session);

		if (currentSubroutine) {
			const isCodexSession = session.codexSessionId !== undefined;
			const isGeminiSession =
				!isCodexSession && session.geminiSessionId !== undefined;

			procedureMetadata.subroutineHistory.push({
				subroutine: currentSubroutine.name,
				completedAt: Date.now(),
				claudeSessionId: isGeminiSession || isCodexSession ? null : sessionId,
				geminiSessionId: isGeminiSession ? sessionId : null,
				codexSessionId: isCodexSession ? sessionId : null,
				...(result !== undefined && { result }),
			});
		}

		procedureMetadata.currentSubroutineIndex++;
	}

	/**
	 * Get the result from the last completed subroutine in the history.
	 */
	getLastSubroutineResult(session: CyrusAgentSession): string | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			return null;
		}

		const history = procedureMetadata.subroutineHistory;
		if (history.length === 0) {
			return null;
		}

		return history[history.length - 1]?.result ?? null;
	}

	/**
	 * Check if procedure is complete
	 */
	isProcedureComplete(session: CyrusAgentSession): boolean {
		return this.getNextSubroutine(session) === null;
	}

	/**
	 * Register a custom procedure
	 */
	registerProcedure(procedure: ProcedureDefinition): void {
		this.procedures.set(procedure.name, procedure);
	}

	/**
	 * Get procedure by name
	 */
	getProcedure(name: string): ProcedureDefinition | undefined {
		return this.procedures.get(name);
	}
}
