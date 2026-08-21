import { CommDB } from "flywheel-comm/db";
import { parseFounderReviewQuestionContent } from "flywheel-comm/founder-review";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type { Session, StateStore } from "../StateStore.js";

export type TerminalAuthorityRevalidation = () => Promise<
	"authorized" | "reopened" | "unknown"
>;

export interface IssueDoneGateRetirementInput {
	projectName: string;
	canonicalIssueId: string;
	issueAliases: readonly string[];
	authorityCredential: string;
	revalidate: TerminalAuthorityRevalidation;
}

export interface PrMergedGateRetirementInput
	extends IssueDoneGateRetirementInput {
	prNumber: number;
}

export interface TerminalGateRetirementOptions {
	store: StateStore;
	projectNames: readonly string[];
	commDbPathForProject: (projectName: string) => string;
	now?: () => number;
	openDb?: (path: string) => CommDB;
	maxGatesPerPass?: number;
	maxSessionsPerPass?: number;
	logger?: (message: string) => void;
}

/**
 * Retires stale founder-authority gates from current terminal authority. There
 * is no durable cross-database intent: every patrol derives the remaining work
 * again, and revalidates authority immediately before each irreversible CAS.
 */
export class TerminalGateRetirement {
	private readonly openDb: (path: string) => CommDB;
	private readonly logger: (message: string) => void;
	private nextProjectOffset = 0;
	private readonly nextSessionCursorByProject = new Map<string, string>();

	constructor(private readonly options: TerminalGateRetirementOptions) {
		this.openDb = options.openDb ?? ((path) => new CommDB(path, false));
		this.logger =
			options.logger ??
			((message) => console.warn(`[terminal-gate-retirement] ${message}`));
	}

	async pass(): Promise<void> {
		const projects = this.rotatedProjects();
		let remainingGates = this.options.maxGatesPerPass ?? 100;
		let remainingSessions = this.options.maxSessionsPerPass ?? 100;
		for (const projectName of projects) {
			if (remainingGates <= 0 || remainingSessions <= 0) break;
			let cursor = this.nextSessionCursorByProject.get(projectName) ?? "";
			let sessions = this.options.store.getTerminalProjectSessionsAfter(
				projectName,
				cursor,
				remainingSessions,
			);
			if (sessions.length === 0 && cursor) {
				cursor = "";
				sessions = this.options.store.getTerminalProjectSessionsAfter(
					projectName,
					cursor,
					remainingSessions,
				);
			}
			if (sessions.length === 0) {
				this.nextSessionCursorByProject.delete(projectName);
				continue;
			}
			let db: CommDB | undefined;
			let lastScannedExecutionId = cursor;
			try {
				db = this.openDb(this.options.commDbPathForProject(projectName));
				for (const session of sessions) {
					if (remainingGates <= 0 || remainingSessions <= 0) break;
					lastScannedExecutionId = session.execution_id;
					remainingSessions -= 1;
					remainingGates -= this.retireSessionGatesInDb(
						db,
						session,
						"superseded_session_terminal",
						remainingGates,
					);
				}
			} catch (error) {
				this.logger(
					`${projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				db?.close();
			}
			this.nextSessionCursorByProject.set(projectName, lastScannedExecutionId);
		}
	}

	async retireIssueDone(input: IssueDoneGateRetirementInput): Promise<void> {
		await this.retireExternalAuthority(input, "superseded_issue_done");
	}

	async retirePrMerged(input: PrMergedGateRetirementInput): Promise<void> {
		await this.retireExternalAuthority(input, "superseded_merged");
	}

	private rotatedProjects(): string[] {
		const projects = [...this.options.projectNames];
		if (projects.length === 0) return projects;
		const offset = this.nextProjectOffset % projects.length;
		this.nextProjectOffset = (offset + 1) % projects.length;
		return [...projects.slice(offset), ...projects.slice(0, offset)];
	}

	private retireSessionGatesInDb(
		db: CommDB,
		snapshot: Session,
		reason:
			| "superseded_session_terminal"
			| "superseded_issue_done"
			| "superseded_merged",
		limit: number,
	): number {
		let attempted = 0;
		try {
			for (const question of db.getOpenGatesByRunner(snapshot.execution_id)) {
				if (attempted >= limit) break;
				// A founder-review question belongs to the live workflow run, not to
				// the lifespan of the runner that happened to materialize it. A
				// terminal producer alone is never sufficient retirement authority;
				// newer-family supersede or freshly revalidated external authority
				// converges those gates through their dedicated paths.
				if (question.checkpoint !== "approve_to_ship") {
					continue;
				}
				const current = this.options.store.getSession(snapshot.execution_id);
				if (
					!current ||
					!isOperationalTerminalStatus(current.status) ||
					current.terminal_lifecycle_id !== snapshot.terminal_lifecycle_id
				) {
					break;
				}
				if (
					this.options.store.workflowGatePresentationDisposition({
						executionId: snapshot.execution_id,
						checkpoint: question.checkpoint,
						questionId: question.id,
					}).reason === "holder_authoritative"
				) {
					continue;
				}
				db.retireGateForTerminalAuthority({
					questionId: question.id,
					reason,
					now: new Date((this.options.now ?? Date.now)()).toISOString(),
				});
				attempted += 1;
			}
		} catch (error) {
			this.logger(
				`${snapshot.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return attempted;
	}

	private async retireExternalAuthority(
		input: IssueDoneGateRetirementInput,
		reason: "superseded_issue_done" | "superseded_merged",
	): Promise<void> {
		if (!this.options.projectNames.includes(input.projectName)) return;
		const aliases = new Set([input.canonicalIssueId, ...input.issueAliases]);
		let db: CommDB | undefined;
		try {
			db = this.openDb(this.options.commDbPathForProject(input.projectName));
			const questions = [
				...db.getOpenGatesByCheckpoint("approve_to_ship"),
				...db.getOpenGatesByCheckpoint("founder_review"),
			].sort(
				(left, right) =>
					left.created_at.localeCompare(right.created_at) ||
					left.from_agent.localeCompare(right.from_agent) ||
					left.id.localeCompare(right.id),
			);
			for (const question of questions) {
				const issueId = this.issueForQuestion(db, question);
				if (!issueId || !aliases.has(issueId)) continue;
				let verdict: Awaited<ReturnType<TerminalAuthorityRevalidation>>;
				try {
					verdict = await input.revalidate();
				} catch {
					verdict = "unknown";
				}
				if (verdict !== "authorized") continue;
				db.retireGateForTerminalAuthority({
					questionId: question.id,
					reason,
					now: new Date((this.options.now ?? Date.now)()).toISOString(),
				});
			}
		} catch (error) {
			this.logger(
				`${input.projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			db?.close();
		}
	}

	private issueForQuestion(
		db: CommDB,
		question: ReturnType<CommDB["getOpenGatesByCheckpoint"]>[number],
	): string | undefined {
		if (question.checkpoint === "founder_review") {
			const family = db.getFounderReviewFamily(question.id);
			const parsed = family
				? parseFounderReviewQuestionContent(family.question.content)
				: undefined;
			return parsed
				? this.options.store.getWorkflowRun(parsed.runId)?.issue_id
				: undefined;
		}
		return (
			this.options.store.getSession(question.from_agent)?.issue_id ??
			db.getSession(question.from_agent)?.issue_id ??
			undefined
		);
	}
}
