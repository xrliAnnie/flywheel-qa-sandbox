import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { compileBusinessDirectory } from "../../../lead-directory.js";
import { parseAndValidateProjects } from "../../../ProjectConfig.js";

/** The path is supplied by the trusted host configuration, never tool arguments. */
export async function readBusinessDirectory(projectsFile: string) {
	try {
		if (!isAbsolute(projectsFile))
			throw new Error("absolute registry path required");
		const bytes = await readFile(projectsFile);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const { resolve: _resolve, ...directory } = compileBusinessDirectory(
			parseAndValidateProjects(JSON.parse(bytes.toString("utf8")), {
				allowEmptyLeads: true,
			}),
			digest,
		);
		return { status: "available" as const, ...directory };
	} catch {
		// Registry validation errors may quote raw values. Do not expose them to a model.
		return {
			status: "unavailable" as const,
			reason: "registry_unavailable" as const,
		};
	}
}
