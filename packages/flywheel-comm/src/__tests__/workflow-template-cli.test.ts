import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowTemplate } from "../commands/workflow-template.js";

function fixture(failApply = false) {
	const events: string[] = [];
	const bodies: unknown[] = [];
	const deps = {
		env: {},
		log: (line: string) => events.push(`log:${line}`),
		error: (line: string) => events.push(`error:${line}`),
		fetch: async (url: string, init: RequestInit) => {
			events.push(url.endsWith("stage") ? "stage" : "apply");
			bodies.push(init.body && JSON.parse(String(init.body)));
			if (failApply && url.endsWith("apply")) throw new Error("response lost");
			return new Response(
				JSON.stringify(
					url.endsWith("stage")
						? {
								canonical: {
									operationId: "12345678-1234-1234-1234-123456789abc",
								},
								requestDigest: "a".repeat(64),
								confirmToken: "test-token",
							}
						: { published_revision: 2 },
				),
				{ status: 200 },
			);
		},
	};
	return { deps, events, bodies };
}
describe("workflow-template CLI", () => {
	it("sends file contents, never the local path, and rejects oversized files before network", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2606-cli-"));
		try {
			const path = join(root, "candidate.json");
			const candidate = { schema_version: 3, nodes: [] };
			writeFileSync(path, JSON.stringify(candidate));
			const { deps, bodies } = fixture();
			const args = [
				"publish",
				"--template",
				"tpl_simple_code",
				"--from",
				"file",
				"--file",
				path,
				"--reason",
				"reviewed",
			];
			expect(await runWorkflowTemplate(args, deps)).toBe(0);
			expect(bodies[0]).toMatchObject({ from: "file", manifest: candidate });
			expect(JSON.stringify(bodies)).not.toContain(path);
			writeFileSync(path, " ".repeat(512 * 1024 + 1));
			const retry = fixture();
			expect(await runWorkflowTemplate(args, retry.deps)).toBe(1);
			expect(retry.bodies).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("reads operation status with same-origin GET without publishing", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const result = await runWorkflowTemplate(
			["status", "--operation-id", "12345678-1234-1234-1234-123456789abc"],
			{
				env: {},
				log: () => {},
				error: () => {},
				fetch: async (url, init) => {
					calls.push({ url, init });
					return new Response("{}");
				},
			},
		);
		expect(result).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/api/workflow/publications/");
		expect(calls[0]?.init).toMatchObject({
			method: "GET",
			headers: { Origin: "http://localhost:9876" },
		});
	});
	it("prints recovery identity before apply and forwards exactly the staged payload", async () => {
		const { deps, events, bodies } = fixture();
		expect(
			await runWorkflowTemplate(
				[
					"publish",
					"--template",
					"tpl_simple_code",
					"--from",
					"seed",
					"--reason",
					"reviewed",
				],
				deps,
			),
		).toBe(0);
		expect(events[0]).toBe("stage");
		expect(events[1]).toContain("12345678-1234-1234-1234-123456789abc");
		expect(events[1]).not.toContain("test-token");
		expect(events[2]).toBe("apply");
		expect(bodies[1]).toMatchObject({
			confirmToken: "test-token",
			requestDigest: "a".repeat(64),
		});
	});
	it("does not retry or rebase a lost apply response", async () => {
		const { deps, events } = fixture(true);
		expect(
			await runWorkflowTemplate(
				[
					"publish",
					"--template",
					"tpl_simple_code",
					"--from",
					"seed",
					"--reason",
					"reviewed",
				],
				deps,
			),
		).toBe(1);
		expect(events.filter((e) => e === "stage")).toHaveLength(1);
		expect(events.filter((e) => e === "apply")).toHaveLength(1);
		expect(events.at(-1)).toContain("status --operation-id");
	});
	it.each([
		["--actor", "founder"],
		["--reason", "duplicate"],
		["--expected-revision", "1"],
		["--bridge-url", "https://remote.example"],
	])("rejects invalid options before network %j", async (...extra) => {
		const { deps, events } = fixture();
		expect(
			await runWorkflowTemplate(
				[
					"publish",
					"--template",
					"tpl_simple_code",
					"--from",
					"seed",
					"--reason",
					"reviewed",
					...extra,
				],
				deps,
			),
		).toBe(1);
		expect(events.filter((e) => e === "stage")).toHaveLength(0);
	});
	it("requests rollback as a new staged publication", async () => {
		const { deps, bodies } = fixture();
		expect(
			await runWorkflowTemplate(
				[
					"rollback",
					"--template",
					"tpl_simple_code",
					"--revision",
					"1",
					"--reason",
					"restore",
				],
				deps,
			),
		).toBe(0);
		expect(bodies[0]).toMatchObject({ from: "rollback", revision: 1 });
	});
});
