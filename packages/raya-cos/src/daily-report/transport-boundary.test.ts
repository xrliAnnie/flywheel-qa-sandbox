import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SummaryCollector } from "./collector.js";
import { ReportRepoWriter } from "./repo-writer.js";

describe("daily report transport ownership", () => {
	it("has no private process driver", () => {
		for (const name of ["collector.ts", "repo-writer.ts"])
			expect(
				readFileSync(new URL(name, import.meta.url), "utf8"),
			).not.toContain('from "node:child_process"');
	});
	it("requires explicit host adapters", () => {
		expect(
			() =>
				new SummaryCollector({
					ghBin: "/usr/bin/gh",
					maxSummaryBytes: 4096,
					maxTotalBytes: 16384,
				}),
		).toThrow(/host.*adapter/);
		expect(() => new ReportRepoWriter({ ghBin: "/usr/bin/gh" })).toThrow(
			/host.*adapter/,
		);
	});
});
