import { z } from "zod";

const uuid = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const text = z
	.string()
	.refine(
		(value) =>
			value.trim().length > 0 &&
			!value.includes("\0") &&
			Buffer.byteLength(value, "utf8") <= 8000,
	);
const issue = z
	.string()
	.refine(
		(value) =>
			/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value) || uuid.safeParse(value).success,
	);

/** Shared v1/v2 DTOs; adopted menus remain a current provider authorization check. */
export function createRunnerActionSchemas(
	adopted?: readonly string[],
): Record<string, z.ZodObject> {
	if (adopted && adopted.length === 0)
		throw new Error("runner actions require adopted menus");
	const schemas: Record<string, z.ZodObject> = {
		start_runner: z
			.object({
				issueId: issue,
				taskCategory: adopted
					? z.enum([...adopted] as [string, ...string[]])
					: key,
				idempotencyKey: key,
			})
			.strict(),
		list_runners: z
			.object({
				mode: z
					.enum(["active", "live", "recent_terminal", "recent", "stuck"])
					.default("active"),
			})
			.strict(),
		get_runner_status: z.object({ executionId: uuid }).strict(),
		read_runner_tmux: z
			.object({
				executionId: uuid,
				lines: z.number().int().min(1).max(200).default(80),
			})
			.strict(),
		send_runner: z
			.object({ executionId: uuid, text, idempotencyKey: key })
			.strict(),
		respond_runner: z.object({ questionId: uuid, answer: text }).strict(),
	};
	return schemas;
}
