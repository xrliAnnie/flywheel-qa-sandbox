import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readSummaryGranularity,
	type SummaryConfigError,
} from "../summary-config.js";

describe("FLY-2030 summary granularity config", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
	});

	it("reports unselected when the canonical config file is absent", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2030-summary-config-"));
		dirs.push(homeDir);

		expect(readSummaryGranularity({ homeDir })).toEqual({
			state: "unselected",
		});
	});

	it("wraps source read failures in a structured error", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2030-summary-config-"));
		dirs.push(homeDir);
		const configDir = join(homeDir, ".flywheel");
		mkdirSync(configDir);
		mkdirSync(join(configDir, "summary-config.json"));

		expect(() => readSummaryGranularity({ homeDir })).toThrowError(
			expect.objectContaining<Partial<SummaryConfigError>>({
				code: "summary_config_source_error",
			}),
		);
	});

	it("returns a selected per-lead mode with its authority metadata", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2030-summary-config-"));
		dirs.push(homeDir);
		const configDir = join(homeDir, ".flywheel");
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T09:00:00.000Z",
			}),
		);

		expect(readSummaryGranularity({ homeDir })).toEqual({
			state: "selected",
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-08-28T09:00:00.000Z",
		});
	});

	it.each([
		[
			"unknown granularity",
			{
				granularity: "per-team",
				setBy: "founder",
				setAt: "2026-08-28T09:00:00.000Z",
			},
		],
		[
			"empty authority",
			{
				granularity: "per-project",
				setBy: "",
				setAt: "2026-08-28T09:00:00.000Z",
			},
		],
		[
			"invalid timestamp",
			{ granularity: "per-project", setBy: "founder", setAt: "yesterday" },
		],
		[
			"ambiguous timestamp accepted by Date.parse",
			{ granularity: "per-project", setBy: "founder", setAt: "0" },
		],
		[
			"normalized invalid calendar timestamp",
			{
				granularity: "per-project",
				setBy: "founder",
				setAt: "2026-02-30T09:00:00.000Z",
			},
		],
		["non-object", []],
	] as const)("rejects %s instead of guessing a mode", (_label, value) => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2030-summary-config-"));
		dirs.push(homeDir);
		const configDir = join(homeDir, ".flywheel");
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "summary-config.json"),
			JSON.stringify(value),
		);

		expect(() => readSummaryGranularity({ homeDir })).toThrowError(
			expect.objectContaining<Partial<SummaryConfigError>>({
				code: "summary_config_invalid",
			}),
		);
	});
});
