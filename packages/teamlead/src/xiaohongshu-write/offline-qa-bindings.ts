import { createHash } from "node:crypto";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { readImmutableFile } from "./trusted-files.js";

const id = z.number().int().positive().max(2147483647);
const schema = z
	.object({
		schemaVersion: z.literal(1),
		targetHostId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/),
		platform: z.literal("darwin"),
		architecture: z.literal("arm64"),
		serviceUid: id,
		serviceGid: id,
		modelUid: id,
		modelGid: id,
		ingressGid: id,
		acceptancePublicKey: z.string().refine((value) => {
			const bytes = Buffer.from(value, "base64");
			return bytes.length === 32 && bytes.toString("base64") === value;
		}),
	})
	.strict();
/** Public build inputs from independent QA's immutable root-owned file. This is
 * a configuration binding, not host acceptance or a production activation proof. */
export function readOfflineQaBindings(path: string) {
	const raw = readImmutableFile(path, { maxBytes: 16384 });
	const bindings = schema.parse(
		parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
	);
	return { bindings, sha256: createHash("sha256").update(raw).digest("hex") };
}
