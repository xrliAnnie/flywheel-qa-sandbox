import { describe, expect, it, vi } from "vitest";
import { type EpicPageCliDeps, runEpicPage } from "../epic-page.js";

function response(
	body: unknown,
	options: { ok?: boolean; status?: number; contentType?: string } = {},
) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: options.ok ?? true,
		status: options.status ?? 200,
		headers: { get: () => options.contentType ?? "application/json" },
		json: async () => JSON.parse(text) as unknown,
		text: async () => text,
	};
}

function deps(overrides: Partial<EpicPageCliDeps> = {}): EpicPageCliDeps {
	return {
		env: {
			FLYWHEEL_PROJECT_NAME: "example",
			FLYWHEEL_BRIDGE_URL: "http://localhost:9876/",
			TEAMLEAD_API_TOKEN: "master",
		},
		fetchFn: vi.fn(async () => response({ receipt: { version: 1 } })),
		writeFile: vi.fn(),
		log: vi.fn(),
		errorLog: vi.fn(),
		...overrides,
	};
}

describe("flywheel-comm epic-page", () => {
	it("generates the live project scope through the authenticated Bridge", async () => {
		const fetchFn = vi.fn(async () => response({ receipt: { version: 1 } }));
		const input = deps({ fetchFn });
		expect(await runEpicPage(["generate"], input)).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/epic-page/generate",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer master",
				}),
				body: JSON.stringify({ projectName: "example" }),
			}),
		);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toMatchObject({
			ok: true,
			result: { receipt: { version: 1 } },
		});
	});

	it("recomputes JSON and Markdown instead of reading a stored version", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(response({ document: { schema_version: 1 } }))
			.mockResolvedValueOnce(
				response("# Epic", { contentType: "text/markdown" }),
			);
		const input = deps({ fetchFn });
		expect(await runEpicPage(["show", "--format", "json"], input)).toBe(0);
		expect(await runEpicPage(["show", "--format", "md"], input)).toBe(0);
		for (const [index, format] of ["json", "md"].entries()) {
			expect(fetchFn.mock.calls[index]?.[0]).toBe(
				"http://localhost:9876/api/epic-page/generate",
			);
			expect(fetchFn.mock.calls[index]?.[1]).toMatchObject({
				method: "POST",
				body: JSON.stringify({ projectName: "example", format }),
			});
		}
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[1]![0])).toEqual({
			ok: true,
			command: "show",
			markdown: "# Epic",
		});
		expect(input.errorLog).toHaveBeenCalledWith("# Epic");
	});

	it("renders freshly returned HTML verbatim and warns beyond the publish limit", async () => {
		const html = "x".repeat(512 * 1024 + 1);
		const writeFile = vi.fn();
		const fetchFn = vi.fn(async () =>
			response(html, { contentType: "text/html" }),
		);
		const input = deps({
			fetchFn,
			writeFile,
			readFile: vi.fn(() => html),
		});
		expect(
			await runEpicPage(["render", "--out", "/tmp/epic.html"], input),
		).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/epic-page/generate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ projectName: "example", format: "html" }),
			}),
		);
		expect(writeFile).toHaveBeenCalledWith("/tmp/epic.html", html);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("512KB"),
		);
	});

	it("fails if the rendered file cannot be read back byte-for-byte", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response("<main>expected</main>", { contentType: "text/html" }),
			),
			readFile: vi.fn(() => "<main>different</main>"),
		});
		expect(
			await runEpicPage(["render", "--out", "/tmp/epic.html"], input),
		).toBe(1);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error: "write_verification_failed",
		});
	});

	it.each([
		[{}, "missing_project"],
		[{ FLYWHEEL_PROJECT_NAME: "example" }, "missing_token"],
	] as const)("fails closed on missing environment %#", async (env, error) => {
		const input = deps({ env });
		expect(await runEpicPage(["generate"], input)).toBe(1);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error,
		});
		expect(input.fetchFn).not.toHaveBeenCalled();
	});

	it("returns a one-line failure envelope for scope errors", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response(
					{ error: "active_scope_not_found" },
					{ ok: false, status: 422 },
				),
			),
		});
		expect(await runEpicPage(["generate"], input)).toBe(1);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error: "active_scope_not_found",
			status: 422,
		});
	});

	it("rejects removed Epic/version knobs and invalid local options", async () => {
		for (const args of [
			["bogus"],
			["generate", "--epic", "EPX-1"],
			["generate", "--unexpected", "value"],
			["show", "--format", "html"],
			["show", "--version", "2"],
			["render"],
			["render", "--out", "/tmp/x", "--version", "2"],
		]) {
			const input = deps();
			expect(await runEpicPage(args, input)).toBe(1);
			expect(input.fetchFn).not.toHaveBeenCalled();
			expect(input.log).toHaveBeenCalledTimes(1);
		}
	});
});
