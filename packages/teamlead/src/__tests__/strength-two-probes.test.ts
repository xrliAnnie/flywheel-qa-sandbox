import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildProbeDetail,
	classifyRecordUrl,
	probeRecord,
	probeRecordLiveness,
	probeSite,
	RECORD_BODY_MAX_BYTES,
	SITE_BODY_MAX_BYTES,
	type StrengthTwoExecFile,
} from "../bridge/strength-two-probes.js";

const HEAD = "a".repeat(40);
const TOKEN = "b".repeat(32);
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const HTML = "<!doctype html><html><head></head><body>proof</body></html>";

const dirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function slotsFile(bridgePort: number | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), "strength-two-slots-"));
	dirs.push(dir);
	const path = join(dir, "slots.json");
	writeFileSync(
		path,
		JSON.stringify({
			slots: bridgePort === undefined ? [] : [{ id: 1, bridgePort }],
		}),
	);
	return path;
}

function health(overrides: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			ok: true,
			shuttingDown: false,
			buildMode: "built",
			buildSha: HEAD,
			artifactBuildSha: HEAD,
			...overrides,
		}),
		{ status: Number(overrides.status ?? 200) },
	);
}

function registry(overrides: Record<string, unknown> = {}) {
	return {
		list: () => [
			{
				token: TOKEN,
				projectName: "flywheel",
				createdAt: "2026-09-06T11:00:00.000Z",
				bytes: Buffer.byteLength(HTML),
			},
		],
		readReportHtml: () => HTML,
		...overrides,
	};
}

describe("probeSite", () => {
	it("rejects an unresolved slot and a self port without fetching", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		expect(
			await probeSite({
				slot: 1,
				selfPort: 29999,
				slotsFilePath: slotsFile(undefined),
				fetchImpl,
			}),
		).toMatchObject({ ok: false, reason: "port_unresolved" });
		expect(
			await probeSite({
				slot: 1,
				selfPort: 29999,
				slotsFilePath: slotsFile(29999),
				fetchImpl,
			}),
		).toMatchObject({ ok: false, reason: "port_is_self" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("constructs success only from a complete built health payload", async () => {
		const result = await probeSite({
			slot: 1,
			selfPort: 30000,
			slotsFilePath: slotsFile(29999),
			fetchImpl: vi.fn(async () => health()),
		});
		expect(result).toEqual({
			ok: true,
			httpStatus: 200,
			healthOk: true,
			shuttingDown: false,
			buildMode: "built",
			buildSha: HEAD,
			artifactBuildSha: HEAD,
			validated: "site_probe",
		});
	});

	it.each([
		[500, {}, "not_ready"],
		[200, { ok: false }, "not_ready"],
		[200, { buildMode: "source" }, "not_ready"],
		[200, { shuttingDown: true }, "not_ready"],
		[200, { buildSha: HEAD.toUpperCase() }, "bad_payload"],
	])(
		"classifies HTTP %s payload %o as %s",
		async (status, overrides, reason) => {
			const result = await probeSite({
				slot: 1,
				selfPort: 30000,
				slotsFilePath: slotsFile(29999),
				fetchImpl: vi.fn(async () => health({ ...overrides, status })),
			});
			expect(result).toMatchObject({ ok: false, reason, httpStatus: status });
		},
	);

	it("cancels an over-cap response body", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(SITE_BODY_MAX_BYTES + 1));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200 },
		);
		const result = await probeSite({
			slot: 1,
			selfPort: 30000,
			slotsFilePath: slotsFile(29999),
			fetchImpl: vi.fn(async () => response),
		});
		expect(result).toMatchObject({ ok: false, reason: "bad_payload" });
		expect(cancelled).toBe(true);
	});

	it("cancels a continuous response stream at the deadline", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([123]));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200 },
		);
		const pending = probeSite({
			slot: 1,
			selfPort: 30000,
			slotsFilePath: slotsFile(29999),
			fetchImpl: vi.fn(async () => response),
			timeoutMs: 10,
		});
		await vi.advanceTimersByTimeAsync(11);
		expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
		expect(cancelled).toBe(true);
	});

	it("turns injected fetch and malformed JSON failures into outcomes", async () => {
		const common = {
			slot: 1,
			selfPort: 30000,
			slotsFilePath: slotsFile(29999),
		};
		expect(
			await probeSite({
				...common,
				fetchImpl: vi.fn(async () => {
					throw new Error("socket token=secret");
				}),
			}),
		).toMatchObject({ ok: false, reason: "unreachable" });
		expect(
			await probeSite({
				...common,
				fetchImpl: vi.fn(async () => new Response("not-json")),
			}),
		).toMatchObject({ ok: false, reason: "bad_payload" });
	});
});

describe("record URL classification", () => {
	it("accepts only exact hosted and GitHub comment URLs", () => {
		expect(
			classifyRecordUrl(`https://fw-reports-test.vercel.app/r/${TOKEN}/`, {
				vercelProjectName: "fw-reports-test",
			}),
		).toEqual({ kind: "hosted_report", token: TOKEN });
		expect(
			classifyRecordUrl(`http://127.0.0.1:3000/fw-reports-test/r/${TOKEN}/`, {
				vercelProjectName: "fw-reports-test",
				hostOverride: { publicBaseUrl: "http://127.0.0.1:3000" },
			}),
		).toEqual({ kind: "hosted_report", token: TOKEN });
		expect(
			classifyRecordUrl(
				"https://github.com/openai/flywheel/issues/7#issuecomment-123",
				{},
			),
		).toEqual({
			kind: "github_comment",
			owner: "openai",
			repo: "flywheel",
			issue: "7",
			commentId: "123",
		});
		for (const url of [
			`https://evil.example/r/${TOKEN}/`,
			`https://fw-reports-test.vercel.app/r/${TOKEN}`,
			`https://fw-reports-test.vercel.app/r/${TOKEN}/?x=1`,
			"https://github.com/openai/flywheel/issues/7",
			"https://github.com/openai/flywheel/issues/7#issuecomment-456?x=1",
		]) {
			expect(
				classifyRecordUrl(url, { vercelProjectName: "fw-reports-test" }),
			).toEqual({
				kind: "unsupported",
			});
		}
	});
});

describe("probeRecord hosted reports", () => {
	const url = `https://fw-reports-test.vercel.app/r/${TOKEN}/`;
	const common = {
		url,
		registry: registry(),
		vercelProjectName: "fw-reports-test",
		now: () => NOW,
	};

	it("requires a live registry entry and exact hardened bytes", async () => {
		const ok = await probeRecord({
			...common,
			fetchImpl: vi.fn(async () => new Response(HTML, { status: 200 })),
		});
		expect(ok).toEqual({
			kind: "hosted_report",
			outcome: "ok",
			evidence: {
				httpStatus: 200,
				digest: createHash("sha256").update(HTML).digest("hex"),
				bytes: Buffer.byteLength(HTML),
			},
		});

		expect(
			await probeRecord({
				...common,
				registry: registry({ list: () => [] }),
				fetchImpl: vi.fn(),
			}),
		).toMatchObject({ kind: "hosted_report", outcome: "not_in_registry" });
		expect(
			await probeRecord({
				...common,
				registry: registry({
					list: () => [
						{
							token: TOKEN,
							projectName: "flywheel",
							createdAt: "2026-08-01T00:00:00.000Z",
							bytes: 1,
						},
					],
				}),
				fetchImpl: vi.fn(),
			}),
		).toMatchObject({ kind: "hosted_report", outcome: "expired" });
	});

	it.each([
		[302, "redirect", "http_error"],
		[204, "", "http_error"],
		[200, `${HTML.slice(0, -1)}!`, "digest_mismatch"],
	])("maps status %s and body %s to %s", async (status, body, outcome) => {
		const result = await probeRecord({
			...common,
			fetchImpl: vi.fn(
				async () => new Response(status === 204 ? null : body, { status }),
			),
		});
		expect(result).toMatchObject({ kind: "hosted_report", outcome });
	});

	it("cancels a response over one MiB", async () => {
		let cancelled = false;
		const result = await probeRecord({
			...common,
			maxBodyBytes: RECORD_BODY_MAX_BYTES,
			fetchImpl: vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(RECORD_BODY_MAX_BYTES + 1));
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
			),
		});
		expect(result).toMatchObject({
			kind: "hosted_report",
			outcome: "body_too_large",
		});
		expect(cancelled).toBe(true);
	});

	it("propagates registry invariant failures but contains fetch failures", async () => {
		await expect(
			probeRecord({
				...common,
				registry: registry({
					list: () => {
						throw new Error("corrupt registry");
					},
				}),
				fetchImpl: vi.fn(),
			}),
		).rejects.toThrow("corrupt registry");
		expect(
			await probeRecord({
				...common,
				fetchImpl: vi.fn(async () => {
					throw new Error("ECONNREFUSED");
				}),
			}),
		).toMatchObject({ kind: "hosted_report", outcome: "unreachable" });
	});
});

describe("probeRecord GitHub comments", () => {
	const url = "https://github.com/openai/flywheel/issues/7#issuecomment-123";
	const common = { url, registry: registry(), now: () => NOW };

	it("accepts PR conversation comments and validates their returned URL", async () => {
		const pullUrl =
			"https://github.com/openai/flywheel/pull/7#issuecomment-123";
		const execFileImpl = vi.fn<StrengthTwoExecFile>(async () => ({
			stdout: JSON.stringify({ body: "proof body", html_url: pullUrl }),
			stderr: "",
		}));

		expect(
			await probeRecord({ ...common, url: pullUrl, execFileImpl }),
		).toMatchObject({ kind: "github_comment", outcome: "ok" });
		expect(execFileImpl).toHaveBeenCalledWith(
			"gh",
			["api", "repos/openai/flywheel/issues/comments/123"],
			expect.any(Object),
		);
	});

	it("uses gh api and hashes the externally returned comment body", async () => {
		const execFileImpl = vi.fn<StrengthTwoExecFile>(async () => ({
			stdout: JSON.stringify({ body: "proof body", html_url: url }),
			stderr: "",
		}));
		const result = await probeRecord({ ...common, execFileImpl });
		expect(execFileImpl).toHaveBeenCalledWith(
			"gh",
			["api", "repos/openai/flywheel/issues/comments/123"],
			expect.objectContaining({ maxBuffer: RECORD_BODY_MAX_BYTES }),
		);
		expect(result).toEqual({
			kind: "github_comment",
			outcome: "ok",
			evidence: {
				httpStatus: 200,
				digest: createHash("sha256").update("proof body").digest("hex"),
				bytes: 10,
			},
		});
	});

	it.each([
		[{ stdout: "not-json", stderr: "" }, "bad_payload"],
		[
			{ stdout: JSON.stringify({ body: "", html_url: url }), stderr: "" },
			"bad_payload",
		],
		[
			{
				stdout: JSON.stringify({
					body: "proof",
					html_url:
						"https://github.com/openai/flywheel/issues/8#issuecomment-123",
				}),
				stderr: "",
			},
			"url_mismatch",
		],
	])("maps response %o to %s", async (execution, outcome) => {
		const result = await probeRecord({
			...common,
			execFileImpl: vi.fn<StrengthTwoExecFile>(async () => execution),
		});
		expect(result).toMatchObject({ kind: "github_comment", outcome });
	});

	it.each([
		[Object.assign(new Error("HTTP 404"), { stderr: "HTTP 404" }), "not_found"],
		[Object.assign(new Error("HTTP 403"), { stderr: "HTTP 403" }), "forbidden"],
		[
			Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
			"unreachable",
		],
		[
			Object.assign(new Error("maxBuffer exceeded"), {
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
			}),
			"bad_payload",
		],
	])("contains gh error %o as %s", async (error, outcome) => {
		const result = await probeRecord({
			...common,
			execFileImpl: vi.fn<StrengthTwoExecFile>(async () => {
				throw error;
			}),
		});
		expect(result).toMatchObject({ kind: "github_comment", outcome });
	});

	it("does not mistake the comment id in an exec error for an HTTP status", async () => {
		const result = await probeRecord({
			...common,
			url: "https://github.com/openai/flywheel/issues/7#issuecomment-404",
			execFileImpl: vi.fn<StrengthTwoExecFile>(async () => {
				throw Object.assign(
					new Error(
						"Command failed: gh api repos/openai/flywheel/issues/comments/404",
					),
					{ stderr: "network unavailable" },
				);
			}),
		});
		expect(result).toMatchObject({
			kind: "github_comment",
			outcome: "unreachable",
		});
	});
});

describe("probe detail", () => {
	it("is redacted, single-line, and bounded by bytes", () => {
		const detail = buildProbeDetail({
			site: { detail: `Bearer abc\n${"界".repeat(5_000)}` },
			record: { detail: "ghp_supersecret token=also-secret credential=hidden" },
		});
		expect(detail).not.toMatch(/abc|ghp_supersecret|also-secret|hidden/);
		expect(detail).not.toContain("\n");
		expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(4096);
		expect(() => JSON.parse(detail)).not.toThrow();
	});

	it("remains bounded after quote-heavy nested values are serialized", () => {
		const detail = buildProbeDetail({
			site: {
				raw: Array.from({ length: 256 }, () => '"\\'.repeat(256)),
			},
		});
		expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(4096);
		expect(() => JSON.parse(detail)).not.toThrow();
	});
});

describe("probeRecordLiveness", () => {
	const hostedUrl = `https://fw-reports-test.vercel.app/r/${TOKEN}/`;
	const digest = createHash("sha256").update(HTML).digest("hex");
	const row = {
		record_status: "satisfied" as const,
		record_url: hostedUrl,
		record_url_kind: "hosted_report" as const,
		record_digest: digest,
	};

	it("does not probe an originally unsatisfied record", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		expect(
			await probeRecordLiveness(
				{ ...row, record_status: "unsatisfied" },
				{
					registry: registry(),
					vercelProjectName: "fw-reports-test",
					fetchImpl,
				},
			),
		).toBe("unsatisfied");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reports hosted content live only while its digest still matches", async () => {
		expect(
			await probeRecordLiveness(row, {
				registry: registry(),
				vercelProjectName: "fw-reports-test",
				now: () => NOW,
				fetchImpl: vi.fn(async () => new Response(HTML)),
			}),
		).toBe("live");
		expect(
			await probeRecordLiveness(row, {
				registry: registry(),
				vercelProjectName: "fw-reports-test",
				now: () => NOW,
				fetchImpl: vi.fn(async () => new Response(`${HTML}!`)),
			}),
		).toBe("verified_then_expired");
	});

	it("reports GitHub comments live only while the external body still matches", async () => {
		const recordUrl =
			"https://github.com/openai/flywheel/issues/7#issuecomment-123";
		const githubRow = {
			record_status: "satisfied" as const,
			record_url: recordUrl,
			record_url_kind: "github_comment" as const,
			record_digest: createHash("sha256").update("proof").digest("hex"),
		};
		expect(
			await probeRecordLiveness(githubRow, {
				registry: registry(),
				execFileImpl: vi.fn<StrengthTwoExecFile>(async () => ({
					stdout: JSON.stringify({ body: "proof", html_url: recordUrl }),
					stderr: "",
				})),
			}),
		).toBe("live");
		expect(
			await probeRecordLiveness(githubRow, {
				registry: registry(),
				execFileImpl: vi.fn<StrengthTwoExecFile>(async () => ({
					stdout: JSON.stringify({ body: "edited", html_url: recordUrl }),
					stderr: "",
				})),
			}),
		).toBe("verified_then_expired");
	});
});
