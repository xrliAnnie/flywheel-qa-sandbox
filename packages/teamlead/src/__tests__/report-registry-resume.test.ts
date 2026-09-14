import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReportRegistry } from "../bridge/report-registry.js";

it("resumes the same ordinary token and creation time without losing intervening reports", async () => {
	const dir = mkdtempSync(join(tmpdir(), "report-resume-"));
	let now = Date.parse("2026-09-11T00:00:00.000Z");
	try {
		const registry = new ReportRegistry(dir, { now: () => now });
		await registry.ensureVercelProjectName();
		const binding = registry.hostingBinding();
		const original = registry.stagePublish(
			"flywheel",
			"<html><head></head><body>history</body></html>",
			"history",
			binding,
		);
		const intervening = registry.stagePublish(
			"raya",
			"<html><head></head><body>other</body></html>",
			undefined,
			binding,
		);
		await intervening.commit();
		now += 60000;
		const restored = new ReportRegistry(dir, { now: () => now });
		const resumed = restored.resumePublish(
			original.entry,
			original.html,
			binding,
		);
		expect(resumed.entry).toEqual(original.entry);
		await resumed.commit();
		expect(restored.list().map((row) => row.token)).toEqual([
			intervening.entry.token,
			original.entry.token,
		]);
		const again = restored.resumePublish(
			original.entry,
			original.html,
			binding,
		);
		await again.commit();
		expect(restored.list()).toHaveLength(2);
		expect(restored.readReportHtml(original.entry.token)).toBe(original.html);
		expect(() =>
			restored.resumePublish(
				{ ...original.entry, projectName: "raya" },
				original.html,
				binding,
			),
		).toThrow();
		expect(() =>
			restored.resumePublish(
				original.entry,
				original.html.replace("history", "mutated"),
				binding,
			),
		).toThrow();
		now += 14 * 86400000;
		expect(() =>
			restored.resumePublish(original.entry, original.html, binding),
		).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
