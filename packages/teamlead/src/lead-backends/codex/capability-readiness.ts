import type { LeadCapabilityParent } from "../../lead-capabilities/runtime-parent.js";

/** Both transports must verify the running server before opening a thread or ingress. */
export async function verifyLeadCapabilityReadiness(options: {
	parent: LeadCapabilityParent;
	cwd: string;
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
	const { parent, cwd, request } = options;
	await parent.assertCurrent();
	const response = await request("config/read", { cwd, includeLayers: false });
	if (
		!response ||
		typeof response !== "object" ||
		"error" in response ||
		!("result" in response) ||
		!response.result ||
		typeof response.result !== "object" ||
		!("config" in response.result) ||
		!response.result.config ||
		typeof response.result.config !== "object"
	)
		throw new Error("capability_effective_config_unavailable");
	await parent.verifyEffectiveConfig(response.result.config);
	if (!parent.verifyEffectiveSkills)
		throw new Error("capability_skills_unverified");
	const skills = await request("skills/list", {
		cwds: [cwd],
		forceReload: true,
	});
	if (
		!skills ||
		typeof skills !== "object" ||
		"error" in skills ||
		!("result" in skills)
	)
		throw new Error("capability_skills_unverified");
	await parent.verifyEffectiveSkills(skills.result, cwd);
}
