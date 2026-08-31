import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledRegistryPath(explicit?: string): string {
	const candidates = [
		explicit,
		process.env.FLYWHEEL_BUNDLED_REGISTRY_PATH,
		process.env.FLYWHEEL_REPO_ROOT
			? join(
					process.env.FLYWHEEL_REPO_ROOT,
					".flywheel",
					"agents",
					"registry.yaml",
				)
			: undefined,
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../..",
			".flywheel/agents/registry.yaml",
		),
	].filter((candidate): candidate is string => Boolean(candidate));
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(
			"Bundled registry not found; pass --bundled-registry or set FLYWHEEL_BUNDLED_REGISTRY_PATH",
		);
	}
	return resolve(found);
}
