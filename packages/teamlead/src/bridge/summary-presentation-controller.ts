import { createHash, timingSafeEqual } from "node:crypto";
import type {
	CodexLeadOutboundHandler,
	OutboundSendOutcome,
} from "../lead-backends/codex/CodexLeadOutboundHandler.js";
import type { StateStore } from "../StateStore.js";
import type { SummaryPresentationMember } from "./summary-presentation-store.js";

export type SummaryPresentationRequestBody = {
	operation?: unknown;
	projectName?: unknown;
	leadId?: unknown;
	groupId?: unknown;
	roundId?: unknown;
	businessState?: unknown;
	outcome?: unknown;
	evidenceRef?: unknown;
	decision?: unknown;
	reason?: unknown;
	text?: unknown;
};

export interface SummaryPresentationControllerOutcome {
	httpStatus: number;
	body: Record<string, unknown>;
}

export class SummaryPresentationVisibleTextError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "SummaryPresentationVisibleTextError";
	}
}

function containsDiagnosticValue(value: unknown, text: string): boolean {
	if (Array.isArray(value)) {
		return value.some((entry) => containsDiagnosticValue(entry, text));
	}
	if (!value || typeof value !== "object") return false;
	for (const [key, entry] of Object.entries(value)) {
		if (
			/error|stack|exception/i.test(key) &&
			typeof entry === "string" &&
			entry.length >= 4 &&
			text.includes(entry)
		) {
			return true;
		}
		if (containsDiagnosticValue(entry, text)) return true;
	}
	return false;
}

/** Refuse known internal diagnostics before a substantive body is frozen. */
export function assertSummaryPresentationVisibleText(
	text: string,
	groupId: string,
	members: readonly SummaryPresentationMember[],
): void {
	if (!text.trim() || text.length > 1_800) {
		throw new SummaryPresentationVisibleTextError("invalid_text_length");
	}
	if (
		text.includes(groupId) ||
		members.some((member) => text.includes(member.roundId)) ||
		/summary-absorption:/iu.test(text)
	) {
		throw new SummaryPresentationVisibleTextError("internal_id_visible");
	}
	if (/\d+\s*\/\s*\d+\s*(?:份)?已交/u.test(text)) {
		throw new SummaryPresentationVisibleTextError("delivery_count_visible");
	}
	if (/(?:未交|缺交)\s*[:：]/u.test(text)) {
		throw new SummaryPresentationVisibleTextError("missing_roster_visible");
	}
	if (
		/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*[^\n]+/u.test(
			text,
		) ||
		/\bat\s+[^\n]+\([^\n]+:\d+:\d+\)/u.test(text) ||
		members.some((member) => containsDiagnosticValue(member.outcome, text))
	) {
		throw new SummaryPresentationVisibleTextError("raw_error_visible");
	}
}

function secureTokenEqual(left: string | undefined, right: string): boolean {
	if (!left) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function diagnosticRef(groupId: string, reason: string): string {
	return `summary-send:${createHash("sha256")
		.update(groupId)
		.update("\0")
		.update(reason)
		.digest("hex")
		.slice(0, 20)}`;
}

export class SummaryPresentationController {
	constructor(
		private readonly options: {
			store: Pick<StateStore, "summaryPresentations">;
			outbound: Pick<CodexLeadOutboundHandler, "handle">;
			expectedApiToken: string;
			canonicalIdentity: {
				projectName: string;
				leadId: string;
				channelId: string;
			};
		},
	) {
		if (!options.expectedApiToken) {
			throw new Error("summary_presentation_expected_token_required");
		}
	}

	async handle(input: {
		body: SummaryPresentationRequestBody;
		providedToken: string | undefined;
	}): Promise<SummaryPresentationControllerOutcome> {
		if (!secureTokenEqual(input.providedToken, this.options.expectedApiToken)) {
			return {
				httpStatus: 401,
				body: { status: "rejected", reason: "unauthorized" },
			};
		}
		const projectName = stringField(input.body.projectName);
		const leadId = stringField(input.body.leadId);
		if (
			projectName !== this.options.canonicalIdentity.projectName ||
			leadId !== this.options.canonicalIdentity.leadId
		) {
			return {
				httpStatus: 403,
				body: {
					status: "rejected",
					reason: "canonical_raya_identity_required",
				},
			};
		}
		try {
			switch (input.body.operation) {
				case "begin":
					return this.begin(projectName, leadId);
				case "status":
					return this.status(input.body);
				case "record":
					return this.record(projectName, leadId, input.body);
				case "finalize":
					return await this.finalize(
						projectName,
						leadId,
						input.body,
						input.providedToken!,
					);
				default:
					return {
						httpStatus: 400,
						body: { status: "rejected", reason: "invalid_operation" },
					};
			}
		} catch (error) {
			const reason =
				error instanceof SummaryPresentationVisibleTextError
					? error.code
					: error instanceof Error
						? error.message
						: "summary_presentation_failed";
			return { httpStatus: 400, body: { status: "rejected", reason } };
		}
	}

	private begin(
		projectName: string,
		leadId: string,
	): SummaryPresentationControllerOutcome {
		const result = this.options.store.summaryPresentations.begin(
			projectName,
			leadId,
		);
		if (result.result === "migration_required") {
			return {
				httpStatus: 409,
				body: {
					status: "migration_required",
					migrationState: result.migrationState,
				},
			};
		}
		return { httpStatus: 200, body: { status: result.result, ...result } };
	}

	private status(
		body: SummaryPresentationRequestBody,
	): SummaryPresentationControllerOutcome {
		const groupId = stringField(body.groupId);
		if (!groupId) throw new Error("groupId_required");
		const group = this.options.store.summaryPresentations.getGroup(groupId);
		if (
			!group ||
			group.projectName !== this.options.canonicalIdentity.projectName ||
			group.leadId !== this.options.canonicalIdentity.leadId
		) {
			return { httpStatus: 404, body: { status: "not_found" } };
		}
		return {
			httpStatus: 200,
			body: {
				status: group.state,
				group,
				members: this.options.store.summaryPresentations.listMembers(groupId),
			},
		};
	}

	private record(
		projectName: string,
		leadId: string,
		body: SummaryPresentationRequestBody,
	): SummaryPresentationControllerOutcome {
		const groupId = stringField(body.groupId);
		const roundId = stringField(body.roundId);
		const evidenceRef = stringField(body.evidenceRef);
		if (!groupId || !roundId || !evidenceRef) {
			throw new Error("groupId_roundId_evidenceRef_required");
		}
		if (body.businessState !== "complete" && body.businessState !== "failed") {
			throw new Error("invalid_business_state");
		}
		const member = this.options.store.summaryPresentations.record({
			projectName,
			leadId,
			groupId,
			roundId,
			businessState: body.businessState,
			outcome: body.outcome,
			evidenceRef,
		});
		return { httpStatus: 200, body: { status: "recorded", member } };
	}

	private async finalize(
		projectName: string,
		leadId: string,
		body: SummaryPresentationRequestBody,
		providedToken: string,
	): Promise<SummaryPresentationControllerOutcome> {
		const groupId = stringField(body.groupId);
		const reason = stringField(body.reason);
		if (!groupId || !reason) throw new Error("groupId_reason_required");
		if (body.decision !== "silent" && body.decision !== "substantive") {
			throw new Error("invalid_decision");
		}
		const text = stringField(body.text) ?? undefined;
		if (body.decision === "substantive") {
			assertSummaryPresentationVisibleText(
				text ?? "",
				groupId,
				this.options.store.summaryPresentations.listMembers(groupId),
			);
		}
		const prepared = this.options.store.summaryPresentations.prepareFinalize({
			projectName,
			leadId,
			groupId,
			decision: body.decision,
			reason,
			text,
		});
		if (prepared.result === "incomplete") {
			return {
				httpStatus: 409,
				body: { status: "incomplete", group: prepared.group },
			};
		}
		if (prepared.result === "silent") {
			return {
				httpStatus: 200,
				body: { status: "silent", group: prepared.group },
			};
		}
		if (prepared.group.state === "sent") {
			return {
				httpStatus: 200,
				body: { status: "sent", group: prepared.group },
			};
		}
		if (prepared.group.state === "ambiguous") {
			return {
				httpStatus: 409,
				body: {
					status: "ambiguous",
					diagnosticRef: prepared.group.diagnosticRef,
				},
			};
		}
		let sending = prepared.group;
		if (sending.state === "ready") {
			sending = this.options.store.summaryPresentations.markSending(groupId);
		}
		let outbound: OutboundSendOutcome;
		try {
			outbound = await this.options.outbound.handle({
				providedToken,
				body: {
					projectName,
					leadId,
					channelId: this.options.canonicalIdentity.channelId,
					text: sending.frozenText,
					idempotencyKey: sending.outboundKey,
					nonce: sending.id,
				},
			});
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			const ref = diagnosticRef(groupId, raw);
			this.options.store.summaryPresentations.markAmbiguous(groupId, {
				error: raw,
				diagnosticRef: ref,
			});
			return {
				httpStatus: 409,
				body: { status: "ambiguous", diagnosticRef: ref },
			};
		}
		if (
			(outbound.status === "sent" || outbound.status === "deduped") &&
			outbound.messageId
		) {
			const group = this.options.store.summaryPresentations.markSent(
				groupId,
				outbound.messageId,
			);
			return { httpStatus: 200, body: { status: "sent", group } };
		}
		const ref = diagnosticRef(groupId, outbound.reason ?? outbound.status);
		this.options.store.summaryPresentations.markAmbiguous(groupId, {
			error: outbound.reason ?? outbound.status,
			diagnosticRef: ref,
		});
		return {
			httpStatus: 409,
			body: { status: "ambiguous", diagnosticRef: ref },
		};
	}
}
