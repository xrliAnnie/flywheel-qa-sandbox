import { readFileSync } from "node:fs";
import { FEATURE_FLAGS } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	buildFlagProvenance,
	extractFlagNamesFromRegistrySource,
	type GitCommandResult,
} from "../flag-provenance.js";

const REGISTRY_PATH = "packages/config/src/feature-flags/registry.ts";

function source(...names: string[]): string {
	return `
		export const FEATURE_FLAGS: readonly FeatureFlagSpec[] = [
			${names.map((name) => `{ name: ${JSON.stringify(name)}, category: "feature" }`).join(",\n")}
		];
	`;
}

function logRecord(input: {
	sha: string;
	at: number;
	author: string;
	body: string;
}): string {
	return `${input.sha}\x1f${input.at}\x1f${input.author}\x1f${input.body}\x1e`;
}

function executor(input: {
	log: string;
	shows: Record<string, GitCommandResult>;
	shallow?: boolean;
	calls?: string[][];
}) {
	return async (args: string[]): Promise<GitCommandResult> => {
		input.calls?.push(args);
		if (args[0] === "rev-parse") {
			return {
				exitCode: 0,
				stdout: input.shallow ? "true\n" : "false\n",
				stderr: "",
			};
		}
		if (args[0] === "log") {
			return { exitCode: 0, stdout: input.log, stderr: "" };
		}
		const revision = args[1] ?? "";
		return (
			input.shows[revision] ?? {
				exitCode: 128,
				stdout: "",
				stderr: `fatal: path '${REGISTRY_PATH}' does not exist in '${revision}'`,
			}
		);
	};
}

describe("extractFlagNamesFromRegistrySource", () => {
	it("understands the complete current production registry", () => {
		const registry = readFileSync(
			new URL(
				"../../../../config/src/feature-flags/registry.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(extractFlagNamesFromRegistrySource(registry)).toEqual(
			new Set(FEATURE_FLAGS.map(({ name }) => name)),
		);
	});

	it("extracts literal registry names and ignores comments outside the table", () => {
		expect(
			extractFlagNamesFromRegistrySource(`
				// name: "not-a-row"
				${source("alpha", "beta")}
			`),
		).toEqual(new Set(["alpha", "beta"]));
	});

	it("fails closed on an unknown dynamic name shape", () => {
		expect(() =>
			extractFlagNamesFromRegistrySource(`
				export const FEATURE_FLAGS = [{ name: dynamicName }];
			`),
		).toThrow(/unknown registry name syntax/i);
	});
});

describe("buildFlagProvenance", () => {
	it("ignores git log record newlines around the explicit separator", async () => {
		const calls: string[][] = [];
		const execGit = executor({
			log: "\nabc\x1f100\x1fTadashi\x1fFLY-1 create\n\x1e\n",
			shows: {
				[`abc:${REGISTRY_PATH}`]: {
					exitCode: 0,
					stdout: source("one"),
					stderr: "",
				},
			},
			calls,
		});
		await expect(
			buildFlagProvenance({ currentFlagNames: ["one"], execGit }),
		).resolves.toMatchObject([{ flagName: "one", sourceIssue: "FLY-1" }]);
		expect(calls.at(-1)?.[1]).toBe(`abc:${REGISTRY_PATH}`);
	});
	it("finds the current incarnation's last absent-to-present transition", async () => {
		const log = [
			logRecord({
				sha: "create",
				at: 100,
				author: "Original Author",
				body: "feat: add alpha FLY-10 (#40)\n\nbody",
			}),
			logRecord({
				sha: "delete",
				at: 200,
				author: "Cleaner",
				body: "remove alpha FLY-20 (#50)",
			}),
			logRecord({
				sha: "readd",
				at: 300,
				author: "Current Author",
				body: "feat: re-add alpha FLY-30 (#60)",
			}),
		].join("");
		const result = await buildFlagProvenance({
			currentFlagNames: ["alpha"],
			execGit: executor({
				log,
				shows: {
					[`create:${REGISTRY_PATH}`]: {
						exitCode: 0,
						stdout: source("alpha"),
						stderr: "",
					},
					[`delete:${REGISTRY_PATH}`]: {
						exitCode: 128,
						stdout: "",
						stderr: `fatal: path '${REGISTRY_PATH}' does not exist in 'delete'`,
					},
					[`readd:${REGISTRY_PATH}`]: {
						exitCode: 0,
						stdout: source("alpha"),
						stderr: "",
					},
				},
			}),
		});
		expect(result).toEqual([
			{
				flagName: "alpha",
				incarnationCommit: "readd",
				status: "resolved",
				sourceIssue: "FLY-30",
				author: "Current Author",
				committedAt: 300,
				prNumber: 60,
			},
		]);
	});

	it("treats the parent/file-absent side as a legal empty set", async () => {
		const log = logRecord({
			sha: "first",
			at: 100,
			author: "Founder",
			body: "FLY-1 initial registry",
		});
		await expect(
			buildFlagProvenance({
				currentFlagNames: ["alpha"],
				execGit: executor({
					log,
					shows: {
						[`first:${REGISTRY_PATH}`]: {
							exitCode: 0,
							stdout: source("alpha"),
							stderr: "",
						},
					},
				}),
			}),
		).resolves.toMatchObject([
			{ flagName: "alpha", incarnationCommit: "first" },
		]);
	});

	it.each([
		["no issue marker", "feat: direct add alpha (#77)"],
		["ambiguous issue markers", "FLY-1 and GEO-2 add alpha (#77)"],
	] as const)(
		"classifies %s as unresolved while preserving partial evidence",
		async (_label, body) => {
			const result = await buildFlagProvenance({
				currentFlagNames: ["alpha"],
				execGit: executor({
					log: logRecord({ sha: "one", at: 100, author: "Author", body }),
					shows: {
						[`one:${REGISTRY_PATH}`]: {
							exitCode: 0,
							stdout: source("alpha"),
							stderr: "",
						},
					},
				}),
			});
			expect(result).toMatchObject([
				{
					flagName: "alpha",
					status: "unresolved",
					sourceIssue: null,
					author: "Author",
					prNumber: 77,
				},
			]);
		},
	);

	it("uses one path-filtered first-parent log for the whole round", async () => {
		const calls: string[][] = [];
		await buildFlagProvenance({
			currentFlagNames: ["alpha", "beta"],
			execGit: executor({
				calls,
				log: logRecord({
					sha: "one",
					at: 100,
					author: "Author",
					body: "FLY-1 add both",
				}),
				shows: {
					[`one:${REGISTRY_PATH}`]: {
						exitCode: 0,
						stdout: source("alpha", "beta"),
						stderr: "",
					},
				},
			}),
		});
		const logCalls = calls.filter(([command]) => command === "log");
		expect(logCalls).toHaveLength(1);
		expect(logCalls[0]).toEqual([
			"log",
			"--first-parent",
			"--reverse",
			"--format=%H%x1f%ct%x1f%an%x1f%B%x1e",
			"--",
			REGISTRY_PATH,
		]);
	});

	it("fails closed for shallow history, git failures, or a current name absent from history", async () => {
		await expect(
			buildFlagProvenance({
				currentFlagNames: ["alpha"],
				execGit: executor({ log: "", shows: {}, shallow: true }),
			}),
		).rejects.toThrow(/shallow/i);

		await expect(
			buildFlagProvenance({
				currentFlagNames: ["alpha"],
				execGit: async () => {
					throw new Error("git timeout");
				},
			}),
		).rejects.toThrow(/timeout/i);

		await expect(
			buildFlagProvenance({
				currentFlagNames: ["alpha"],
				execGit: executor({
					log: logRecord({
						sha: "one",
						at: 100,
						author: "Author",
						body: "FLY-1 add beta",
					}),
					shows: {
						[`one:${REGISTRY_PATH}`]: {
							exitCode: 0,
							stdout: source("beta"),
							stderr: "",
						},
					},
				}),
			}),
		).rejects.toThrow(/absent at head/i);
	});
});
