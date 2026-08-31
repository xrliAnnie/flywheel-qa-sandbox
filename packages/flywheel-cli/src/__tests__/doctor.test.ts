import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { doctor } from "../commands/doctor.js";
import { init } from "../commands/init.js";

const BUNDLED_REGISTRY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
	".flywheel/agents/registry.yaml",
);

describe("flywheel doctor registry preflight", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `fly-doctor-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("errors when config.yaml is missing", async () => {
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors.some((error) => error.includes("Missing"))).toBe(true);
	});

	it("passes both bundled and project registry entries on a fresh init", async () => {
		init({ projectPath: root, depts: ["product"] });
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors).toEqual([]);
		expect(report.info).toContain("Bundled registry preflight passed");
		expect(report.info).toContain("Project registry preflight passed");
	});

	it("rejects the retired agent_file authoring contract", async () => {
		init({ projectPath: root, noDepts: true });
		const configPath = join(root, ".flywheel", "config.yaml");
		writeFileSync(
			configPath,
			readFileSync(configPath, "utf8").replace(
				"node: example",
				"agent_file: .flywheel/agents/nodes/example.md",
			),
		);
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors[0]).toMatch(/migrate-agent-registry/);
	});

	it("fails loud when the project registry is missing", async () => {
		init({ projectPath: root, noDepts: true });
		unlinkSync(join(root, ".flywheel", "agents", "registry.yaml"));
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors.join("\n")).toMatch(/registry\.yaml|ENOENT/i);
	});

	it("fails loud when config references an unregistered node", async () => {
		init({ projectPath: root, noDepts: true });
		const configPath = join(root, ".flywheel", "config.yaml");
		writeFileSync(
			configPath,
			readFileSync(configPath, "utf8").replace("node: example", "node: absent"),
		);
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors.join("\n")).toMatch(/NODE_NOT_REGISTERED.*absent/i);
	});

	it("warns on duplicate aliases after registry resolution", async () => {
		init({ projectPath: root, depts: ["product"] });
		const configPath = join(root, ".flywheel", "config.yaml");
		const config = parse(readFileSync(configPath, "utf8"));
		config.agents.secondary = {
			node: "example",
			match: { labels: ["example"] },
		};
		writeFileSync(configPath, stringify(config));
		const report = await doctor({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		expect(report.errors).toEqual([]);
		expect(report.warnings.join("\n")).toMatch(/example.*multiple agents/i);
	});
});
