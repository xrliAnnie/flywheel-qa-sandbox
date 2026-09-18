import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ReportMetaInput,
	serializeReportDocument,
} from "../contracts/daily-report.js";
import {
	ReportRepoWriter,
	type ReportRepoWriterError,
	type RunReportGh,
	reportRepoPath,
} from "./repo-writer.js";

const date = "2026-09-06";
const roots: string[] = [];
const meta: ReportMetaInput = {
	issue: "FLY-2380",
	date,
	timezone: "America/Los_Angeles",
	generated_at: "2026-09-07T03:00:00.000Z",
	generation_turn_key: `daily-report:${date}:gen:1`,
	main_commit: "a".repeat(40),
	sources: [],
	silent: [],
};
const localDocument = serializeReportDocument(
	meta,
	"## 今天各项目发生了什么\n本地。\n\n## 我的判断\n本地判断。",
);
const remoteDocument = serializeReportDocument(
	{ ...meta, generation_turn_key: `daily-report:${date}:gen:2` },
	"## 今天各项目发生了什么\n远端。\n\n## 我的判断\n远端判断。",
);

function response(status: number, body: unknown): string {
	return `HTTP/2.0 ${status} Fixture\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`;
}

function contentResponse(document: string, fileSha = "b".repeat(40)): string {
	return response(200, {
		sha: fileSha,
		encoding: "base64",
		content: Buffer.from(document, "utf8").toString("base64"),
	});
}

function writer(run: RunReportGh): ReportRepoWriter {
	return new ReportRepoWriter({ ghBin: "/opt/homebrew/bin/gh", run });
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("ReportRepoWriter", () => {
	it("probes an existing report without creating a missing one", async () => {
		const presentRun = vi
			.fn<RunReportGh>()
			.mockResolvedValue(contentResponse(remoteDocument));
		const missingRun = vi
			.fn<RunReportGh>()
			.mockResolvedValue(response(404, { message: "Not Found" }));

		await expect(writer(presentRun).probe(date)).resolves.toMatchObject({
			adopted: true,
		});
		await expect(writer(missingRun).probe(date)).resolves.toBeNull();
		expect(presentRun).toHaveBeenCalledTimes(1);
		expect(missingRun).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed local document before any gh call", async () => {
		const run = vi.fn<RunReportGh>();
		await expect(
			writer(run).createOrAdopt(date, "not-a-report"),
		).rejects.toMatchObject({ category: "document_invalid" });
		expect(run).not.toHaveBeenCalled();
	});

	it("creates exactly one new report without an update sha", async () => {
		const run = vi
			.fn<RunReportGh>()
			.mockResolvedValueOnce(response(404, { message: "Not Found" }))
			.mockResolvedValueOnce(
				response(201, {
					content: { sha: "b".repeat(40) },
					commit: { sha: "c".repeat(40) },
				}),
			);

		const result = await writer(run).createOrAdopt(date, localDocument);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[0]?.[0]).toEqual([
			"api",
			"--include",
			`repos/xrliAnnie/raya/contents/reports/${date}.md?ref=main`,
		]);
		expect(run.mock.calls[1]?.[0]).toEqual([
			"api",
			"--include",
			"--method",
			"PUT",
			`repos/xrliAnnie/raya/contents/reports/${date}.md`,
			"--input",
			"-",
		]);
		const payload = JSON.parse(run.mock.calls[1]?.[1].input ?? "") as Record<
			string,
			unknown
		>;
		expect(payload).toEqual({
			message: `report(raya): ${date}`,
			content: Buffer.from(localDocument, "utf8").toString("base64"),
			branch: "main",
		});
		expect(payload).not.toHaveProperty("sha");
		expect(result).toMatchObject({
			adopted: false,
			fileSha: "b".repeat(40),
			commitSha: "c".repeat(40),
		});
		expect(result.document.body).toContain("本地判断");
	});

	it("adopts an existing valid remote document without PUT", async () => {
		const run = vi
			.fn<RunReportGh>()
			.mockResolvedValue(contentResponse(remoteDocument));

		const result = await writer(run).createOrAdopt(date, localDocument);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.adopted).toBe(true);
		expect(result.commitSha).toBeUndefined();
		expect(result.document.body).toContain("远端判断");
		expect(result.document.body).not.toContain("本地判断");
	});

	it("refuses an existing document whose internal date differs from its path", async () => {
		const wrongDate = "2026-09-05";
		const wrong = serializeReportDocument(
			{
				...meta,
				date: wrongDate,
				generation_turn_key: `daily-report:${wrongDate}:gen:1`,
			},
			"## 今天各项目发生了什么\n旧。\n\n## 我的判断\n旧判断。",
		);
		const run = vi.fn<RunReportGh>().mockResolvedValue(contentResponse(wrong));

		await expect(
			writer(run).createOrAdopt(date, localDocument),
		).rejects.toMatchObject({ category: "adopted_invalid" });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("re-reads and adopts after a 422 create race", async () => {
		const run = vi
			.fn<RunReportGh>()
			.mockResolvedValueOnce(response(404, {}))
			.mockResolvedValueOnce(response(422, { message: "already exists" }))
			.mockResolvedValueOnce(contentResponse(remoteDocument, "d".repeat(40)));

		const result = await writer(run).createOrAdopt(date, localDocument);

		expect(run).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({ adopted: true, fileSha: "d".repeat(40) });
		expect(result.document.body).toContain("远端判断");
	});

	it("fails closed when gh --include does not return an HTTP status line", async () => {
		const run = vi
			.fn<RunReportGh>()
			.mockResolvedValue('{"message":"no headers"}');
		await expect(
			writer(run).createOrAdopt(date, localDocument),
		).rejects.toMatchObject({ category: "gh_shape" });
	});

	it.each(["../2026-09-06", "2026-9-06", "2026-09-06.md"])(
		"rejects report path date %s",
		(value) => {
			expect(() => reportRepoPath(value)).toThrow(/date|path/i);
		},
	);

	it("propagates abort to gh and classifies it", async () => {
		const controller = new AbortController();
		const run = vi.fn<RunReportGh>((_args, options) => {
			return new Promise((_resolve, reject) => {
				options.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		const pending = writer(run).createOrAdopt(
			date,
			localDocument,
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toEqual(
			expect.objectContaining<Partial<ReportRepoWriterError>>({
				category: "aborted",
			}),
		);
		expect(run.mock.calls[0]?.[1].signal).toBe(controller.signal);
	});

	it("rejects buffered output resolved by the host after cancellation", async () => {
		const controller = new AbortController();
		const run: RunReportGh = async () => {
			controller.abort();
			return response(404, { message: "Not Found" });
		};
		await expect(
			writer(run).probe(date, controller.signal),
		).rejects.toMatchObject({
			category: "aborted",
		});
	});

	it("does not accept buffered HTTP output after aborting the injected host runner", async () => {
		const root = mkdtempSync(join(tmpdir(), "raya-report-gh-"));
		roots.push(root);
		const ghBin = join(root, "gh");
		writeFileSync(
			ghBin,
			'#!/bin/sh\nprintf \'HTTP/2.0 404 Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n{"message":"Not Found"}\'\nsleep 10\n',
		);
		chmodSync(ghBin, 0o700);
		const controller = new AbortController();
		const pending = new ReportRepoWriter({
			ghBin,
			run: (args, options) =>
				new Promise((resolve, reject) => {
					const child = execFile(
						ghBin,
						[...args],
						{ encoding: "utf8", signal: options.signal },
						(error, stdout) => {
							const output = String(stdout);
							if (error && !output.startsWith("HTTP/")) reject(error);
							else resolve(output);
						},
					);
					child.stdin?.end(options.input);
				}),
		}).probe(date, controller.signal);

		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();

		await expect(pending).rejects.toMatchObject({ category: "aborted" });
	});
});
