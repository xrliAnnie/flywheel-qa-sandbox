import { describe, expect, it } from "vitest";
import {
	DEFAULT_WORKFLOW_DOCS_LIMITS,
	parseWorkflowDocsOutput,
} from "../workflow-docs-output.js";

describe("workflow docs_v1 output", () => {
	it("accepts write/delete deltas and canonicalizes operation order", () => {
		const result = parseWorkflowDocsOutput({
			kind: "docs_v1",
			operations: [
				{ op: "write", path: "engineering/doc/b.md", content: "b\n" },
				{ op: "delete", path: "docs/old.md" },
				{ op: "write", path: "doc/a.md", content: "a\n" },
			],
		});

		expect(result).toEqual({
			kind: "docs_v1",
			operations: [
				{ op: "write", path: "doc/a.md", content: "a\n" },
				{ op: "delete", path: "docs/old.md" },
				{ op: "write", path: "engineering/doc/b.md", content: "b\n" },
			],
		});
	});

	it.each([
		["wrong discriminator", { kind: "other", operations: [] }],
		[
			"extra top-level key",
			{ kind: "docs_v1", operations: [], repo: "evil/repo" },
		],
		["empty operations", { kind: "docs_v1", operations: [] }],
		[
			"unknown operation",
			{ kind: "docs_v1", operations: [{ op: "move", path: "docs/a.md" }] },
		],
		[
			"extra write key",
			{
				kind: "docs_v1",
				operations: [
					{ op: "write", path: "docs/a.md", content: "a", mode: "120000" },
				],
			},
		],
		[
			"delete content",
			{
				kind: "docs_v1",
				operations: [{ op: "delete", path: "docs/a.md", content: "a" }],
			},
		],
	])("rejects %s", (_label, payload) => {
		expect(() => parseWorkflowDocsOutput(payload)).toThrow(/docs_v1/i);
	});

	it.each([
		"/docs/a.md",
		"../docs/a.md",
		"docs/../a.md",
		"docs/./a.md",
		"docs//a.md",
		"docs\\a.md",
		".git/config",
		"engineering/doc",
		"packages/teamlead/README.md",
		"Docs/a.md",
		"docs/a\u0000.md",
		"docs/e\u0301.md",
	])("rejects unsafe or non-allowlisted path %j", (path) => {
		expect(() =>
			parseWorkflowDocsOutput({
				kind: "docs_v1",
				operations: [{ op: "write", path, content: "a" }],
			}),
		).toThrow(/path/i);
	});

	it("rejects exact and case-folded duplicate paths", () => {
		for (const duplicate of ["docs/a.md", "docs/A.md"]) {
			expect(() =>
				parseWorkflowDocsOutput({
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "docs/a.md", content: "a" },
						{ op: "delete", path: duplicate },
					],
				}),
			).toThrow(/duplicate/i);
		}
	});

	it("rejects unpaired UTF-16 surrogates instead of silently replacing non-UTF-8 content", () => {
		expect(() =>
			parseWorkflowDocsOutput({
				kind: "docs_v1",
				operations: [{ op: "write", path: "docs/a.md", content: "\ud800" }],
			}),
		).toThrow(/utf-8/i);
	});

	it("enforces file count, per-file, and aggregate byte limits", () => {
		const limits = { maxFiles: 2, maxFileBytes: 3, maxTotalBytes: 5 };
		expect(() =>
			parseWorkflowDocsOutput(
				{
					kind: "docs_v1",
					operations: [
						{ op: "delete", path: "docs/a.md" },
						{ op: "delete", path: "docs/b.md" },
						{ op: "delete", path: "docs/c.md" },
					],
				},
				limits,
			),
		).toThrow(/file count/i);

		expect(() =>
			parseWorkflowDocsOutput(
				{
					kind: "docs_v1",
					operations: [{ op: "write", path: "docs/a.md", content: "1234" }],
				},
				limits,
			),
		).toThrow(/per-file/i);

		expect(() =>
			parseWorkflowDocsOutput(
				{
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "docs/a.md", content: "123" },
						{ op: "write", path: "docs/b.md", content: "456" },
					],
				},
				limits,
			),
		).toThrow(/total/i);

		expect(DEFAULT_WORKFLOW_DOCS_LIMITS.maxTotalBytes).toBeLessThanOrEqual(
			262_144,
		);
	});
});
