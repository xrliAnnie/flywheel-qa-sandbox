import { FEATURE_FLAGS } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import {
	applyFlagToggle,
	type FlagToggleDeps,
	isDirectToggleable,
} from "../bridge/flag-toggle.js";

const ENV_CONTENT = "# env\nFLYWHEEL_OTHER=1\n";
const SHA = computeEnvSha(ENV_CONTENT);

function deps(over: Partial<FlagToggleDeps> = {}): FlagToggleDeps & {
	env: Record<string, string | undefined>;
	writeFile: ReturnType<typeof vi.fn>;
} {
	return {
		envPath: "/tmp/.env",
		readFile: () => ENV_CONTENT,
		writeFile: vi.fn(),
		env: {},
		lock: (fn: () => unknown) => fn(), // pass-through; real lock tested separately
		...over,
	} as FlagToggleDeps & {
		env: Record<string, string | undefined>;
		writeFile: ReturnType<typeof vi.fn>;
	};
}

describe("isDirectToggleable", () => {
	it("keeps store-backed call-time metadata direct and removes retired entries", () => {
		const direct = FEATURE_FLAGS.find((f) => f.name === "loop_profiler");
		expect(isDirectToggleable(direct as never)).toBe(true);
		for (const name of [
			"founder_review_orphan_monitor",
			"mailbox_queue",
			"lead_lease_bypass",
			"voice_qa_presence_override",
		]) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.name === name),
				name,
			).toBe(false);
		}
	});

	it("rejects non-boolean value flags even if later marked direct", () => {
		const direct = FEATURE_FLAGS.find((f) => f.name === "loop_profiler")!;
		expect(isDirectToggleable({ ...direct, valueKind: "value" } as never)).toBe(
			false,
		);
	});
});

describe("applyFlagToggle", () => {
	it("refuses a store-managed flag even when its registry metadata is direct", () => {
		expect(
			applyFlagToggle(deps(), {
				name: "workflow_turn_divergence_alerts",
				rawFrom: null,
				rawTo: "1",
				fileSha: SHA,
			}),
		).toMatchObject({
			ok: false,
			code: 409,
			reason:
				"workflow_turn_divergence_alerts is managed by the SQLite flag store",
		});
	});

	it("rejects unknown, conversational, and governance flags", () => {
		for (const name of [
			"nope",
			"voice_qa_presence_override",
			"lead_lease_bypass",
		]) {
			expect(
				applyFlagToggle(deps(), {
					name,
					rawFrom: null,
					rawTo: "0",
					fileSha: SHA,
				}).ok,
			).toBe(false);
		}
	});
});
