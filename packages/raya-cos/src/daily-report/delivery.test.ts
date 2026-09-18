import { describe, expect, it, vi } from "vitest";
import type { CoSPorts } from "../ports.js";
import { announceDailyReportChunk, dailyReportEventId } from "./delivery.js";

const SHA = "b".repeat(40);

describe("daily report Bridge delivery", () => {
	it("uses a stable business event id and preserves an ambiguous outcome", async () => {
		const announce = vi.fn(async () => ({ status: "ambiguous" as const }));
		const ports = { announce } as unknown as CoSPorts;
		const result = await announceDailyReportChunk(
			{
				date: "2026-09-08",
				fileSha: SHA,
				kind: "body",
				index: 1,
				text: "判断",
			},
			ports,
		);

		expect(dailyReportEventId("2026-09-08", SHA, "body", 1)).toBe(
			`daily-report:2026-09-08:${SHA}:body:1`,
		);
		expect(announce).toHaveBeenCalledWith({
			eventId: `daily-report:2026-09-08:${SHA}:body:1`,
			target: "chat",
			text: "判断",
		});
		expect(result.status).toBe("ambiguous");
		expect(result.messageId).toBeUndefined();
	});
});
