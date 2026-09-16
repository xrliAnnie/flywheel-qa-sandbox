import { expect, it, vi } from "vitest";
import {
	captureTerminalOutput,
	searchTerminalOutput,
} from "../terminal-observation.js";

it("captures a bounded number of lines and caps UTF8 bytes without breaking characters", async () => {
	const capture = vi.fn(async () => "雪".repeat(100000));
	const result = await captureTerminalOutput("runner:0", 100, capture);
	expect(capture).toHaveBeenCalledWith("runner:0", 100);
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(262144);
	expect(result.text).not.toContain("�");
	await expect(
		captureTerminalOutput("runner:0", 1001, capture),
	).rejects.toThrow();
	await expect(captureTerminalOutput("", 10, capture)).rejects.toThrow();
	expect(capture).toHaveBeenCalledOnce();
});
it("uses bounded safe regex and returns numbered matching lines", async () => {
	expect(
		await searchTerminalOutput(
			{ text: "first\nneedle one\nlast\nneedle two", truncated: false },
			"needle",
		),
	).toEqual({
		text: "2: needle one\n4: needle two",
		truncated: false,
	});
	expect(
		await searchTerminalOutput({ text: "a\nb", truncated: true }, "missing"),
	).toEqual({ text: "", truncated: true });
	await expect(
		searchTerminalOutput({ text: "a", truncated: false }, "(a+)+$"),
	).rejects.toThrow();
	await expect(
		searchTerminalOutput({ text: "a", truncated: false }, "x".repeat(257)),
	).rejects.toThrow();
});

it("terminates pathological regex work within its fixed CPU budget", async () => {
	await expect(
		searchTerminalOutput(
			{ text: "a".repeat(20000) + "!", truncated: false },
			"(a|aa)+$",
		),
	).rejects.toThrow("terminal_search_timeout");
}, 5000);
