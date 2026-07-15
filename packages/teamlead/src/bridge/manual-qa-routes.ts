import { createHash } from "node:crypto";
import type { AutoQaCoordinator } from "./auto-qa-coordinator.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";

export interface ManualQaInput {
	executionId: string;
	prHeadSha: string;
}

export interface ManualQaRouteResult {
	code: number;
	body: unknown;
}

function parseInput(value: unknown): ManualQaInput | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const keys = Object.keys(raw).sort();
	if (
		keys.length !== 2 ||
		keys[0] !== "executionId" ||
		keys[1] !== "prHeadSha"
	) {
		return undefined;
	}
	if (
		typeof raw.executionId !== "string" ||
		raw.executionId.trim().length === 0 ||
		typeof raw.prHeadSha !== "string" ||
		!/^[0-9a-f]{40}$/i.test(raw.prHeadSha)
	) {
		return undefined;
	}
	return {
		executionId: raw.executionId,
		prHeadSha: raw.prHeadSha.toLowerCase(),
	};
}

export function manualQaRequestSha(input: ManualQaInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				executionId: input.executionId,
				prHeadSha: input.prHeadSha.toLowerCase(),
			}),
		)
		.digest("hex");
}

export function handleManualQaStage(
	tokens: ConfirmTokenStore,
	input: unknown,
): ManualQaRouteResult {
	const parsed = parseInput(input);
	if (!parsed) {
		return {
			code: 400,
			body: {
				error: "body must contain exactly executionId and a 40-hex prHeadSha",
			},
		};
	}
	return {
		code: 200,
		body: {
			executionId: parsed.executionId,
			prHeadSha: parsed.prHeadSha,
			confirmToken: tokens.issue(manualQaRequestSha(parsed)),
		},
	};
}

export async function handleManualQaApply(
	deps: {
		tokens: ConfirmTokenStore;
		coordinator: Pick<AutoQaCoordinator, "manualSpawnQa"> | undefined;
	},
	input: unknown,
	confirmToken: string | undefined,
): Promise<ManualQaRouteResult> {
	const parsed = parseInput(input);
	if (
		!parsed ||
		typeof confirmToken !== "string" ||
		confirmToken.length === 0
	) {
		return {
			code: 400,
			body: {
				error:
					"body must contain exactly executionId and prHeadSha; x-flywheel-confirm-token is required",
			},
		};
	}
	const verdict = deps.tokens.verifyAndConsume(
		confirmToken,
		manualQaRequestSha(parsed),
	);
	if (!verdict.ok) {
		return { code: 401, body: { error: verdict.reason } };
	}
	if (!deps.coordinator) {
		return {
			code: 503,
			body: { error: "auto-QA coordinator unavailable" },
		};
	}
	const result = await deps.coordinator.manualSpawnQa(
		parsed.executionId,
		parsed.prHeadSha,
	);
	if (result.status === "spawned") return { code: 202, body: result };
	if (result.status === "existing") return { code: 409, body: result };
	const clientError = new Set([
		"invalid_parent",
		"missing_pr",
		"head_mismatch",
	]);
	return {
		code: clientError.has(result.reason) ? 400 : 409,
		body: result,
	};
}
