import { describe, expect, it } from "vitest";
import {
	DEFAULT_HEADPHONE_INBOX_RETENTION_MS,
	resolveHeadphoneBackgroundConfig,
} from "../headphone-runtime-config.js";

describe("headphone background runtime config", () => {
	it("uses a bounded configurable inbox retention window", () => {
		expect(resolveHeadphoneBackgroundConfig({})).toEqual({
			retentionMs: DEFAULT_HEADPHONE_INBOX_RETENTION_MS,
		});
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
