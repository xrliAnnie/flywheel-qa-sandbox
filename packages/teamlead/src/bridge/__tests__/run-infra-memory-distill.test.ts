import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("flywheel-claude-runner", async (importOriginal) => ({
	...(await importOriginal<object>()),
	CodexTmuxAdapter: vi.fn(),
}));

import { CodexTmuxAdapter } from "flywheel-claude-runner";
import { createCodexRunAdapterFactory } from "../run-infra.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(CodexTmuxAdapter).mockClear();
});
describe("production Codex adapter memory wiring", () => {
	it("reads the governed value for each new adapter without changing existing decisions", () => {
		const readEnabled = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const factory = createCodexRunAdapterFactory(["session"], readEnabled);
		expect(readEnabled).not.toHaveBeenCalled();
		factory();
		factory();
		const calls = vi.mocked(CodexTmuxAdapter).mock.calls;
		expect(readEnabled).toHaveBeenCalledTimes(2);
		expect(calls[0][6]?.memoryDistill).toEqual({ enabled: true });
		expect(calls[1][6]?.memoryDistill).toEqual({ enabled: false });
	});
	it("keeps default ON when there is no store runtime", () => {
		createCodexRunAdapterFactory(["session"])();
		expect(vi.mocked(CodexTmuxAdapter).mock.calls[0][6]?.memoryDistill).toEqual(
			{ enabled: true },
		);
	});
});
