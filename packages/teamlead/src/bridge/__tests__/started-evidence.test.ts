import { describe, expect, it, vi } from "vitest";
import { checkStartedEvidence } from "../started-evidence.js";

const EXEC = "succ-exec-1";
const PROJ = "geoforge3d";

describe("checkStartedEvidence", () => {
	it.each(["gone", "pending", "present"])(
		"FLY-2919 a live accepted body is started with %s window metadata",
		async (shape) => {
			const deps = {
				lookup: vi.fn(() => shape),
				probeWindow: vi.fn(() => "dead"),
				readBodyLiveness: vi.fn(() => "alive" as const),
			};
			expect(await checkStartedEvidence(EXEC, PROJ, deps)).toEqual({
				started: true,
			});
			expect(deps.readBodyLiveness).toHaveBeenCalledWith(EXEC, PROJ);
			expect(deps.lookup).not.toHaveBeenCalled();
			expect(deps.probeWindow).not.toHaveBeenCalled();
		},
	);
	it.each(["dead", "unknown"] as const)(
		"FLY-2919 a present window cannot override %s process evidence",
		async (verdict) => {
			const deps = {
				probeWindow: vi.fn(() => "alive"),
				readBodyLiveness: () => verdict,
			};
			expect(await checkStartedEvidence(EXEC, PROJ, deps)).toEqual({
				started: false,
				reason: verdict === "dead" ? "body_dead" : "lookup_error",
			});
			expect(deps.probeWindow).not.toHaveBeenCalled();
		},
	);
	it("missing reader refuses replay", async () => {
		expect(await checkStartedEvidence(EXEC, PROJ)).toEqual({
			started: false,
			reason: "lookup_error",
		});
	});
	it("observer failure refuses replay", async () => {
		expect(
			await checkStartedEvidence(EXEC, PROJ, {
				readBodyLiveness: () => {
					throw new Error("unavailable");
				},
			}),
		).toEqual({ started: false, reason: "lookup_error" });
	});
});
