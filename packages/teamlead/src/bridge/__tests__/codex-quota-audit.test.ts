import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectCodexQuotaAudit } from "../../codex-quota/audit.js";
import { StateStore } from "../../StateStore.js";

it("projects durable failed and interrupted installs without credential material, then reconstructs commit status", async () => {
	const directory = await mkdtemp(join(tmpdir(), "quota-audit-"));
	const store = await StateStore.create(":memory:");
	try {
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "binding",
			executionId: "exec",
			runId: "run",
			purpose: "runner",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
		});
		store.codexQuota.recordSwitchAudit({
			switchId: "failed",
			incidentId: "codex:root:1",
			from: "business",
			to: "personal",
			reason: "usage_limit",
			probeResult: "failed",
		});
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-key",
			priorAuthDigest: "secret-digest",
			installedAuthDigest: "a".repeat(64),
			recoveryMaterialPath: "/private/secret/auth",
		});
		await projectCodexQuotaAudit(store.codexQuota, directory);
		const path = join(directory, "codex-quota", "switch-audit.jsonl");
		const first = await readFile(path, "utf8");
		expect(first).not.toContain("secret");
		expect(first).not.toContain("school-key");
		const rows = first
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => !row.committed)).toBe(true);
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "school-key",
			profile: "school",
			authDigest: "a".repeat(64),
			probeResult: "ok",
		});
		await projectCodexQuotaAudit(store.codexQuota, directory);
		const committed = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(committed.find((row) => row.to === "school")).toMatchObject({
			committed: true,
			generation: 2,
			targetCount: 1,
			recoveredCount: 0,
		});
		expect(committed.find((row) => row.to === "personal").committed).toBe(
			false,
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
