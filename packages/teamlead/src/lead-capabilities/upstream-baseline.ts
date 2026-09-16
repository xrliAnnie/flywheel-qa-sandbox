import { createHash } from "node:crypto";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const serverId = z.enum(["gbrain", "xiaohongshu-mcp", "context7"]);
const coordinate = z
	.object({ serverId, version: z.string().min(1).max(128) })
	.strict();
const baselineSchema = coordinate.extend({
	toolSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type UpstreamToolBaseline = z.infer<typeof baselineSchema>;
/** Schema evidence only, never a permission or an automatic baseline update.
 * All currently advertised tools participate, including writes lacking an adapter. */
export function assertUpstreamToolsPinned(
	baseline: UpstreamToolBaseline,
	current: { serverId: string; version: string; tools: readonly unknown[] },
) {
	try {
		const pin = baselineSchema.parse(baseline),
			identity = coordinate.parse({
				serverId: current.serverId,
				version: current.version,
			});
		if (
			identity.serverId !== pin.serverId ||
			identity.version !== pin.version ||
			!Array.isArray(current.tools) ||
			current.tools.length === 0 ||
			current.tools.length > 256
		)
			throw new Error();
		const names = new Set<string>();
		const tools = current.tools
			.map((raw) => {
				const parsed = ToolSchema.parse(raw);
				if (
					!/^[A-Za-z0-9_-]{1,128}$/.test(parsed.name) ||
					names.has(parsed.name)
				)
					throw new Error();
				names.add(parsed.name);
				return { name: parsed.name, raw };
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		const text = JSON.stringify(tools.map((tool) => tool.raw));
		if (
			Buffer.byteLength(text) > 2 * 1024 * 1024 ||
			createHash("sha256").update(text).digest("hex") !== pin.toolSchemaDigest
		)
			throw new Error();
		return {
			integration: {
				id: pin.serverId,
				version: pin.version,
				toolSchemaDigest: pin.toolSchemaDigest,
			},
			toolNames: tools.map((tool) => tool.name),
		};
	} catch {
		throw new Error("baseline_drift");
	}
}
