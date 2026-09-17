import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runShipJudgmentHistory } from "../ship-judgment-history.js";

const roots: string[] = [];
const env = {
	TEAMLEAD_API_TOKEN: "fixture",
	BRIDGE_URL: "http://127.0.0.1:9876",
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

it("renders one authenticated local HTML file atomically", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2661-history-"));
	roots.push(root);
	const out = join(root, "history.html");
	const html = "<!doctype html><title>机器试判历史（按需生成）</title>";
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response(html, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			}),
	);
	const log = vi.fn();
	expect(
		await runShipJudgmentHistory(
			["render", "--project", "flywheel", "--out", out],
			{ env, fetchImpl, log },
		),
	).toBe(0);
	expect(readFileSync(out, "utf8")).toBe(html);
	expect(fetchImpl).toHaveBeenCalledOnce();
	const [url, init] = fetchImpl.mock.calls[0]!;
	expect(new URL(String(url)).pathname).toBe(
		"/api/ship-judgment/history/render",
	);
	expect(new URL(String(url)).searchParams.get("project")).toBe("flywheel");
	expect(init).toMatchObject({
		method: "GET",
		redirect: "error",
		headers: { Authorization: "Bearer fixture" },
	});
	expect(init?.signal).toBeInstanceOf(AbortSignal);
	expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
		ok: true,
		command: "render",
		out,
		publish_report_max_bytes: 512 * 1024,
	});
});

it("rejects malformed, duplicate and non-loopback options before fetching", async () => {
	const fetchImpl = vi.fn<typeof fetch>();
	const log = vi.fn();
	for (const args of [
		["render", "--project", "flywheel"],
		["render", "--project", "raya", "--out", "/tmp/x"],
		[
			"render",
			"--project",
			"flywheel",
			"--out",
			"/tmp/x",
			"--bridge-url",
			"https://example.com",
		],
		[
			"render",
			"--project",
			"flywheel",
			"--project",
			"flywheel",
			"--out",
			"/tmp/x",
		],
	]) {
		expect(await runShipJudgmentHistory(args, { env, fetchImpl, log })).toBe(1);
	}
	expect(fetchImpl).not.toHaveBeenCalled();
});

it("times out without replacing an existing target", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2661-history-timeout-"));
	roots.push(root);
	const out = join(root, "history.html");
	writeFileSync(out, "old", "utf8");
	const fetchImpl = vi.fn<typeof fetch>(
		async (_url, init) =>
			await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason ?? new Error("aborted")),
					{ once: true },
				);
			}),
	);
	expect(
		await runShipJudgmentHistory(
			["render", "--project", "flywheel", "--out", out],
			{ env, fetchImpl, timeoutMs: 5, log: vi.fn() },
		),
	).toBe(1);
	expect(readFileSync(out, "utf8")).toBe("old");
});
