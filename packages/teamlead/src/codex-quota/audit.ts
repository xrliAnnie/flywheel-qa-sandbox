import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CodexQuotaStore } from "../bridge/codex-quota-store.js";
/** Bounded read-only patrol projection; the append-only database rows remain authoritative. */
export async function projectCodexQuotaAudit(
	store: CodexQuotaStore,
	stateRoot: string,
): Promise<void> {
	if (!isAbsolute(stateRoot))
		throw new Error("quota_audit_absolute_root_required");
	const directory = join(stateRoot, "codex-quota");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory())
		throw new Error("quota_audit_unsafe_directory");
	const rows = store
		.listSwitchAudit()
		.reverse()
		.map((row) => ({
			schemaVersion: 1,
			switchId: row.switch_id,
			incidentId: row.incident_id,
			at: row.at,
			vendor: "codex",
			from: row.from_profile,
			to: row.to_profile,
			reason: row.reason,
			probeResult: row.probe_result,
			committed:
				row.probe_result === "ok" &&
				!!row.installed_generation &&
				row.installed_auth_digest === row.committed_digest,
			generation: Number(row.installed_generation ?? 0),
			recoveredCount: Number(row.recovered_count),
			targetCount: Number(row.target_count),
		}));
	const temporary = join(directory, `.switch-audit-${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(
				rows.map((row) => JSON.stringify(row)).join("\n") +
					(rows.length ? "\n" : ""),
			);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(directory, "switch-audit.jsonl"));
		const dir = await open(directory, "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}
