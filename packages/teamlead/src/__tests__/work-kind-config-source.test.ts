import { describe, expect, it, vi } from "vitest";
import type { FlagStoreRuntime } from "../bridge/flag-store-runtime.js";
import { readPipelineEnrollment } from "../bridge/pipeline-config-source.js";
import type { StateStore } from "../StateStore.js";

function runtime(
	rows: Record<string, Record<string, "0" | "1">> = {},
): FlagStoreRuntime {
	return {
		mode: "ready",
		store: {
			getFlagValueRow(name: string, scope = "*") {
				const raw = rows[name]?.[scope];
				return raw === undefined ? undefined : { hasOverride: true, raw };
			},
		} as unknown as StateStore,
	};
}

describe("readPipelineEnrollment", () => {
	it("defaults absent rows to DAG-on with work-kind disabled", () => {
		expect(readPipelineEnrollment(runtime(), "flywheel")).toEqual({
			ok: true,
			workKind: false,
			dag: true,
		});
	});

	it("prefers a project row over the wildcard row", () => {
		expect(
			readPipelineEnrollment(
				runtime({
					pipeline_dag: { "*": "0", flywheel: "1" },
					pipeline_work_kind: { "*": "0", flywheel: "1" },
				}),
				"flywheel",
			),
		).toEqual({ ok: true, workKind: true, dag: true });
	});

	it("requires DAG when work-kind is enabled", () => {
		expect(
			readPipelineEnrollment(
				runtime({
					pipeline_dag: { flywheel: "0" },
					pipeline_work_kind: { flywheel: "1" },
				}),
				"flywheel",
			),
		).toEqual({ ok: false, cause: "work_kind_requires_dag" });
	});

	it("fails closed and warns when the store cannot be read", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const broken = runtime();
		broken.store.getFlagValueRow = (() => {
			throw new Error("store unavailable");
		}) as typeof broken.store.getFlagValueRow;
		expect(readPipelineEnrollment(broken, "flywheel")).toEqual({
			ok: true,
			workKind: false,
			dag: false,
		});
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("store unavailable"),
		);
		warn.mockRestore();
	});
});
