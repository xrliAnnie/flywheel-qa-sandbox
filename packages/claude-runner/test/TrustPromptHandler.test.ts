import { describe, expect, it, vi } from "vitest";
import { TrustPromptHandler } from "../src/TrustPromptHandler.js";

describe("TrustPromptHandler", () => {
	describe("isTrustPrompt", () => {
		it("detects 'Do you trust the files in this folder'", () => {
			const output = "? Do you trust the files in this folder? (y/N)";
			expect(TrustPromptHandler.isTrustPrompt(output)).toBe(true);
		});

		it("detects 'trust this folder' (case insensitive)", () => {
			const output = "Please Trust This Folder to continue.";
			expect(TrustPromptHandler.isTrustPrompt(output)).toBe(true);
		});

		it("returns false for normal output", () => {
			const output = "Running tests... 42 passed, 0 failed.";
			expect(TrustPromptHandler.isTrustPrompt(output)).toBe(false);
		});

		it("detects 'Enter to confirm'", () => {
			const output = "Press Enter to confirm your selection.";
			expect(TrustPromptHandler.isTrustPrompt(output)).toBe(true);
		});

		it("detects 'trust this project'", () => {
			const output = "Do you want to trust this project?";
			expect(TrustPromptHandler.isTrustPrompt(output)).toBe(true);
		});
	});

	describe("dismiss", () => {
		it("calls tmux send-keys with Enter", () => {
			const execFile = vi.fn().mockReturnValue({ stdout: "" });
			TrustPromptHandler.dismiss(execFile, "flywheel:@42");
			expect(execFile).toHaveBeenCalledWith("tmux", [
				"send-keys",
				"-t",
				"flywheel:@42",
				"Enter",
			]);
		});
	});
});
