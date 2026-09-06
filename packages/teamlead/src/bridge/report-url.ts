import type { ReportRegistry } from "./report-registry.js";

export function reportUrlForToken(
	registry: Pick<ReportRegistry, "hosting" | "vercelProjectName">,
	token: string,
): string | null {
	if (registry.hosting()?.provider !== "vercel-blob") return null;
	const projectName = registry.vercelProjectName();
	return projectName ? `https://${projectName}.vercel.app/r/${token}/` : null;
}
