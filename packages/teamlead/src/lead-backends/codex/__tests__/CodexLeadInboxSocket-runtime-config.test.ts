import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	applyCodexLeadRuntimeConfig,
	CodexLeadInboxServer,
	probeCodexLeadInboxCapabilities,
	readCodexLeadRuntimeConfig,
} from "../CodexLeadInboxSocket.js";
import type { LeadRuntimeConfigTarget } from "../LeadRuntimeConfigCoordinator.js";

const roots: string[] = [];
const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const target: LeadRuntimeConfigTarget = {
	projectName: "raya",
	leadKey: "raya-raya",
	identityDigest: "identity",
	carrierId: "owner",
	ownerEpoch: "epoch",
	runtimeGeneration: "runtime",
	threadId: "thread",
	operationId: "op",
	configGeneration: 1,
	configDigest: "a".repeat(64),
	modelRegistryRevision: "registry",
	model: "gpt-6-astra",
	effort: "high",
};
async function setup(supported = true, buildSha = "a".repeat(40)) {
	const root = mkdtempSync(join(tmpdir(), "hot-socket-"));
	roots.push(root);
	const args = {
		socketPath: join(root, "inbox.sock"),
		leadId: "raya",
		authSecret: "test-secret",
	};
	const apply = vi.fn(async () => ({
		status: "pending_runtime" as const,
		operationId: target.operationId,
	}));
	const read = vi.fn(async () => ({
		model: target.model,
		effort: target.effort,
	}));
	const server = new CodexLeadInboxServer({
		...args,
		socketOwnerId: "owner",
		router: { submitBatch: vi.fn() },
		runtimeConfig: {
			isSupported: () => supported,
			identity: () => ({
				projectName: target.projectName,
				leadKey: target.leadKey,
				identityDigest: target.identityDigest,
				carrierId: target.carrierId,
				ownerEpoch: target.ownerEpoch,
				runtimeGeneration: target.runtimeGeneration,
				threadId: target.threadId,
				artifactBuildSha: buildSha,
				bootstrapBuildSha: "a".repeat(40),
			}),
			assertCurrent: (value: LeadRuntimeConfigTarget) => {
				if (JSON.stringify(value) !== JSON.stringify(target))
					throw new Error("authority_changed");
			},
			apply,
			read,
		},
	});
	servers.push(server);
	await server.listen();
	return { args, apply, read };
}
it("advertises verified capability, applies and reads on the same owner without a batch", async () => {
	const f = await setup();
	expect((await probeCodexLeadInboxCapabilities(f.args)).features).toContain(
		"lead_runtime_config_v1",
	);
	expect(
		await applyCodexLeadRuntimeConfig({ ...f.args, target }),
	).toMatchObject({ status: "pending_runtime" });
	expect(await readCodexLeadRuntimeConfig({ ...f.args, target })).toEqual({
		model: target.model,
		effort: target.effort,
	});
	expect(f.apply).toHaveBeenCalledOnce();
	expect(f.read).toHaveBeenCalledOnce();
	const old = await setup(false);
	expect(
		(await probeCodexLeadInboxCapabilities(old.args)).features,
	).not.toContain("lead_runtime_config_v1");
	await expect(
		applyCodexLeadRuntimeConfig({ ...old.args, target }),
	).rejects.toThrow("unsupported");
});
it("binds runtime capability metadata to the current owner and verified build", async () => {
	const f = await setup();
	const capabilities = await probeCodexLeadInboxCapabilities(f.args);
	expect(capabilities.runtimeIdentity).toMatchObject({
		carrierId: "owner",
		ownerEpoch: "epoch",
		runtimeGeneration: "runtime",
		threadId: "thread",
		artifactBuildSha: "a".repeat(40),
		bootstrapBuildSha: "a".repeat(40),
	});
	const stale = await setup(true, "b".repeat(40));
	const staleCapabilities = await probeCodexLeadInboxCapabilities(stale.args);
	expect(staleCapabilities.features).not.toContain("lead_runtime_config_v1");
	expect(staleCapabilities.runtimeIdentity).toBeUndefined();
	await expect(
		applyCodexLeadRuntimeConfig({ ...stale.args, target }),
	).rejects.toThrow("unsupported");
});
it("rejects stale ownership and invalid signatures before invoking a hook", async () => {
	const f = await setup();
	for (const changed of [
		{ carrierId: "old" },
		{ ownerEpoch: "old" },
		{ threadId: "wrong" },
		{ projectName: "other" },
	]) {
		await expect(
			applyCodexLeadRuntimeConfig({
				...f.args,
				target: { ...target, ...changed },
			}),
		).rejects.toThrow();
	}
	await expect(
		applyCodexLeadRuntimeConfig({ ...f.args, authSecret: "wrong", target }),
	).rejects.toThrow("authentication");
	expect(f.apply).not.toHaveBeenCalled();
});
async function raw(path: string, value: unknown) {
	return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
		const socket = createConnection(path);
		let data = "";
		socket.on("connect", () => socket.end(JSON.stringify(value)));
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("error", reject);
		socket.on("end", () => resolve(JSON.parse(data)));
	});
}
it("signs every configuration field and rejects unknown fields or method substitution", async () => {
	const f = await setup();
	const request = {
		version: 2,
		method: "applyRuntimeConfig",
		leadId: "raya",
		socketOwnerId: "owner",
		...target,
	};
	const auth = createHmac("sha256", f.args.authSecret)
		.update(JSON.stringify(request))
		.digest("hex");
	// This independently constructed canonical ordering is the wire contract.
	expect((await raw(f.args.socketPath, { ...request, auth })).ok).toBe(true);
	for (const change of [
		...Object.entries(target).map(([field, value]) => ({
			[field]: typeof value === "number" ? value + 1 : `${value}-changed`,
		})),
		...Object.entries(target).map(([field, value]) => ({
			[field]: typeof value === "number" ? value + 1 : `${value}-changed`,
		})),
		{ model: "gpt-5.6-sol" },
		{ effort: "low" },
		{ method: "readRuntimeConfig" },
		{ configGeneration: 2 },
		{ extra: "unknown" },
	]) {
		expect(
			(await raw(f.args.socketPath, { ...request, auth, ...change })).ok,
		).toBe(false);
	}
	expect(f.apply).toHaveBeenCalledTimes(1);
});
