import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({
		status: 0,
		stdout: '{"status":"committed"}\n',
		stderr: "",
	})),
}));

import { spawnSync } from "node:child_process";
import { runLeadRegistryCommand } from "../commands/lead-registry.js";

it("routes the verification command to the bounded compiled entry", () => {
	const out: string[] = [];
	expect(
		runLeadRegistryCommand(
			[
				"verify-backend-migration",
				"--migration",
				"FLY-2459-honey-lemon",
				"--evidence",
				"/tmp/locators.json",
			],
			{ stdout: (s) => out.push(s), stderr: () => {} },
		),
	).toBe(0);
	expect(out).toEqual(['{"status":"committed"}']);
	expect(spawnSync).toHaveBeenCalledWith(
		process.execPath,
		[
			expect.stringMatching(
				/teamlead\/dist\/bin\/verify-backend-migration.js$/,
			),
			"--migration",
			"FLY-2459-honey-lemon",
			"--evidence",
			"/tmp/locators.json",
		],
		expect.objectContaining({ timeout: 45000 }),
	);
});
