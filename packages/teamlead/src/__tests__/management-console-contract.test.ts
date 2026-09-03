import { describe, expect, it } from "vitest";
import {
	assertManagementSnapshot,
	buildCronTargetId,
	buildTargetId,
	fileSourceRevision,
	type ManagementSnapshot,
	makeManagedValue,
	parseTargetId,
} from "../bridge/management-console-contract.js";

function snapshot(): ManagementSnapshot {
	return {
		schemaVersion: 2,
		generatedAt: "2026-07-14T00:00:00.000Z",
		snapshotRevision: "snapshot:test",
		sources: [],
		modelCatalog: {},
		projects: [],
		presentationGroups: [],
		unassignedCrons: [],
		flags: [],
		extensions: [],
	};
}

describe("management console contract", () => {
	it("requires a versioned aggregate snapshot with every top-level section", () => {
		const value = { ...snapshot(), schemaVersion: 2 };
		expect(() => assertManagementSnapshot(value)).not.toThrow();
		expect(value).toMatchObject({
			schemaVersion: 2,
			projects: [],
			presentationGroups: [],
			unassignedCrons: [],
			flags: [],
			extensions: [],
		});
	});

	it.each([1, 3])(
		"rejects management snapshot schema version %i",
		(version) => {
			expect(() =>
				assertManagementSnapshot({ ...snapshot(), schemaVersion: version }),
			).toThrow(/schema version/i);
		},
	);

	it("represents value, revision, capability, consequence and source error", () => {
		const managed = makeManagedValue({
			targetId: buildTargetId("lead", ["flywheel", "eng-lead", "model"]),
			current: "claude-fable-5",
			source: {
				kind: "projects_json",
				revision: fileSourceRevision(Buffer.from("projects")),
				hint: "projects.json",
			},
			writeCapability: {
				writable: true,
				consequence: "restart-lead",
				requiresAcknowledgement: true,
			},
			error: "source warning",
		});
		expect(managed.current).toBe("claude-fable-5");
		expect(managed.source.revision).toMatch(/^file:[a-f0-9]{64}$/);
		expect(managed.writeCapability).toMatchObject({
			writable: true,
			consequence: "restart-lead",
		});
		expect(managed.error).toBe("source warning");
	});

	it("builds opaque stable ids from source identity, never current value", () => {
		const first = buildTargetId("flag", ["FLYWHEEL_EXAMPLE", "global"]);
		const same = buildTargetId("flag", ["FLYWHEEL_EXAMPLE", "global"]);
		const other = buildTargetId("flag", ["FLYWHEEL_EXAMPLE", "project:a"]);
		expect(first).toBe(same);
		expect(first).not.toBe(other);
		expect(first).not.toContain("FLYWHEEL_EXAMPLE");
		expect(parseTargetId(first)).toEqual({ kind: "flag", id: first });
	});

	it("distinguishes duplicate cron labels by plist identity without exposing paths", () => {
		const a = buildCronTargetId("/tmp/a/job.plist", "same.label", "schedule");
		const b = buildCronTargetId("/tmp/b/job.plist", "same.label", "schedule");
		expect(a).not.toBe(b);
		expect(a).not.toContain("/tmp/a");
		expect(a).not.toContain("same.label");
		expect(parseTargetId(a)?.kind).toBe("cron");
	});

	it("rejects unknown target and source kinds at the runtime boundary", () => {
		expect(() => parseTargetId("unknown_deadbeef", true)).toThrow(
			/target kind/i,
		);
		const invalid = snapshot() as unknown as Record<string, unknown>;
		invalid.sources = [{ kind: "manual_summary", revision: "x" }];
		expect(() => assertManagementSnapshot(invalid)).toThrow(/source kind/i);
	});

	it("serializes without hydrated config or secret-bearing keys", () => {
		const json = JSON.stringify(snapshot());
		for (const forbidden of [
			"botToken",
			"botTokenEnv",
			"match",
			"secret-canary",
		]) {
			expect(json).not.toContain(forbidden);
		}
	});
});
