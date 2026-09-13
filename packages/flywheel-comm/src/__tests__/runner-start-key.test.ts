import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { deriveRunnerStartKey } from "../runner-start-key.js";

it("binds Discord keys to exact source, issue and owner while preserving legacy keys", () => {
	const base = {
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		issueId: "FLY-2457",
	};
	const idempotencyKey = "discord:123456789012345678:223456789012345678";
	const result = deriveRunnerStartKey({ ...base, idempotencyKey });
	expect(result.source).toBe("discord");
	expect(result.sourceRef).toBe(
		"discord:123456789012345678/223456789012345678",
	);
	expect(result.key).toBe(
		"codex-lead:" +
			createHash("sha256")
				.update(
					JSON.stringify([
						base.projectName,
						base.leadId,
						base.issueId,
						idempotencyKey,
					]),
				)
				.digest("hex"),
	);
	expect(
		deriveRunnerStartKey({ ...base, issueId: "FLY-2458", idempotencyKey }).key,
	).not.toBe(result.key);
	expect(
		deriveRunnerStartKey({ ...base, idempotencyKey: "manual-1" }).source,
	).toBe("none");
	expect(() =>
		deriveRunnerStartKey({ ...base, idempotencyKey: "discord:fake" }),
	).toThrow("source");
});
