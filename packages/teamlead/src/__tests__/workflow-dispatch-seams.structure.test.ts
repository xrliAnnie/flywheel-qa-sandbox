import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// FLY-1385 W6 structural guard (plan §3 W6 + §4 item 8).
//
// vendor-at-dispatch only holds if EVERY production admission seam resolves the
// dispatch triple before admitting, then reads the durable runtime at launch. A
// fourth seam added later that admits with a pinned snapshot would silently
// reintroduce the authority split that W6 closed, and no behavioral test would
// notice because the new seam would simply not be exercised. So the caller list
// itself is the assertion: adding a seam must be a deliberate edit here.

const SRC_ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

// The admission primitive's own definition lives here; it is not a caller.
const DEFINITION_FILE = "StateStore.ts";

const EXPECTED_ADMISSION_SEAMS = [
	"bridge/actions.ts",
	"bridge/runs-route.ts",
	"bridge/workflow-engine-dispatcher.ts",
];

function productionSourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__" || entry === "node_modules") continue;
			productionSourceFiles(full, acc);
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) acc.push(full);
	}
	return acc;
}

function relative(path: string): string {
	return path.slice(SRC_ROOT.length).replace(/^\/+/, "");
}

describe("FLY-1385 W6 — generalized admission seam inventory", () => {
	const callers = productionSourceFiles(SRC_ROOT)
		.filter((file) => relative(file) !== DEFINITION_FILE)
		.filter((file) =>
			readFileSync(file, "utf8").includes("admitGeneralizedWorkflowExecution("),
		)
		.map(relative)
		.sort();

	it("has exactly the three reviewed production admission seams", () => {
		// If this fails, a new admission call site appeared. Do not just widen the
		// list: the new seam must resolve dispatch before admitting (asserted below)
		// or vendor-at-dispatch is no longer the single source of truth.
		expect(callers).toEqual(EXPECTED_ADMISSION_SEAMS);
	});

	it.each(EXPECTED_ADMISSION_SEAMS)(
		"resolves the dispatch triple before admitting in %s",
		(seam) => {
			const source = readFileSync(join(SRC_ROOT, seam), "utf8");
			const resolveAt = source.indexOf("resolveNodeDispatchAtLaunch(store, {");
			const admitAt = source.indexOf("admitGeneralizedWorkflowExecution({");

			expect(resolveAt).toBeGreaterThan(-1);
			expect(admitAt).toBeGreaterThan(-1);
			// Resolution must precede admission so the admitted runtime is the live
			// one, not the pinned snapshot.
			expect(resolveAt).toBeLessThan(admitAt);
		},
	);

	it.each(EXPECTED_ADMISSION_SEAMS)(
		"launches %s from the durable runtime rather than re-resolving",
		(seam) => {
			const source = readFileSync(join(SRC_ROOT, seam), "utf8");
			const admitAt = source.indexOf("admitGeneralizedWorkflowExecution({");
			const runtimeReadAt = source.indexOf(
				"getWorkflowExecutionRuntime(",
				admitAt,
			);

			// After admission the seam reads back the immutable runtime row; a second
			// resolveNodeDispatchAtLaunch after admission would mean a crash between
			// admit and launch could hand the successor a different vendor.
			expect(runtimeReadAt).toBeGreaterThan(admitAt);
			expect(
				source.slice(admitAt).includes("resolveNodeDispatchAtLaunch("),
			).toBe(false);
		},
	);
});
