import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { type RunSummaryGh, SummaryCollector } from "./collector.js";

const date = "2026-09-06";
const mainCommit = "a".repeat(40);
const openHead = "b".repeat(40);
const openBlob = "c".repeat(40);
const mergedBlob = "d".repeat(40);

function summary(project: string, lead: string, end = date): string {
	return [
		"---",
		`project: ${project}`,
		`lead: ${lead}`,
		`period: 2026-09-05T00:00:00-07:00/${end}T16:00:00-07:00`,
		"---",
		"## Facts",
		"- shipped",
		"",
		"## Judgment",
		"- on track",
	].join("\n");
}

function content(document: string, sha: string): string {
	return JSON.stringify({
		sha,
		encoding: "base64",
		content: Buffer.from(document, "utf8").toString("base64"),
	});
}

function singleOpenRun(
	document: string,
	path = "summaries/alpha/2026-09-06--lead-a--01.md",
): RunSummaryGh {
	return vi.fn<RunSummaryGh>(async (args) => {
		const endpoint = args.at(-1);
		if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
			return JSON.stringify({ object: { sha: mainCommit } });
		}
		if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
			return JSON.stringify([
				[{ number: 1, draft: false, base: { ref: "main" } }],
			]);
		}
		if (endpoint === "repos/xrliAnnie/raya/pulls/1") {
			return JSON.stringify({
				number: 1,
				draft: false,
				base: { ref: "main" },
				head: { sha: openHead },
				changed_files: 1,
			});
		}
		if (endpoint === "repos/xrliAnnie/raya/pulls/1/files?per_page=100") {
			return JSON.stringify([[{ filename: path, status: "added" }]]);
		}
		if (
			endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
		) {
			return JSON.stringify({ truncated: false, tree: [] });
		}
		if (endpoint === `repos/xrliAnnie/raya/contents/${path}?ref=${openHead}`) {
			return content(document, openBlob);
		}
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	});
}

describe("SummaryCollector", () => {
	it.each([0, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid PR number %s before constructing another gh request",
		async (invalidPr) => {
			const run = vi.fn<RunSummaryGh>(async (args) => {
				const endpoint = args.at(-1);
				if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
					return JSON.stringify({ object: { sha: mainCommit } });
				}
				if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
					return JSON.stringify([
						[{ number: invalidPr, draft: false, base: { ref: "main" } }],
					]);
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});
			const collector = new SummaryCollector({
				ghBin: "/opt/homebrew/bin/gh",
				maxSummaryBytes: 65_536,
				maxTotalBytes: 524_288,
				run,
			});

			await expect(collector.collect(date)).rejects.toMatchObject({
				category: "gh_shape",
			});
			expect(run).toHaveBeenCalledTimes(2);
		},
	);

	it("flattens paginated PRs and skips a changed_files count above GitHub's cap", async () => {
		const listed = Array.from({ length: 130 }, (_, index) => ({
			number: index + 1,
			draft: index !== 129,
			base: { ref: "main" },
		}));
		let filesCalled = false;
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return JSON.stringify([listed.slice(0, 100), listed.slice(100)]);
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/130") {
				return JSON.stringify({
					number: 130,
					draft: false,
					base: { ref: "main" },
					head: { sha: openHead },
					changed_files: 3_001,
				});
			}
			if (endpoint?.includes("/files?")) {
				filesCalled = true;
				return "[[]]";
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return '{"truncated":false,"tree":[]}';
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const skipped = vi.fn();
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
			onSkipped: skipped,
		});

		const result = await collector.collect(date);

		expect(result.sources).toEqual([]);
		expect(filesCalled).toBe(false);
		expect(skipped).toHaveBeenCalledWith(130, "too_many_files");
		expect(run).toHaveBeenCalledWith(
			[
				"api",
				"--paginate",
				"--slurp",
				"repos/xrliAnnie/raya/pulls?state=open&per_page=100",
			],
			{ signal: undefined },
		);
	});

	it("fails closed when the paginated files count is incomplete", async () => {
		const path = "summaries/alpha/2026-09-06--lead-a--01.md";
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return '[[{"number":1,"draft":false,"base":{"ref":"main"}}]]';
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1") {
				return JSON.stringify({
					number: 1,
					draft: false,
					base: { ref: "main" },
					head: { sha: openHead },
					changed_files: 2,
				});
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1/files?per_page=100") {
				return JSON.stringify([[{ filename: path, status: "added" }]]);
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
		});

		await expect(collector.collect(date)).rejects.toMatchObject({
			category: "gh_shape",
		});
	});

	it("fails on a truncated main tree before fetching any content", async () => {
		const contentsCalled = vi.fn();
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return "[[]]";
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return JSON.stringify({
					truncated: true,
					tree: [
						{
							path: "summaries/alpha/2026-09-06--lead-a--01.md",
							type: "blob",
							sha: openBlob,
						},
					],
				});
			}
			if (endpoint?.includes("/contents/")) contentsCalled();
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
		});

		await expect(collector.collect(date)).rejects.toMatchObject({
			category: "gh_tree_truncated",
		});
		expect(contentsCalled).not.toHaveBeenCalled();
	});

	it("propagates abort to the active gh call", async () => {
		const abort = new AbortController();
		const run = vi.fn<RunSummaryGh>((_args, options) => {
			return new Promise((_resolve, reject) => {
				options.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
		});
		const pending = collector.collect(date, abort.signal);

		abort.abort();

		await expect(pending).rejects.toMatchObject({ category: "aborted" });
		expect(run.mock.calls[0]?.[1].signal).toBe(abort.signal);
	});

	it.each([
		["frontmatter_missing", "not frontmatter\n## Facts\n## Judgment"],
		["project_mismatch", summary("wrong-project", "lead-a")],
		["lead_mismatch", summary("alpha", "wrong-lead")],
		[
			"period_unparseable",
			summary("alpha", "lead-a").replace(
				"2026-09-05T00:00:00-07:00/2026-09-06T16:00:00-07:00",
				"not-an-interval",
			),
		],
		["period_mismatch", summary("alpha", "lead-a", "2026-09-05")],
		[
			"facts_missing",
			summary("alpha", "lead-a").replace("## Facts", "## Events"),
		],
		[
			"judgment_missing",
			summary("alpha", "lead-a").replace("## Judgment", "## Notes"),
		],
	])("keeps a summary with invalid:%s provenance", async (reason, document) => {
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run: singleOpenRun(document),
		});

		const result = await collector.collect(date);

		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.contract).toBe(`invalid:${reason}`);
	});

	it("accepts date-only period endpoints", async () => {
		const document = summary("alpha", "lead-a").replace(
			"2026-09-05T00:00:00-07:00/2026-09-06T16:00:00-07:00",
			"2026-09-05/2026-09-06",
		);
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run: singleOpenRun(document),
		});

		const result = await collector.collect(date);

		expect(result.sources[0]?.contract).toBe("ok");
	});

	it("retries a moving PR head once and pins the stable second head", async () => {
		const path = "summaries/alpha/2026-09-06--lead-a--01.md";
		const firstHead = "1".repeat(40);
		const stableHead = "2".repeat(40);
		const detailHeads = [firstHead, stableHead, stableHead, stableHead];
		let detailIndex = 0;
		let filesCalls = 0;
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return '[[{"number":1,"draft":false,"base":{"ref":"main"}}]]';
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1") {
				return JSON.stringify({
					number: 1,
					draft: false,
					base: { ref: "main" },
					head: { sha: detailHeads[detailIndex++] },
					changed_files: 1,
				});
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1/files?per_page=100") {
				filesCalls += 1;
				return JSON.stringify([[{ filename: path, status: "modified" }]]);
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return '{"truncated":false,"tree":[]}';
			}
			if (
				endpoint === `repos/xrliAnnie/raya/contents/${path}?ref=${stableHead}`
			) {
				return content(summary("alpha", "lead-a"), openBlob);
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
		});

		const result = await collector.collect(date);

		expect(result.sources[0]?.head).toBe(stableHead);
		expect(filesCalls).toBe(2);
		expect(detailIndex).toBe(4);
	});

	it("skips a head that moves during both stability attempts", async () => {
		const heads = ["1", "2", "3", "4"].map((value) => value.repeat(40));
		let detailIndex = 0;
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return '[[{"number":1,"draft":false,"base":{"ref":"main"}}]]';
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1") {
				return JSON.stringify({
					number: 1,
					draft: false,
					base: { ref: "main" },
					head: { sha: heads[detailIndex++] },
					changed_files: 1,
				});
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls/1/files?per_page=100") {
				return '[[{"filename":"summaries/alpha/2026-09-06--lead-a--01.md","status":"added"}]]';
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return '{"truncated":false,"tree":[]}';
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const skipped = vi.fn();
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
			onSkipped: skipped,
		});

		const result = await collector.collect(date);

		expect(result.sources).toEqual([]);
		expect(skipped).toHaveBeenCalledWith(1, "head_moved");
	});

	it("deduplicates equal blobs and marks divergent versions", async () => {
		const path = "summaries/alpha/2026-09-06--lead-a--01.md";
		const headOne = "1".repeat(40);
		const headTwo = "2".repeat(40);
		const sameBlob = "3".repeat(40);
		const otherBlob = "4".repeat(40);
		const callsByPr = new Map<number, number>();
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1) ?? "";
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return '[[{"number":1,"draft":false,"base":{"ref":"main"}},{"number":2,"draft":false,"base":{"ref":"main"}}]]';
			}
			const detail = /pulls\/(\d+)$/.exec(endpoint);
			if (detail) {
				const pr = Number(detail[1]);
				callsByPr.set(pr, (callsByPr.get(pr) ?? 0) + 1);
				return JSON.stringify({
					number: pr,
					draft: false,
					base: { ref: "main" },
					head: { sha: pr === 1 ? headOne : headTwo },
					changed_files: 1,
				});
			}
			if (/pulls\/\d+\/files\?per_page=100$/.test(endpoint)) {
				return JSON.stringify([[{ filename: path, status: "added" }]]);
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return JSON.stringify({
					truncated: false,
					tree: [{ path, type: "blob", sha: sameBlob }],
				});
			}
			if (
				endpoint === `repos/xrliAnnie/raya/contents/${path}?ref=${headOne}` ||
				endpoint === `repos/xrliAnnie/raya/contents/${path}?ref=${mainCommit}`
			) {
				return content(summary("alpha", "lead-a"), sameBlob);
			}
			if (endpoint === `repos/xrliAnnie/raya/contents/${path}?ref=${headTwo}`) {
				return content(`${summary("alpha", "lead-a")}\nchanged`, otherBlob);
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
		});

		const result = await collector.collect(date);

		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]).toMatchObject({
			state: "merged",
			blob: sameBlob,
			divergent: true,
			also_in: [`open#1@${headOne}`],
		});
		expect(result.sources[1]).toMatchObject({
			state: "open",
			pr: 2,
			blob: otherBlob,
			divergent: true,
			also_in: [],
		});
	});

	it("omits every later source after the total material budget is exhausted", async () => {
		const alphaPath = "summaries/alpha/2026-09-06--lead-a--01.md";
		const betaPath = "summaries/beta/2026-09-06--lead-b--01.md";
		const alpha = `${summary("alpha", "lead-a")}\n${"x".repeat(200)}`;
		const beta = summary("beta", "lead-b");
		const run = vi.fn<RunSummaryGh>(async (args) => {
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return "[[]]";
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return JSON.stringify({
					truncated: false,
					tree: [
						{ path: alphaPath, type: "blob", sha: "1".repeat(40) },
						{ path: betaPath, type: "blob", sha: "2".repeat(40) },
					],
				});
			}
			if (
				endpoint ===
				`repos/xrliAnnie/raya/contents/${alphaPath}?ref=${mainCommit}`
			) {
				return content(alpha, "1".repeat(40));
			}
			if (
				endpoint ===
				`repos/xrliAnnie/raya/contents/${betaPath}?ref=${mainCommit}`
			) {
				return content(beta, "2".repeat(40));
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: Buffer.byteLength(alpha, "utf8") - 1,
			run,
		});

		const result = await collector.collect(date);

		expect(
			result.sources.map(({ omitted, content }) => ({ omitted, content })),
		).toEqual([
			{ omitted: true, content: "" },
			{ omitted: true, content: "" },
		]);
	});

	it("rejects a normalized-but-invalid calendar day in the summary period", async () => {
		const document = summary("alpha", "lead-a").replace(
			"2026-09-05T00:00:00-07:00",
			"2026-02-31",
		);
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run: singleOpenRun(document),
		});

		const result = await collector.collect(date);

		expect(result.sources[0]?.contract).toBe("invalid:period_unparseable");
	});

	it("truncates on a UTF-8 boundary without exceeding the byte budget", async () => {
		const prefix = summary("alpha", "lead-a");
		const document = `${prefix}\n🙂tail`;
		const maxSummaryBytes = Buffer.byteLength(`${prefix}\n`, "utf8") + 1;
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes,
			maxTotalBytes: 524_288,
			run: singleOpenRun(document),
		});

		const result = await collector.collect(date);

		expect(result.sources[0]?.truncated).toBe(true);
		expect(
			Buffer.byteLength(result.sources[0]?.content ?? "", "utf8"),
		).toBeLessThanOrEqual(maxSummaryBytes);
		expect(result.sources[0]?.content).not.toContain("�");
	});

	it("pins one main snapshot, filters whole PRs, and reports silent projects", async () => {
		const todayOpen = "summaries/alpha/2026-09-06--lead-a--01.md";
		const oldOpen = "summaries/old-open/2026-09-05--lead-old--01.md";
		const todayMerged = "summaries/beta/2026-09-06--lead-b--01.md";
		const oldMerged = "summaries/quiet/2026-09-04--lead-q--01.md";
		const calls: string[][] = [];
		const run = vi.fn<RunSummaryGh>(async (args) => {
			calls.push([...args]);
			const endpoint = args.at(-1);
			if (endpoint === "repos/xrliAnnie/raya/git/ref/heads/main") {
				return JSON.stringify({ object: { sha: mainCommit } });
			}
			if (endpoint === "repos/xrliAnnie/raya/pulls?state=open&per_page=100") {
				return JSON.stringify([
					[
						{ number: 1, draft: false, base: { ref: "main" } },
						{ number: 2, draft: true, base: { ref: "main" } },
						{ number: 3, draft: false, base: { ref: "feature" } },
						{ number: 4, draft: false, base: { ref: "main" } },
						{ number: 5, draft: false, base: { ref: "main" } },
					],
				]);
			}
			const prMatch = /pulls\/(\d+)$/.exec(endpoint ?? "");
			if (prMatch) {
				const number = Number(prMatch[1]);
				return JSON.stringify({
					number,
					draft: false,
					base: { ref: "main" },
					head: {
						sha: number === 1 || number === 5 ? openHead : "e".repeat(40),
					},
					changed_files: 1,
				});
			}
			const filesMatch = /pulls\/(\d+)\/files\?per_page=100$/.exec(
				endpoint ?? "",
			);
			if (filesMatch) {
				const number = Number(filesMatch[1]);
				const file =
					number === 1
						? { filename: todayOpen, status: "added" }
						: number === 4
							? { filename: "scripts/not-a-summary.ts", status: "added" }
							: { filename: oldOpen, status: "modified" };
				return JSON.stringify([[file]]);
			}
			if (
				endpoint === `repos/xrliAnnie/raya/git/trees/${mainCommit}?recursive=1`
			) {
				return JSON.stringify({
					truncated: false,
					tree: [
						{ path: todayMerged, type: "blob", sha: mergedBlob },
						{ path: oldMerged, type: "blob", sha: "f".repeat(40) },
						{ path: "summaries/README.md", type: "blob", sha: "1".repeat(40) },
					],
				});
			}
			if (
				endpoint ===
				`repos/xrliAnnie/raya/contents/${todayOpen}?ref=${openHead}`
			) {
				return content(summary("alpha", "lead-a"), openBlob);
			}
			if (
				endpoint ===
				`repos/xrliAnnie/raya/contents/${todayMerged}?ref=${mainCommit}`
			) {
				return content(summary("beta", "lead-b"), mergedBlob);
			}
			throw new Error(`unexpected gh call: ${args.join(" ")}`);
		});
		const skipped = vi.fn();
		const collector = new SummaryCollector({
			ghBin: "/opt/homebrew/bin/gh",
			maxSummaryBytes: 65_536,
			maxTotalBytes: 524_288,
			run,
			onSkipped: skipped,
		});

		const result = await collector.collect(date);

		expect(result.mainCommit).toBe(mainCommit);
		expect(result.sources.map((item) => item.path)).toEqual([
			todayOpen,
			todayMerged,
		]);
		expect(result.sources[0]).toMatchObject({
			state: "open",
			pr: 1,
			head: openHead,
			blob: openBlob,
			project: "alpha",
			lead: "lead-a",
			contract: "ok",
			content: summary("alpha", "lead-a"),
		});
		expect(result.sources[1]).toMatchObject({
			state: "merged",
			head: mainCommit,
			blob: mergedBlob,
			contract: "ok",
		});
		expect(result.silent).toEqual([
			{ project: "old-open", last_summary: "2026-09-05" },
			{ project: "quiet", last_summary: "2026-09-04" },
		]);
		expect(skipped).toHaveBeenCalledWith(4, "ineligible_files");
		expect(calls).not.toContainEqual(
			expect.arrayContaining([expect.stringContaining("pulls/2")]),
		);
		expect(calls).not.toContainEqual(
			expect.arrayContaining([expect.stringContaining("pulls/3")]),
		);
		for (const call of calls.filter((args) =>
			args.at(-1)?.includes("/contents/"),
		)) {
			expect(call.at(-1)).not.toMatch(/\?ref=main$/);
		}
	});
});
