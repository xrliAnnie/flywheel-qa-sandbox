/**
 * FLY-1344 独立 QA (three-stage QA phase) — founder 「开/关 DAG」点击闭环的端到端集成。
 *
 * 三个 FLY-1344 组件之间的缝在既有测试里各测各的:
 *   - flag-toggle.test.ts        → applyFlagToggle 事务 + resolveFlag 分歧愈合(停在 resolver)
 *   - dag-flag-panel.test.ts     → buildDagFlagPanel 的安全序列(用合成 FlagView)
 *   - feature-flags-resolve.test → resolveFlag 双源 divergence
 *
 * 本文件把它们串成 founder 真实操作链:REAL applyFlagToggle(内存 .env)→ REAL
 * resolveAllFlags → REAL buildDagFlagPanel,逐条执行面板生成的安全序列,断言每一步
 * 的安全不变量与派生事实,证明「一句话开/关 DAG」在整条管线上真的成立(热、零重启、
 * ship reader 全程安全)。纯内存,绝不触碰真实 ~/.flywheel/.env。
 */

import { FEATURE_FLAGS, type FlagView, resolveAllFlags } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	buildDagFlagPanel,
	type DagControlName,
} from "../bridge/dag-flag-panel.js";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import { applyFlagToggle } from "../bridge/flag-toggle.js";

const LEVERS: DagControlName[] = [
	"workflow_claims_write",
	"workflow_claims_read",
	"workflow_generalized_templates",
	"workflow_template_dispatch",
];

/** name → its FLYWHEEL_* env var (from the real registry). */
const ENV_VAR = new Map(
	LEVERS.map((name) => {
		const spec = FEATURE_FLAGS.find((f) => f.name === name);
		if (!spec?.envVar) throw new Error(`no envVar for ${name}`);
		return [name, spec.envVar];
	}),
);

/** A tiny in-memory shared-.env world the founder's Lead would apply against. */
class EnvWorld {
	content: string;
	readonly env: Record<string, string | undefined> = {};

	constructor(initial: Record<DagControlName, boolean>) {
		const lines: string[] = ["# hermetic QA world"];
		for (const name of LEVERS) {
			const raw = initial[name] ? "1" : "0";
			this.env[ENV_VAR.get(name)!] = raw;
			lines.push(`${ENV_VAR.get(name)!}=${raw}`);
		}
		this.content = `${lines.join("\n")}\n`;
	}

	/** Resolve the panel exactly as the console does — both sources = this world. */
	panel() {
		const flags: FlagView[] = resolveAllFlags({
			env: this.env,
			envFile: { status: "readable", content: this.content },
		});
		return buildDagFlagPanel(flags);
	}

	/** The current panel's fail-stop preset, split into the individual apply commands. */
	presetCommands(which: "enableV1" | "enableV2" | "disable"): string[] {
		const preset = this.panel().presets[which];
		expect(preset.enabled, `${which} must be clickable`).toBe(true);
		return preset.phase1Command ? preset.phase1Command.split(" && ") : [];
	}

	/** Drive ONE `flywheel-comm feature-flags apply --name X --to on|off` command
	 *  through the REAL applyFlagToggle transaction (persist file → mutate env). */
	apply(command: string): void {
		const match = command.match(/--name (\S+) --to (on|off)$/);
		if (!match) throw new Error(`unparseable command: ${command}`);
		const name = match[1] as DagControlName;
		const envVar = ENV_VAR.get(name)!;
		const rawTo = match[2] === "on" ? "1" : "0";
		const rawFrom = this.env[envVar] ?? null;
		const result = applyFlagToggle(
			{
				envPath: "/tmp/qa-hermetic/.env",
				readFile: () => this.content,
				writeFile: (_path: string, next: string) => {
					this.content = next;
				},
				env: this.env,
				lock: (fn) => fn(),
			},
			{ name, rawFrom, rawTo, fileSha: computeEnvSha(this.content) },
		);
		expect(result, `apply ${name}→${rawTo} must succeed`).toMatchObject({
			ok: true,
		});
	}
}

/** on = template dispatch is ON while a prerequisite lever is missing. */
function templateOnWithoutPrereqs(p: ReturnType<EnvWorld["panel"]>): boolean {
	if (p.levers.workflow_template_dispatch !== true) return false;
	return (
		p.levers.workflow_claims_write !== true ||
		p.levers.workflow_claims_read !== true
	);
}

describe("FLY-1344 QA — founder DAG apply pipeline (real toggle → resolver → panel)", () => {
	it("production initial state is fail-closed with dispatch off", () => {
		const world = new EnvWorld({
			workflow_claims_write: false,
			workflow_claims_read: false,
			workflow_generalized_templates: false,
			workflow_template_dispatch: false,
		});
		const panel = world.panel();
		expect(panel.shipReader).toBe("blocked_fail_closed");
		expect(panel.v1Dispatch.state).toBe("off");
		expect(panel.v2Dispatch.state).toBe("off");
		expect(panel.degradedFlags).toEqual([]);
		expect(panel.presets.enableV1.enabled).toBe(true);
		expect(panel.presets.enableV1.phase2Command).toBeUndefined();
	});

	it("walking the enable-v1 sequence keeps dispatch consistent and ends on claims", () => {
		const world = new EnvWorld({
			workflow_claims_write: false,
			workflow_claims_read: false,
			workflow_generalized_templates: false,
			workflow_template_dispatch: false,
		});
		const commands = world.presetCommands("enableV1");
		expect(commands.length).toBeGreaterThan(0);

		for (const command of commands) {
			world.apply(command);
			const panel = world.panel();
			// INVARIANT ①: template dispatch never turns on before both claims levers.
			expect(templateOnWithoutPrereqs(panel), command).toBe(false);
			// dual-write keeps the two sources in agreement → never degraded mid-run.
			expect(panel.degradedFlags, command).toEqual([]);
		}

		const done = world.panel();
		expect(done.v1Dispatch.state).toBe("ready");
		expect(done.shipReader).toBe("claims");
		expect(done.presets.enableV1.phase2Command).toBeUndefined();
	});

	it("fully enabled v1 reads claims with no second phase", () => {
		const world = new EnvWorld({
			workflow_claims_write: true,
			workflow_claims_read: true,
			workflow_generalized_templates: false,
			workflow_template_dispatch: true,
		});
		expect(world.panel().shipReader).toBe("claims");
		expect(world.panel().presets.enableV1.phase2Command).toBeUndefined();
		expect(world.panel().degradedFlags).toEqual([]);
	});

	it("the disable sequence turns dispatch off before removing prerequisites", () => {
		const world = new EnvWorld({
			workflow_claims_write: true,
			workflow_claims_read: true,
			workflow_generalized_templates: true,
			workflow_template_dispatch: true,
		});
		expect(world.panel().shipReader).toBe("claims");
		const commands = world.presetCommands("disable");
		// Dispatch is the first lever removed, so later prerequisite changes cannot
		// leave an enabled but incomplete engine.
		expect(commands[0]).toBe(
			"flywheel-comm feature-flags apply --name workflow_template_dispatch --to off",
		);
		for (const command of commands) {
			world.apply(command);
			expect(templateOnWithoutPrereqs(world.panel()), command).toBe(false);
		}
		const done = world.panel();
		expect(done.shipReader).toBe("blocked_fail_closed");
		expect(done.v1Dispatch.state).toBe("off");
		expect(done.v2Dispatch.state).toBe("off");
	});
});
