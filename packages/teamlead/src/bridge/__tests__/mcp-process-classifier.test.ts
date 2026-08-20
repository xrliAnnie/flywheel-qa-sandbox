import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyMcpProcess,
	classifyMcpSnapshot,
	type McpProcessInput,
} from "../mcp-process-classifier.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const processInput = (
	overrides: Partial<McpProcessInput>,
): McpProcessInput => ({
	pid: 10,
	ppid: 1,
	lstart: "Wed Aug 20 08:00:00 2026",
	comm: "node",
	argv: ["/usr/bin/node", "server.js"],
	...overrides,
});

function packageFixture(options: { wrongTarget?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly1867-classifier-"));
	roots.push(root);
	const modules = join(root, "node_modules");
	const binDir = join(modules, ".bin");
	const packageDir = join(modules, "@playwright", "mcp");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	const cli = join(packageDir, "cli.js");
	writeFileSync(cli, "// fixture\n");
	const bin = join(binDir, "playwright-mcp");
	if (options.wrongTarget) {
		const wrong = join(root, "wrong.js");
		writeFileSync(wrong, "// wrong\n");
		symlinkSync(wrong, bin);
	} else {
		symlinkSync(join("..", "@playwright", "mcp", "cli.js"), bin);
	}
	return { bin, cli };
}

describe("classifyMcpProcess", () => {
	it("matches exact npm and npx package-token positions", () => {
		expect(
			classifyMcpProcess(
				processInput({
					comm: "npm",
					argv: ["/opt/bin/npm", "exec", "@playwright/mcp@latest"],
				}),
			),
		).toMatchObject({ verdict: "match", shape: "npm_wrapper" });
		expect(
			classifyMcpProcess(
				processInput({
					comm: "npx",
					argv: ["/opt/bin/npx", "@playwright/mcp@0.0.79"],
				}),
			),
		).toMatchObject({ verdict: "match", shape: "npx_wrapper" });
	});

	it("does not substring-match wrapper lookalikes or prose", () => {
		expect(
			classifyMcpProcess(
				processInput({
					comm: "npm",
					argv: ["npm", "exec", "@playwright/mcp-extra"],
				}),
			).verdict,
		).toBe("no_match");
		expect(
			classifyMcpProcess(
				processInput({
					argv: ["node", "tool.js", "mentions", "@playwright/mcp@latest"],
				}),
			).verdict,
		).toBe("no_match");
	});

	it("matches a real package-local .bin symlink by lexical and canonical identity", () => {
		const { bin } = packageFixture();
		expect(
			classifyMcpProcess(processInput({ argv: ["/usr/bin/node", bin] })),
		).toMatchObject({ verdict: "match", shape: "inner_bin" });
	});

	it("rejects a .bin symlink whose canonical target is outside the package", () => {
		const { bin } = packageFixture({ wrongTarget: true });
		expect(
			classifyMcpProcess(processInput({ argv: ["/usr/bin/node", bin] })),
		).toMatchObject({ verdict: "no_match", reason: "bin_target_mismatch" });
	});

	it("reports unknown when a lexical inner candidate cannot be inspected", () => {
		const missing = join(
			tmpdir(),
			"fly1867-missing",
			"node_modules",
			".bin",
			"playwright-mcp",
		);
		expect(
			classifyMcpProcess(processInput({ argv: ["/usr/bin/node", missing] })),
		).toMatchObject({ verdict: "unknown", shape: "inner_bin" });
	});

	it("matches the same inner package through its canonical cli.js path", () => {
		const { cli } = packageFixture();
		expect(
			classifyMcpProcess(processInput({ argv: ["/usr/bin/node", cli] })),
		).toMatchObject({ verdict: "match", shape: "inner_cli" });
	});
});

describe("classifyMcpSnapshot", () => {
	it("never collapses an unknown row into clean", () => {
		const missing = join(
			tmpdir(),
			"fly1867-missing",
			"node_modules",
			".bin",
			"playwright-mcp",
		);
		const result = classifyMcpSnapshot([
			processInput({ pid: 20, argv: ["node", "ordinary.js"] }),
			processInput({ pid: 21, argv: ["node", missing] }),
		]);
		expect(result.overall).toBe("unknown");
		expect(result.rows.map((row) => row.verdict)).toEqual([
			"no_match",
			"unknown",
		]);
	});
});
