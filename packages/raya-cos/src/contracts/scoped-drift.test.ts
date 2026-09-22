import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";

const now = new Date("2026-09-15T04:00:00Z");
const envelope = contracts.parseDriftEnvelope(
	"【偏离】\n依据: snapshot=snap-1 goals=g-20260915-01 readings=flywheel.openPrs.returnedCount\n仍有三个待处理 PR，是否影响本周稳定性目标？",
);
const goal = { id: "g-20260915-01", status: "active", projects: ["flywheel"] };
const snapshot = {
	snapshotId: "snap-1",
	sampledAt: now.toISOString(),
	projects: [
		{
			projectName: "flywheel",
			openPrs: { returnedCount: { ok: true, value: 3, at: now.toISOString() } },
		},
	],
};
function validate(extra: object = {}) {
	const fn = (
		contracts as unknown as {
			validateScopedDriftEnvelope: (
				envelope: unknown,
				context: object,
			) => unknown;
		}
	).validateScopedDriftEnvelope;
	expect(fn).toBeTypeOf("function");
	return fn(envelope, {
		snapshot,
		goals: [goal],
		now,
		staleAfterMs: 300000,
		...extra,
	});
}
describe("scoped fresh drift evidence", () => {
	it("requires each goal and cited project to share an explicit scope", () => {
		expect(validate()).toMatchObject({ kind: "valid" });
		expect(
			validate({ goals: [{ ...goal, projects: ["raya"] }] }),
		).toMatchObject({ kind: "invalid", reason: "goal_project_mismatch" });
		expect(
			validate({ goals: [{ ...goal, projects: undefined }] }),
		).toMatchObject({ kind: "invalid", reason: "goal_scope_unknown" });
		expect(
			validate({ goals: [{ ...goal, status: "withdrawn" }] }),
		).toMatchObject({ kind: "invalid", reason: "goal_not_active" });
	});
	it("rejects stale or future snapshots and individually stale reading timestamps", () => {
		expect(validate({ now: new Date(now.getTime() + 300001) })).toMatchObject({
			kind: "invalid",
			reason: "stale_snapshot",
		});
		expect(validate({ now: new Date(now.getTime() - 1) })).toMatchObject({
			kind: "invalid",
			reason: "stale_snapshot",
		});
		expect(
			validate({
				snapshot: {
					...snapshot,
					projects: [
						{
							projectName: "flywheel",
							openPrs: {
								returnedCount: {
									ok: true,
									value: 3,
									at: "2026-09-14T04:00:00Z",
								},
							},
						},
					],
				},
			}),
		).toMatchObject({ kind: "invalid", reason: "stale_reading" });
	});
});
