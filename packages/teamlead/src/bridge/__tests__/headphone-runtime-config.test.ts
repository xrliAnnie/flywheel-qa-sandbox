import { describe, expect, it } from "vitest";
import {
	DEFAULT_HEADPHONE_INBOX_RETENTION_MS,
	resolveHeadphoneBackgroundConfig,
} from "../headphone-runtime-config.js";

describe("headphone background runtime config", () => {
	it("is off by default and only starts after an explicit opt-in", () => {
		expect(resolveHeadphoneBackgroundConfig({})).toEqual({
			enabled: false,
			retentionMs: DEFAULT_HEADPHONE_INBOX_RETENTION_MS,
		});
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED: "0",
			}),
		).toMatchObject({ enabled: false });
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED: "1",
			}),
		).toMatchObject({ enabled: true });
	});

	it("uses a bounded configurable inbox retention window", () => {
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_INBOX_RETENTION_DAYS: "7",
			}),
		).toMatchObject({ retentionMs: 7 * 24 * 60 * 60_000 });
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_INBOX_RETENTION_DAYS: "0",
			}),
		).toMatchObject({ retentionMs: DEFAULT_HEADPHONE_INBOX_RETENTION_MS });
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_INBOX_RETENTION_DAYS: "not-a-number",
			}),
		).toMatchObject({ retentionMs: DEFAULT_HEADPHONE_INBOX_RETENTION_MS });
		expect(
			resolveHeadphoneBackgroundConfig({
				FLYWHEEL_HEADPHONE_INBOX_RETENTION_DAYS: "366",
			}),
		).toMatchObject({ retentionMs: DEFAULT_HEADPHONE_INBOX_RETENTION_MS });
	});
});
