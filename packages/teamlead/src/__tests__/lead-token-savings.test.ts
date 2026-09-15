import { afterEach, beforeEach, expect, it } from "vitest";
import { readScopedBoolean } from "../bridge/flag-store-runtime.js";
import { StateStore } from "../StateStore.js";

let store: StateStore;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
});
afterEach(() => store.close());

const name = "lead_token_savings";
function set(scope: string, rawTo: string | null) {
	expect(
		store.applyScopedFlagValueChange({
			name,
			scope,
			rawTo,
			op: rawTo === null ? "clear" : "set",
			expectedChangeSeq: store.getFlagValueChangeSeq(name, scope),
			actor: "fixture-lead",
			reason: "kill-switch regression",
		}).ok,
	).toBe(true);
}

it("defaults ON and reads OFF/ON immediately without rebuilding the runtime", () => {
	const runtime = { mode: "ready" as const, store };
	const read = (project: string) => readScopedBoolean(runtime, name, project);
	expect(read("flywheel")).toBe(true);
	set("flywheel", "0");
	expect(read("flywheel")).toBe(false);
	expect(read("other-project")).toBe(true);
	set("flywheel", "1");
	expect(read("flywheel")).toBe(true);
	set("*", "0");
	expect(read("flywheel")).toBe(true);
	expect(read("other-project")).toBe(false);
	set("flywheel", null);
	expect(read("flywheel")).toBe(false);
	set("*", null);
	expect(read("flywheel")).toBe(true);
});
