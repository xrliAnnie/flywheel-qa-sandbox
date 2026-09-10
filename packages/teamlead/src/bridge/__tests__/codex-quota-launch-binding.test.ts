import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexQuotaLaunchBinder } from "../../codex-quota/launch-binding.js";
import { StateStore } from "../../StateStore.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("Codex pre-auth quota binding", () => {
	it("binds each physical daemon incarnation to checked target credentials and persistent generation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-launch-binding-"));
		roots.push(dir);
		const canonicalHome = join(dir, "canonical");
		mkdirSync(canonicalHome);
		writeFileSync(join(canonicalHome, "auth.json"), "business", {
			mode: 0o600,
		});
		const home = join(dir, "runner");
		mkdirSync(home);
		symlinkSync(join(canonicalHome, "auth.json"), join(home, "auth.json"));
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1",
			project_name: "fixture",
			status: "running",
		});
		const bind = createCodexQuotaLaunchBinder({
			store,
			canonicalHome,
			identify: (raw) => ({ profile: raw, accountKey: `key-${raw}` }),
		});
		const first = await bind(home, "exec-1");
		const second = await bind(home, "exec-1");
		expect(first.generation).toBe(1);
		expect(second.bindingId).not.toBe(first.bindingId);
		expect(store.codexQuota.getBinding(first.bindingId)).toEqual(first);
		expect(second.accountKey).toBe("key-business");
		store.codexQuota.recordSignal({
			executionId: "exec-1",
			bindingId: first.bindingId,
		});
		await expect(bind(home, "exec-1")).rejects.toThrow("quota_launch_paused");
	});
});

it("refuses a pause recorded after auth read before registering a fresh binding", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-binding-race-"));
	roots.push(dir);
	const canonicalHome = join(dir, "canonical");
	mkdirSync(canonicalHome);
	writeFileSync(join(canonicalHome, "auth.json"), "business", { mode: 0o600 });
	const home = join(dir, "runner");
	mkdirSync(home);
	symlinkSync(join(canonicalHome, "auth.json"), join(home, "auth.json"));
	const store = await StateStore.create(":memory:");
	stores.push(store);
	for (const executionId of ["old", "new"])
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-2465",
			project_name: "fixture",
			status: "running",
		});
	const identify = () => ({ profile: "business", accountKey: "business" });
	const prior = await createCodexQuotaLaunchBinder({
		store,
		canonicalHome,
		identify,
	})(home, "old");
	const quota = store.codexQuota;
	vi.spyOn(store, "codexQuota", "get").mockReturnValue(quota);
	const register = vi.spyOn(quota, "registerBinding");
	const racingBind = createCodexQuotaLaunchBinder({
		store,
		canonicalHome,
		identify: () => {
			store.codexQuota.recordSignal({
				executionId: "old",
				bindingId: prior.bindingId,
			});
			return identify();
		},
	});
	await expect(racingBind(home, "new")).rejects.toThrow("quota_launch_paused");
	expect(register).not.toHaveBeenCalled();
});
