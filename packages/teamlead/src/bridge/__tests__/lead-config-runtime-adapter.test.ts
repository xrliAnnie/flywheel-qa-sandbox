import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import { afterEach, expect, it, vi } from "vitest";
import { LeadConfigRuntimeAdapter } from "../lead-config-runtime-adapter.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "lead-adapter-"));
	roots.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-16T00:00:00Z",
		}),
	);
	const path = join(home, "projects.json");
	const raw = [
		{
			projectName: "raya",
			leads: [
				{
					agentId: "raya",
					backend: "codex-app-server",
					summaryRole: "producer",
					botTokenEnv: "RAYA_TOKEN",
					botUserId: "12345678901234567",
				},
			],
		},
	];
	const save = () => writeFileSync(path, JSON.stringify(raw));
	save();
	const identity = resolveLeadIdentity({
		projectsPath: path,
		projectName: "raya",
		leadId: "raya",
		homeDir: home,
	});
	const lease = {
		projectName: identity.projectName,
		leadKey: identity.leadKey,
		identityDigest: identity.identityDigest,
		carrierId: "carrier",
		ownerEpoch: "owner",
		runtimeGeneration: "generation",
		threadId: "thread",
		artifactBuildSha: "a".repeat(40),
		bootstrapBuildSha: "a".repeat(40),
	};
	const caps = {
		protocolVersions: [1, 2] as [1, 2],
		features: ["lead_runtime_config_v1", "registry_tuning_v1"] as const,
		socketOwnerId: "carrier",
		runtimeIdentity: lease,
	};
	const env: NodeJS.ProcessEnv = { RAYA_TOKEN: "isolated-secret" };
	const probe = vi.fn(async () => ({ ...caps, features: [...caps.features] }));
	const apply = vi.fn(async (args: any) => ({
		...args.target,
		status: "applied" as const,
		appliedAt: new Date().toISOString(),
	}));
	const adapter = new LeadConfigRuntimeAdapter({
		projectsPath: path,
		home,
		env,
		runtimeBuildSha: "a".repeat(40),
		stateDir: () => home,
		probe,
		apply,
	});
	return { adapter, identity, lease, probe, apply, env, raw, save, home };
}
it("uses the registry credential selector and an exact current socket lease", async () => {
	const f = fixture();
	expect(await f.adapter.preflight(f.identity)).toMatchObject({
		...f.lease,
		online: true,
	});
	expect(f.probe.mock.calls[0]![0]).toMatchObject({
		authSecret: "isolated-secret",
		leadId: "raya",
		socketPath: join(f.home, "lead-inbox.sock"),
	});
	const target = {
		...f.lease,
		operationId: "op",
		configGeneration: 1,
		configDigest: "digest",
		modelRegistryRevision: "registry",
		model: "gpt-6-astra",
		effort: "high",
	};
	expect(await f.adapter.apply(target)).toMatchObject({ status: "applied" });
	await expect(
		f.adapter.apply({ ...target, threadId: "old-thread" }),
	).rejects.toThrow("runtime_identity_changed");
	expect(f.apply).toHaveBeenCalledTimes(1);
});
it("only reuses verified capabilities for offline transport with unchanged credential identity", async () => {
	const f = fixture();
	await f.adapter.preflight(f.identity);
	f.probe.mockRejectedValue(
		Object.assign(new Error("offline"), { code: "ECONNREFUSED" }),
	);
	expect(await f.adapter.preflight(f.identity)).toMatchObject({
		online: false,
		carrierId: "carrier",
	});
	f.env.RAYA_TOKEN = "rotated";
	await expect(f.adapter.preflight(f.identity)).rejects.toThrow(
		"runtime_unavailable",
	);
});
it("never treats a live unsupported or mismatched owner as cached offline support", async () => {
	const f = fixture();
	await f.adapter.preflight(f.identity);
	f.probe.mockResolvedValue({
		...(await f.probe()),
		socketOwnerId: "replacement",
	});
	await expect(f.adapter.preflight(f.identity)).rejects.toThrow(
		"runtime_hot_config_unsupported",
	);
});
it("revalidates canonical identity after the capability await and rejects env-pinned sources", async () => {
	const f = fixture();
	const value = await f.probe();
	f.probe.mockImplementation(async () => {
		f.raw[0]!.leads[0]!.botUserId = "22345678901234567";
		f.save();
		return value;
	});
	await expect(f.adapter.preflight(f.identity)).rejects.toThrow(
		"runtime_identity_changed",
	);
	f.env.FLYWHEEL_PROJECTS = "[]";
	await expect(f.adapter.preflight(f.identity)).rejects.toThrow(
		"registry_source_env_pinned",
	);
});
