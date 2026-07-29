import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advanceDatabaseAuthorityStateTx,
	armCutoverAuthority,
	initializeRollbackFenceTx,
	Kernel,
	migrateDatabase,
	publishLiveCutoverAuthority,
	seedPreCutoverAuthority,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { readMatchingRuntimeAuthority } from "../runtime-authority.js";

describe("scheduler runtime authority", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("requires the machine authority and database authority to stay live and equal", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-scheduler-authority-"));
		const authorityPath = join(root, "authority.json");
		const armedPath = join(root, "armed.json");
		const dbPath = join(root, "flywheel-v2.db");
		const windowId = "window-runtime";
		const epoch = 4;
		seedPreCutoverAuthority({
			authorityPath,
			armedPath,
			windowId,
			epoch,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			authorityPath,
			armedPath,
			windowId,
			epoch,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		migrateDatabase({ path: dbPath });
		const kernel = Kernel.open({ path: dbPath });
		kernel.write("test.runtime-authority", (tx) => {
			initializeRollbackFenceTx(tx, {
				authorityState: "cutover",
				nowIso: "2026-07-28T00:02:00.000Z",
			});
			advanceDatabaseAuthorityStateTx(tx, {
				expected: "cutover",
				next: "live",
				nowIso: "2026-07-28T00:03:00.000Z",
			});
		});
		publishLiveCutoverAuthority({
			authorityPath,
			armedPath,
			windowId,
			epoch,
			nowIso: "2026-07-28T00:04:00.000Z",
		});

		expect(
			readMatchingRuntimeAuthority(kernel, {
				authorityPath,
				armedPath,
				windowId,
				epoch,
			}),
		).toBe("live");

		writeFileSync(authorityPath, "{}\n", { mode: 0o600 });
		expect(() =>
			readMatchingRuntimeAuthority(kernel, {
				authorityPath,
				armedPath,
				windowId,
				epoch,
			}),
		).toThrow(/cutover authority fail closed/i);
		kernel.close();
	});
});
