import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadOrCollectMigrationOperator } from "../lead-backend-migration-operator.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-operator-"));
	dirs.push(home);
	const dir = join(home, ".flywheel/lead-backend-migrations");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const botUserId = "123456789012345678",
		channelId = "223456789012345678";
	const artifact = {
		version: 1 as const,
		migrationId: "FLY-2459-honey-lemon" as const,
		botUserId,
		writerStoppedAt: "2026-09-11T00:00:00.000Z",
		channels: [
			{
				channelId,
				observedAt: "2026-09-11T00:00:00.000Z",
				cutoffId: channelId,
				lastBotReplyId: null,
				unresolvedMessageIds: [channelId],
				unresolvedBefore: null,
			},
		],
	};
	const collect = vi.fn(async () => structuredClone(artifact));
	return {
		home,
		dir,
		artifact,
		input: {
			home,
			intentSha: "a".repeat(64),
			botUserId,
			channelIds: [channelId],
			collect,
		},
	};
}
it("reuses the first private snapshot without recollecting after restart", async () => {
	const f = fixture();
	const first = await loadOrCollectMigrationOperator(f.input);
	const path = join(f.dir, "FLY-2459-honey-lemon.operator.json");
	const bytes = readFileSync(path);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(first.cutoffs).toEqual(f.artifact);
	expect(await loadOrCollectMigrationOperator(f.input)).toEqual(first);
	expect(f.input.collect).toHaveBeenCalledTimes(1);
	expect(readFileSync(path)).toEqual(bytes);
});
it("refuses an existing snapshot bound to a different intent", async () => {
	const f = fixture();
	await loadOrCollectMigrationOperator(f.input);
	await expect(
		loadOrCollectMigrationOperator({ ...f.input, intentSha: "b".repeat(64) }),
	).rejects.toThrow(/operator/);
	expect(f.input.collect).toHaveBeenCalledTimes(1);
});
it("does not replace symlinked or corrupt evidence", async () => {
	const f = fixture();
	const target = join(f.home, "target");
	writeFileSync(target, "keep");
	symlinkSync(target, join(f.dir, "FLY-2459-honey-lemon.operator.json"));
	await expect(loadOrCollectMigrationOperator(f.input)).rejects.toThrow();
	expect(readFileSync(target, "utf8")).toBe("keep");
	expect(f.input.collect).not.toHaveBeenCalled();
});
it("a failed collection publishes nothing and can be retried", async () => {
	const f = fixture();
	f.input.collect.mockRejectedValueOnce(new Error("offline"));
	await expect(loadOrCollectMigrationOperator(f.input)).rejects.toThrow(
		"offline",
	);
	expect((await loadOrCollectMigrationOperator(f.input)).cutoffs).toEqual(
		f.artifact,
	);
});
it("concurrent collection preserves the winning artifact", async () => {
	const f = fixture();
	const values = await Promise.all([
		loadOrCollectMigrationOperator(f.input),
		loadOrCollectMigrationOperator(f.input),
	]);
	expect(values[0]).toEqual(values[1]);
});
