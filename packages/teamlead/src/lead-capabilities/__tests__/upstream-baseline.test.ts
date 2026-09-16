import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { assertUpstreamToolsPinned } from "../upstream-baseline.js";

it("checks all captured tools against exact server version and schema digests without omissions", () => {
	for (const server of ["gbrain", "xiaohongshu-mcp", "context7"]) {
		const snapshot = JSON.parse(
			readFileSync(
				resolve(
					`../../engineering/doc/FLY-2519-codex-lead-parity/upstream-${server}-schema.json`,
				),
				"utf8",
			),
		);
		const baseline = {
			serverId: server,
			version: snapshot.serverInfo.version,
			toolSchemaDigest: snapshot.toolSchemaDigest,
		};
		const current = {
			serverId: server,
			version: snapshot.serverInfo.version,
			tools: snapshot.tools,
		};
		expect(assertUpstreamToolsPinned(baseline, current).toolNames).toHaveLength(
			snapshot.tools.length,
		);
		expect(() =>
			assertUpstreamToolsPinned(baseline, { ...current, version: "changed" }),
		).toThrow("baseline_drift");
		expect(() =>
			assertUpstreamToolsPinned(baseline, {
				...current,
				tools: current.tools.slice(1),
			}),
		).toThrow("baseline_drift");
		expect(() =>
			assertUpstreamToolsPinned(baseline, {
				...current,
				tools: [...current.tools, current.tools[0]],
			}),
		).toThrow("baseline_drift");
		const changed = structuredClone(current);
		changed.tools[0].description = "changed";
		expect(() => assertUpstreamToolsPinned(baseline, changed)).toThrow(
			"baseline_drift",
		);
		expect(() =>
			assertUpstreamToolsPinned(baseline, { ...current, serverId: "foreign" }),
		).toThrow("baseline_drift");
		expect(
			assertUpstreamToolsPinned(baseline, {
				...current,
				tools: [...current.tools].reverse(),
			}),
		).toEqual(assertUpstreamToolsPinned(baseline, current));
	}
});
