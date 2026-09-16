import { expect, it, vi } from "vitest";
import type { LeadCapabilityParent } from "../../../lead-capabilities/runtime-parent.js";
import { verifyLeadCapabilityReadiness } from "../capability-readiness.js";

function fixture() {
	const calls: string[] = [];
	const parent = {
		assertCurrent: vi.fn(async () => {
			calls.push("current");
		}),
		verifyEffectiveConfig: vi.fn(async () => {
			calls.push("config");
		}),
		verifyEffectiveSkills: vi.fn(async () => {
			calls.push("skills");
		}),
	} as unknown as LeadCapabilityParent;
	const request = vi.fn(async (method: string) => {
		calls.push(method);
		return method === "config/read"
			? { result: { config: { default_permissions: "fixture" } } }
			: { result: { data: [] } };
	});
	return { calls, parent, request };
}

it("checks current authority and actual config before forced skill discovery at the same cwd", async () => {
	const f = fixture();
	await verifyLeadCapabilityReadiness({
		parent: f.parent,
		request: f.request,
		cwd: "/project",
	});
	expect(f.calls).toEqual([
		"current",
		"config/read",
		"config",
		"skills/list",
		"skills",
	]);
	expect(f.request.mock.calls).toEqual([
		["config/read", { cwd: "/project", includeLayers: false }],
		["skills/list", { cwds: ["/project"], forceReload: true }],
	]);
});

it.each([
	undefined,
	null,
	{},
	{ error: {} },
	{ result: {} },
	{ result: { config: null } },
])(
	"rejects unavailable effective config before discovering skills: %j",
	async (response) => {
		const f = fixture();
		f.request.mockResolvedValueOnce(response as never);
		await expect(
			verifyLeadCapabilityReadiness({
				parent: f.parent,
				request: f.request,
				cwd: "/project",
			}),
		).rejects.toThrow("capability_effective_config_unavailable");
		expect(f.parent.verifyEffectiveConfig).not.toHaveBeenCalled();
		expect(f.request).toHaveBeenCalledTimes(1);
	},
);

it("does not query skills after the effective configuration is rejected", async () => {
	const f = fixture();
	vi.mocked(f.parent.verifyEffectiveConfig).mockRejectedValue(
		new Error("foreign permissions"),
	);
	await expect(
		verifyLeadCapabilityReadiness({
			parent: f.parent,
			request: f.request,
			cwd: "/project",
		}),
	).rejects.toThrow("foreign permissions");
	expect(f.request).toHaveBeenCalledTimes(1);
});

it("requires a skill verifier and rejects skill RPC failure", async () => {
	const f = fixture();
	f.request
		.mockResolvedValueOnce({ result: { config: {} } })
		.mockResolvedValueOnce({ error: {} } as never);
	await expect(
		verifyLeadCapabilityReadiness({
			parent: f.parent,
			request: f.request,
			cwd: "/project",
		}),
	).rejects.toThrow("capability_skills_unverified");
	expect(f.parent.verifyEffectiveSkills).not.toHaveBeenCalled();
	delete f.parent.verifyEffectiveSkills;
	await expect(
		verifyLeadCapabilityReadiness({
			parent: f.parent,
			request: f.request,
			cwd: "/project",
		}),
	).rejects.toThrow("capability_skills_unverified");
});
