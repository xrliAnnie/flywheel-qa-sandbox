import { createHash } from "node:crypto";
/** Stable Bridge reservation key. Discord-origin callers use the source message
 * as their key; manual/patrol calls retain the existing key contract.
 * The reference is attribution to verify against Discord, never authorization.
 */
export function deriveRunnerStartKey(input: {
	projectName: string;
	leadId: string;
	issueId: string;
	idempotencyKey: string;
}): { key: string; source: "discord" | "none"; sourceRef: string | null } {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey))
		throw Error("invalid runner start key");
	const match = /^discord:([1-9][0-9]{16,19}):([1-9][0-9]{16,19})$/.exec(
		input.idempotencyKey,
	);
	if (input.idempotencyKey.startsWith("discord:") && !match)
		throw Error("invalid runner source reference");
	return {
		key:
			"codex-lead:" +
			createHash("sha256")
				.update(
					JSON.stringify([
						input.projectName,
						input.leadId,
						input.issueId,
						input.idempotencyKey,
					]),
				)
				.digest("hex"),
		source: match ? "discord" : "none",
		sourceRef: match ? `discord:${match[1]}/${match[2]}` : null,
	};
}
