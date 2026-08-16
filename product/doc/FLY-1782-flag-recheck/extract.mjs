/**
 * FLY-1413 — feature-flag audit extractor (reproducible machine facts).
 *
 * Forked verbatim from the FLY-1136 extractor (branch flywheel-FLY-1136, PR #546,
 * commit dc62daac) with three FLY-1413 additions, each marked `FLY-1413:` below:
 *   1. baseline diff  — emits `newSinceBaseline` (the 62 flags added since the
 *      FLY-1136 audit) so build-html can scope its name-set guard to the increment.
 *   2. RUNTIME_HARD_OFF — flags whose lane FLY-1393 retired by making the reader
 *      return a hardcoded false. Without this the snapshot reports `park_watch`
 *      as "ON (default)" while the running Bridge reports effective_enabled:false.
 *   3. DEAD_BY_DEPENDENCY — knobs that are not hard-off themselves but whose only
 *      consumer never runs.
 * Both tables are NAMED and asserted against the registry (a typo throws), the
 * same reviewable shape as the inherited ACTIVATION_OVERRIDES. They ADD fields;
 * they never mutate `configured`, so the "config says on / runtime says off"
 * discrepancy stays visible instead of being silently resolved.
 *
 * ── original header ──
 * FLY-1136 — feature-flag audit extractor (reproducible machine facts).
 *
 * Reads the registry (source of truth) + the live production config surfaces
 * (~/.flywheel/.env, the 6 registered project configs, and per-Lead manifests
 * for launcher-derived flags) and emits `snapshot.json` — the SINGLE source of
 * machine facts consumed by build-html.mjs. It does NOT decide group / bucket /
 * plain wording (those are audit judgments authored in flags-data.js).
 *
 * Design contract locked in the Codex design review (plan.md §1/§2.1,
 * research.md §3′), 6 rounds APPROVED:
 *  - configuredValue: env idiom (default_on = !== "0"; opt_in = === "1"); project
 *    flags per-project; per-Lead launcher-derived flags via CONFIGURED_VALUE_OVERRIDES.
 *  - activation ({bridge?,lead?,cli?,watcher?} + activationSource): toggleable-first
 *    (direct / active project-config = live; else restart the owning process picked
 *    by readSite file) + a named ACTIVATION_OVERRIDES table for consumers the
 *    structured readSites[] can't express (only cmux's watcher today).
 *  - provenance: registryContentSha256 (content-hash alignment guard) +
 *    registryCommit (informational) + capturedAt + project names. No secrets.
 *
 * NOTE: the FEATURE_FLAGS array is our own first-party source; we eval only that
 * literal (with a stubbed envSite helper) to avoid a TS toolchain in this docs
 * build. No external input is evaluated.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const REGISTRY = path.join(
	REPO,
	"packages/config/src/feature-flags/registry.ts",
);

// ── 1. Parse the registry FEATURE_FLAGS array (trusted first-party literal) ──
const registrySrc = fs.readFileSync(REGISTRY, "utf8");
const registryContentSha256 = createHash("sha256")
	.update(registrySrc)
	.digest("hex");
let registryCommit = "unknown";
try {
	registryCommit = execFileSync(
		"git",
		["log", "-1", "--format=%H", "--", REGISTRY],
		{ cwd: REPO },
	)
		.toString()
		.trim();
} catch {
	/* provenance is best-effort */
}

const arrStart = registrySrc.indexOf(
	"[",
	registrySrc.indexOf("export const FEATURE_FLAGS"),
);
const arrText = registrySrc.slice(
	arrStart,
	registrySrc.indexOf("\n];", arrStart) + 2,
);
// biome-ignore lint/correctness/noUnusedVariables: called by name inside the eval'd registry literal
function envSite(file, symbol, timing, pattern = "process.env") {
	return { file, symbol, pattern, timing };
}
// biome-ignore lint/security/noGlobalEval: trusted first-party registry literal only
const FEATURE_FLAGS = eval(arrText);

// ── 2. Live config surfaces ──
const HOME = os.homedir();
const envMap = {};
const envPath = path.join(HOME, ".flywheel/.env");
/**
 * FLY-1782 BUGFIX (inherited defect, found this round).
 *
 * The FLY-1136/1413 parser kept EVERYTHING after `=`, including a trailing
 * ` # comment`. Production loads this file with `set -a; source ~/.flywheel/.env`,
 * and bash drops a whitespace-preceded `#` comment — so the two disagree.
 *
 * Measured on today's production .env:
 *   line 161  FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1  # 2026-07-31 Annie 拍板恢复 DAG 派工
 *     bash      → "1"                      → dispatch ON
 *     old parser→ "1  # 2026-07-31 Annie…" → !== "1" → reported dispatch OFF
 *
 * That is the single most consequential lever in the system, and the old
 * pipeline would have shown the founder the exact opposite of production.
 * (Behavioural cross-check: this audit itself runs as a generalized workflow
 * node, which only exists when template dispatch is ON.)
 *
 * The YAML side already had `stripScalarComment` (added in the FLY-1413 Codex
 * review); the .env side never got the same treatment. It does now.
 */
function stripEnvInlineComment(raw) {
	const v = raw.trim();
	// Quoted scalar: content is the quoted part; anything after the closing
	// quote (typically ` # note`) is a comment. Matches bash for the shapes
	// this file actually uses.
	const q = v.match(/^(['"])(.*?)\1/);
	if (q) return q[2];
	// Unquoted: bash starts a comment at a `#` that follows whitespace. A `#`
	// with no space before it is part of the value (e.g. a colour or fragment).
	const cut = v.search(/\s#/);
	return (cut === -1 ? v : v.slice(0, cut)).trim();
}
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
		const m = line.match(/^\s*(FLYWHEEL_[A-Z0-9_]+)\s*=\s*(.*)$/);
		// Last assignment wins — same as `source`, which re-assigns in file order.
		if (m) envMap[m[1]] = stripEnvInlineComment(m[2]);
	}
}

const projects = JSON.parse(
	fs.readFileSync(path.join(HOME, ".flywheel/projects.json"), "utf8"),
).map((p) => ({ name: p.projectName, root: p.projectRoot }));

// Parse the mapping subset our project configs use (nested maps + scalar values)
// into a nested object via an indent stack — correct for direct-child depth and
// inline comments (Codex code-review R1 MED-2; the bespoke `yamlGet` mishandled
// deep descendants + `key: val # comment`). Lists / block scalars aren't used on
// any audited flag key and are skipped.
function stripScalarComment(v) {
	const t = v.trim();
	// Quoted scalar: take the quoted content up to the closing quote and ignore
	// anything after it (e.g. a trailing ` # comment`). A `#` INSIDE the quotes is
	// preserved because we stop at the closing quote first. (Codex code-review R2.)
	if (t[0] === '"' || t[0] === "'") {
		const q = t[0];
		const end = t.indexOf(q, 1);
		return end > 0 ? t.slice(1, end) : t.slice(1);
	}
	return t.replace(/\s+#.*$/, "").trim(); // unquoted inline comment
}
function parseYamlSubset(text) {
	const root = {};
	const stack = [{ indent: -1, obj: root }];
	for (const line of text.split("\n")) {
		if (/^\s*#/.test(line) || line.trim() === "") continue;
		const indent = line.match(/^(\s*)/)[1].length;
		const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:(.*)$/);
		if (!m) continue; // list item / unsupported line → skip
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
			stack.pop();
		const parent = stack[stack.length - 1].obj;
		const val = m[2].trim();
		if (val === "") {
			const child = {};
			parent[m[1]] = child;
			stack.push({ indent, obj: child });
		} else {
			parent[m[1]] = stripScalarComment(val);
		}
	}
	return root;
}
function getByPath(obj, dotKey) {
	let cur = obj;
	for (const k of dotKey.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = cur[k];
	}
	// a non-leaf (object) is not a scalar value for a flag key
	return cur && typeof cur === "object" ? undefined : cur;
}

function readProjectConfig(root) {
	const p = path.join(root, ".flywheel/config.yaml");
	return fs.existsSync(p) ? parseYamlSubset(fs.readFileSync(p, "utf8")) : null;
}
const projectYaml = new Map(
	projects.map((p) => [p.name, readProjectConfig(p.root)]),
);

// ── 3. Named override tables (reviewable; readSites can't express these) ──
// activation consumers NOT in structured readSites[] (only cmux's watcher today).
const ACTIVATION_OVERRIDES = {
	cmux_close_request_killswitch: {
		activation: { bridge: "restart", watcher: "restart" },
		reason:
			"registry note: watcher scripts/flywheel-cmux-sync.sh owns its own env — restart Bridge AND watcher",
	},
};
// FLY-1782: re-verified for this round. The FLY-1413 tables listed 3 hard-off
// lanes + 10 dead-by-dependency knobs; ALL 13 of those flags were physically
// deleted from the registry by FLY-1456 (PR #695, merged 2026-07-24), so every
// inherited entry was stale. This round re-scanned today's 124 for the same two
// shapes (reader wired to a hardcoded constant / only consumer behind a lane
// that never runs) and found NONE — see audit.md §3.2 for the method and the
// honest limits of that negative result. Both tables therefore stay EMPTY, and
// the assertions below keep them honest if a future round adds an entry.
const RUNTIME_HARD_OFF = {};
// Knobs that are not hard-off themselves, but whose ONLY production consumer
// sits behind a lane that never runs. `via` names the hard-off root; `chain` is
// the verified path from this flag's read site down to that root.
const DEAD_BY_DEPENDENCY = {};

// FLY-1413 (Codex R1 HIGH-2, corrected in R2): which PROCESS actually executes
// the read. The console's direct apply mutates the RUNNING Bridge's own
// `process.env` (flag-toggle.ts), so a call-time read inside another process is
// NOT made hot by reclassifying the flag.
//
// The first attempt derived this from the read-site's package path. That was
// WRONG and shipped false statements to the founder: a package path is not a
// runtime process. `packages/claude-runner/src/codex-daemon-client.ts` reads
// `codex_gate_wait`, but its owner `CodexTmuxAdapter` is constructed at
// `packages/teamlead/src/bridge/run-infra.ts:409` — inside the Bridge. And
// `packages/flywheel-comm/src/db.ts` is not CLI-only: the Bridge imports the
// same CommDB at `plugin.ts:23`.
//
// So: exactly ONE path rule is sound (a file under the bridge dir runs in the
// Bridge). Everything else must be an explicitly VERIFIED entry naming the
// instantiation site. Anything unclassified THROWS — the founder gets no
// guessed process attribution.
const BRIDGE_DIR = "packages/teamlead/src/bridge/";
const P = {
	bridge: "Bridge",
	daemon: "quota daemon(独立进程)",
	cli: "命令行(每次调用)",
	voice: "voice-bridge 进程",
	watcher: "cmux watcher 脚本",
	// FLY-1782 additions: process kinds the FLY-1413 increment never had to name.
	claudeLead: "Claude Lead 进程(逐 Lead)",
	codexLead: "Codex Lead 进程(逐 Lead)",
	inboxMcp: "Lead 的 inbox-mcp 进程",
};
/** flag name → { processes[], evidence } — each traced to its host process. */
const VERIFIED_PROCESS_OWNERS = {
	codex_gate_wait: {
		readFiles: ["packages/claude-runner/src/codex-daemon-client.ts"],
		processes: [P.bridge],
		evidence:
			"读点在 packages/claude-runner/src/codex-daemon-client.ts:638,但持有它的 CodexTmuxAdapter 由 Bridge 在 packages/teamlead/src/bridge/run-infra.ts:409 构造 —— 跑在 Bridge 进程里,不是 Runner",
	},
	commdb_protection: {
		readFiles: ["packages/flywheel-comm/src/db.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"读点在 packages/flywheel-comm/src/db.ts:259(共享 CommDB);Bridge 在 packages/teamlead/src/bridge/plugin.ts:23 import 同一个 CommDB,命令行也用它",
	},
	ask_hygiene: {
		readFiles: [
			"packages/flywheel-comm/src/db.ts",
			"packages/teamlead/src/StateStore.ts",
			"packages/teamlead/src/bridge/gate-poller.ts",
			"packages/teamlead/src/bridge/zombie-gate-hygiene.ts",
		],
		processes: [P.bridge, P.cli],
		evidence:
			"读点跨 flywheel-comm/src/db.ts(Bridge 与 CLI 共用)与 bridge/zombie-gate-hygiene.ts、bridge/gate-poller.ts、StateStore.ts(Bridge)",
	},
	design_html_gate: {
		readFiles: [
			"packages/flywheel-comm/src/commands/complete.ts",
			"packages/teamlead/src/DirectEventSink.ts",
			"packages/teamlead/src/bridge/complete-marker-reconciler.ts",
			"packages/teamlead/src/bridge/event-route.ts",
		],
		processes: [P.bridge, P.cli],
		evidence:
			"flywheel-comm/src/commands/complete.ts(CLI 每次调用)+ bridge/event-route.ts、DirectEventSink.ts、bridge/complete-marker-reconciler.ts(Bridge)",
	},
	workflow_claims_read: {
		readFiles: [
			"packages/flywheel-comm/src/commands/verify-approval.ts",
			"packages/flywheel-comm/src/ship-eligibility.ts",
			"packages/teamlead/src/workflow-claims.ts",
		],
		processes: [P.bridge, P.cli],
		evidence:
			"teamlead/src/workflow-claims.ts(Bridge)+ flywheel-comm 的 ship-eligibility.ts / verify-approval.ts(CLI)",
	},
	ship_ci_guard: {
		readFiles: ["packages/flywheel-comm/src/ship-ci-guard.ts"],
		processes: [P.cli],
		evidence:
			"packages/flywheel-comm/src/ship-ci-guard.ts 只被 flywheel-comm 的 gate.ts / verify-approval.ts import;Bridge 不加载",
	},
	lead_lease_bypass: {
		readFiles: ["packages/flywheel-comm/src/lead-lease.ts"],
		processes: [P.cli],
		evidence:
			"packages/flywheel-comm/src/lead-lease.ts,注册表登记为 cli_invocation(治理门)",
	},
	quota_degraded_switch: {
		readFiles: ["packages/teamlead/src/account-heal/quota-monitor.ts"],
		processes: [P.daemon],
		evidence:
			"packages/teamlead/src/account-heal/quota-monitor.ts —— 该模块不被 Bridge import,跑在独立的 flywheel-quota-monitor 守护进程里(其 wrapper 启动时 source 共享 .env)",
	},
	claude_account_identity_check: {
		readFiles: [
			"packages/claude-runner/bin/flywheel-claude-profile",
			"packages/teamlead/src/account-heal/quota-monitor.ts",
		],
		processes: [P.daemon, P.cli],
		evidence:
			"account-heal/quota-monitor.ts(quota 守护进程)+ packages/claude-runner/bin/flywheel-claude-profile(独立命令行 bin,不是 Runner 进程)",
	},
	voice_qa_presence_override: {
		readFiles: ["packages/voice-bridge/src/assistant/wiring.ts"],
		processes: [P.voice],
		evidence:
			"packages/voice-bridge/src/assistant/wiring.ts,由 voice-bridge 自己的 cli.ts / index.ts 装配",
	},
	cmux_linked_view: {
		readFiles: [
			"packages/teamlead/src/bridge/tmux-lookup.ts",
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/flywheel-cmux-sync.sh",
		],
		processes: [P.bridge, P.watcher],
		evidence:
			"scripts/flywheel-cmux-sync.sh + flywheel-cmux-autostart.sh(watcher 每次调用现读 .env)+ bridge/tmux-lookup.ts(Bridge)",
	},
	cmux_view_invariant: {
		readFiles: [
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/flywheel-cmux-sync.sh",
		],
		processes: [P.watcher],
		evidence:
			"只被 scripts/flywheel-cmux-sync.sh 与 flywheel-cmux-autostart.sh 读,每次调用现读",
	},
	// ── Bridge-hosted, but the read site lives outside packages/teamlead/src/bridge/,
	// so each is traced to the Bridge component that owns it. ──
	receipt_foundation: {
		readFiles: ["packages/config/src/feature-flags/receipt-foundation.ts"],
		processes: [P.bridge],
		evidence:
			"packages/config/src/feature-flags/receipt-foundation.ts,由 bridge/gate-poller.ts 消费",
	},
	readopt_parked_roles: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/HeartbeatService.ts —— Bridge 在 bridge/plugin.ts:6054 构造 HeartbeatService(flywheel-comm 侧只有注释提到它)",
	},
	stuck_pane_confirm: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence: "同 HeartbeatService,由 bridge/plugin.ts:6054 构造",
	},
	zombie_reconcile: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence: "同 HeartbeatService,由 bridge/plugin.ts:6054 构造",
	},
	three_stage_codex_design_toggle: {
		readFiles: ["packages/config/src/three-stage-phases.ts"],
		processes: [P.bridge],
		evidence:
			"packages/config/src/three-stage-phases.ts 的 resolvePhaseDispatch,由 teamlead/workflow-dispatch-resolution.ts 与 bridge/phase-orchestrator.ts 消费;注册表 note 也写「改 .env 后需 restart-services.sh --bridge-only」",
	},
	ship_ready_notify: {
		readFiles: ["packages/teamlead/src/workflow-ship-ready.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/workflow-ship-ready.ts,由 bridge/plugin.ts 与 bridge/workflow-engine-dispatcher.ts 消费",
	},
	ship_ready_remind_ms: {
		readFiles: ["packages/teamlead/src/workflow-ship-ready.ts"],
		processes: [P.bridge],
		evidence: "同 workflow-ship-ready.ts,由 bridge/plugin.ts 消费",
	},
	skill_framework_mode: {
		readFiles: ["packages/edge-worker/src/Blueprint.ts"],
		processes: [P.bridge],
		evidence:
			"packages/edge-worker/src/Blueprint.ts —— Blueprint 由 bridge/actions.ts、bridge/bootstrap-generator.ts 在 Bridge 内使用(flywheel-comm 侧只有注释提到它)",
	},
	skill_framework_split_participation: {
		readFiles: ["packages/edge-worker/src/Blueprint.ts"],
		processes: [P.bridge],
		evidence: "同 Blueprint.ts,逐项目 config,由 Bridge 读取",
	},
	workflow_template_dispatch: {
		readFiles: ["packages/teamlead/src/workflow-template-dispatch.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/workflow-template-dispatch.ts,由 bridge/plugin.ts 与 bridge/runs-route.ts 消费",
	},
	land_node: {
		readFiles: ["packages/teamlead/src/workflow-template-dispatch.ts"],
		processes: [P.bridge],
		evidence: "同 workflow-template-dispatch.ts,由 bridge/plugin.ts 消费",
	},
	workflow_generalized_templates: {
		readFiles: ["packages/teamlead/src/workflow-template.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/workflow-template.ts,由 bridge/land-executor.ts、bridge/management-dag-source.ts 消费",
	},
	workflow_vendor_at_dispatch: {
		readFiles: ["packages/teamlead/src/workflow-dispatch-resolution.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/workflow-dispatch-resolution.ts,由 bridge/actions.ts、bridge/runs-route.ts 消费",
	},
	workflow_claims_write: {
		// FLY-1782: the FLY-1413 entry was traced against 3 read sites; two of them
		// (bridge/plugin.ts + bridge/workflow-shadow-writer.ts) are gone — the
		// shadow writer was removed and the plugin no longer reads the env var
		// directly. Re-traced: the single remaining reader is imported by the
		// Bridge, so the attribution is unchanged even though the sites moved.
		readFiles: ["packages/teamlead/src/workflow-claims.ts"],
		processes: [P.bridge],
		evidence:
			"packages/teamlead/src/workflow-claims.ts:116 —— 由 Bridge 侧 workflow 派工链 import,读点全部在 Bridge 进程内(FLY-1782 重追:原 3 个读点中 bridge/plugin.ts 与 bridge/workflow-shadow-writer.ts 已不再读该 env)",
	},

	// ── FLY-1782: attribution for the flags the inherited table never covered ──
	// FLY-1413 only had to classify its 62-flag increment, so 32 of today's 124
	// fell through to 未核实. This round audits ALL 124, so every one is traced.
	// Verified instantiation sites (grep-confirmed this round):
	//   · flywheel-edge-worker (Blueprint / WorktreeManager) → constructed by the
	//     Bridge at packages/teamlead/src/bridge/run-infra.ts:551.
	//   · HeartbeatService → constructed at bridge/plugin.ts:6388 (Bridge).
	//   · ConfigLoader → imported by the Bridge (edge-worker + teamlead) AND by
	//     the flywheel-comm CLI (packages/flywheel-comm/src/index.ts).
	//   · codex/* lead runtimes → the Codex Lead process (codex-lead.sh family).
	//   · inbox-mcp → its own MCP server process, spawned by claude-lead.sh:2044.
	//   · scripts/flywheel-cmux-*.sh → the cmux watcher / autostart wrapper.
	mailbox_queue: {
		readFiles: [
			"packages/config/src/feature-flags/mailbox-queue.ts",
			"packages/inbox-mcp/src/queue-mode.ts",
		],
		processes: [P.bridge, P.inboxMcp],
		evidence:
			"flywheel-config 的 mailbox-queue.ts 由 Bridge 的 mailbox lane 每 tick 解析;packages/inbox-mcp/src/queue-mode.ts 跑在 claude-lead.sh:2044 启动的 inbox-mcp MCP 进程里",
	},
	tmux_keepalive: {
		readFiles: ["scripts/lib/tmux-server-rescue.sh"],
		processes: [P.cli],
		evidence:
			"scripts/lib/tmux-server-rescue.sh:520 —— 由 Lead 启动/ensure 与 restart-services 调用的 shell 库,下一次调用生效",
	},
	converge_cmux_symlink: {
		readFiles: ["scripts/converge-flywheel-bin.sh"],
		processes: [P.cli],
		evidence:
			"scripts/converge-flywheel-bin.sh:296 —— converge CLI,每次 Lead 启动 / daily update / restart pre-kickstart 独立调用",
	},
	cmux_autostart_exec: {
		readFiles: ["scripts/flywheel-cmux-autostart.sh"],
		processes: [P.watcher],
		evidence:
			"scripts/flywheel-cmux-autostart.sh:53 —— autostart wrapper(launchd KeepAlive job 的入口)",
	},
	cmux_wal_quarantine: {
		readFiles: [
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/flywheel-cmux-sync.sh",
		],
		processes: [P.watcher],
		evidence:
			"scripts/flywheel-cmux-sync.sh:3546 + autostart.sh:51 —— 全部在 launchd cmux watcher 进程内",
	},
	cmux_roster: {
		readFiles: [
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/flywheel-cmux-sync.sh",
		],
		processes: [P.watcher],
		evidence:
			"scripts/flywheel-cmux-sync.sh:601 + autostart.sh:52 —— launchd cmux watcher 进程",
	},
	cmux_strict_view: {
		readFiles: [
			"packages/teamlead/src/bridge/tmux-lookup.ts",
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/flywheel-cmux-sync.sh",
		],
		processes: [P.bridge, P.watcher],
		evidence:
			"bridge/tmux-lookup.ts:770(Bridge)+ flywheel-cmux-sync.sh:3587 / autostart.sh:50(watcher)—— 双侧读,任一侧不改都会留半套拓扑",
	},
	merge_approval_gate_killswitch: {
		readFiles: ["packages/flywheel-comm/src/ship-eligibility.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"packages/flywheel-comm/src/ship-eligibility.ts:38 —— Bridge 侧 merge-ship-gate.ts / DirectEventSink.ts import 同一模块,flywheel-comm CLI 每次调用另读一次 live .env",
	},
	qa_done_gate_killswitch: {
		readFiles: ["packages/flywheel-comm/src/ship-eligibility.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"同 merge_approval_gate_killswitch —— ship-eligibility.ts:39,Bridge import + CLI live .env 双读点",
	},
	progress_resume_killswitch: {
		readFiles: [
			"packages/edge-worker/src/Blueprint.ts",
			"packages/teamlead/src/bridge/run-infra.ts",
		],
		processes: [P.bridge],
		evidence:
			"Blueprint.ts:2153 与 bridge/run-infra.ts:1130 —— Blueprint 由 Bridge 在 run-infra.ts:551 构造,两个读点同属 Bridge 进程",
	},
	heartbeat_readopt: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence:
			"HeartbeatService.ts:678 —— HeartbeatService 在 bridge/plugin.ts:6388 构造,跑在 Bridge 进程",
	},
	liveness_pane_dead: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence: "HeartbeatService.ts:693/1574 —— 同上,Bridge 进程",
	},
	issue_status_word: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence:
			"issue-display-refresher.ts:150 等 5 个读点,全部在 Bridge(HeartbeatService 同样由 plugin.ts:6388 构造)",
	},
	stale_terminal_close: {
		readFiles: ["packages/teamlead/src/HeartbeatService.ts"],
		processes: [P.bridge],
		evidence:
			"HeartbeatService.ts:1713/2071 + bridge/plugin.ts:6422 —— 均在 Bridge 进程",
	},
	remote_reports: {
		readFiles: [
			"packages/flywheel-comm/src/commands/publish-report.ts",
			"packages/teamlead/src/bridge/plugin.ts",
		],
		processes: [P.bridge, P.cli],
		evidence:
			"bridge/plugin.ts:3939 注入 reports 路由(Bridge)+ flywheel-comm 的 publish-report / feature-flags 命令每次调用自读(CLI)—— 双侧独立,只改一侧会 split-brain",
	},
	codex_lead_typing: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		],
		processes: [P.codexLead],
		evidence:
			"codex-lead-runtime.ts:514 / codex-lead-tui-runtime.ts:552 —— 由 codex-lead.sh 家族启动的 Codex Lead 进程读取",
	},
	roundtable_thread_autocontinue: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		],
		processes: [P.codexLead],
		evidence:
			"codex-lead-runtime.ts:648 读原变量,launcher(codex-lead-tui-home.sh:124)把结果折算成 *_EFFECTIVE 传给 gateway —— 全部在 Lead 侧进程链",
	},
	lead_chrome_enabled: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		],
		processes: [P.claudeLead, P.codexLead],
		evidence:
			"lead-body.sh:95 从 manifest export、claude-lead.sh:2300 消费(Claude Lead);codex-lead-runtime.ts:669(Codex Lead)—— 逐 Lead 生效,不是 Bridge 全局",
	},
	lead_core_mention_gated: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		],
		processes: [P.codexLead],
		evidence:
			"codex-lead.sh:97-103 由 launcher 按 projects.json 拓扑算出并 export,codex-lead-runtime.ts:620 消费 —— Codex Lead 进程",
	},
	lead_dry_run: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		],
		processes: [P.claudeLead, P.codexLead],
		evidence:
			"两侧 launcher 与两个 Codex runtime 都读;它是启动前的预演开关,只在那一次启动调用里有意义",
	},
	lead_cross_dept_channel_ids: {
		readFiles: [
			"packages/teamlead/src/lead-backends/codex/lead-actions/config.ts",
		],
		processes: [P.bridge, P.claudeLead, P.codexLead],
		evidence:
			"Lead 侧决定订阅哪些跨部门频道(codex-lead-runtime.ts:588 / claude-lead.sh:2963),Bridge 侧 plugin.ts:7105 另读一次做路由 —— 三类进程都要重启才换",
	},
	founder_attribution_gate: {
		readFiles: ["packages/flywheel-comm/src/founder-attribution.ts"],
		processes: [P.cli],
		evidence:
			"founder-attribution.ts:33,由 verify-approval 在每次 CLI 调用时读 live .env —— 治理门,只读",
	},
	comm_bypass_bridge: {
		readFiles: ["packages/flywheel-comm/src/commands/respond.ts"],
		processes: [P.cli],
		evidence:
			"respond.ts:88 —— 仅 flywheel-comm CLI 的应急直写路径读它;治理门 override",
	},
	doc_flow: {
		readFiles: ["packages/edge-worker/src/Blueprint.ts"],
		processes: [P.bridge],
		evidence:
			"Blueprint.ts:2068 决定是否注入 DOC-FLOW 段;Blueprint 由 Bridge 在 run-infra.ts:551 构造,派工时现读项目 config",
	},
	proofshot: {
		readFiles: ["packages/config/src/ConfigLoader.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"ConfigLoader.ts:153 校验;ConfigLoader 由 Bridge(edge-worker/teamlead)与 flywheel-comm CLI(src/index.ts)共用",
	},
	xiaohongshu_learning: {
		readFiles: ["packages/config/src/ConfigLoader.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"ConfigLoader.ts:570 校验 + bridge/project-runner-model-source.ts:55 消费 —— Bridge 为主,CLI 共用同一个 loader",
	},
	ponytail: {
		readFiles: ["packages/config/src/ConfigLoader.ts"],
		processes: [P.bridge, P.cli],
		evidence:
			"ConfigLoader.ts:549 只做校验;bridge/run-infra.ts:980 明确注释「项目层永不生效」—— 项目层 dormant,故无实际生效进程",
	},
	founder_ux_gate: {
		readFiles: ["packages/config/src/ConfigLoader.ts"],
		processes: [P.bridge, P.claudeLead],
		evidence:
			"Bridge 侧 DirectEventSink.ts:299 在每个 run 上快照该值;claude-lead.sh:2622 另在 Lead 启动时读同一项目 config 决定挂哪套 base rules",
	},
	founder_ux_gate_killswitch: {
		readFiles: ["packages/config/src/founder-ux-config.ts"],
		processes: [P.bridge, P.claudeLead],
		evidence:
			"founder-ux-config.ts:79 单一谓词;Blueprint(Bridge 内构造)与 claude-lead.sh:2649(Lead 启动)各消费一次",
	},
	workflow_gate_carrier: {
		readFiles: ["packages/teamlead/src/workflow-template-dispatch.ts"],
		processes: [P.bridge],
		evidence:
			"workflow-template-dispatch.ts:21 —— 派工决策在 Bridge 内做;真正决定行为的是 run 冻结的 gate_carrier_epoch,env 只影响下一个新 run",
	},
	push_guard: {
		readFiles: ["packages/edge-worker/src/WorktreeManager.ts"],
		processes: [P.bridge],
		evidence:
			"WorktreeManager.ts:594 建 worktree 时装 pre-push hook;WorktreeManager/Blueprint 均由 Bridge 在 run-infra.ts:551 构造",
	},
	instruction_path_check: {
		readFiles: [
			"packages/flywheel-comm/src/commands/await-codex-gate.ts",
			"packages/teamlead/src/bridge/design-review-validation.ts",
			"packages/teamlead/src/bridge/event-route.ts",
			"packages/teamlead/src/bridge/plugin.ts",
		],
		processes: [P.bridge, P.cli],
		evidence:
			"Bridge 三处(plugin.ts:6216 / event-route.ts:459 / design-review-validation.ts:27)+ flywheel-comm 的 await-codex-gate 每次调用自读 —— 跨进程授权面,只读",
	},
};
const UNCLASSIFIED = "未核实";
/**
 * FLY-1782: survey mode. The inherited gates THROW on the first drift, which
 * makes a 124-flag re-audit a one-error-per-run crawl. `FLY1782_SURVEY=1`
 * collects every drift instead so the whole re-trace list lands in one pass.
 * The gate itself is unchanged and stays ON for the real (non-survey) run —
 * the snapshot that feeds the review page is only ever produced with gates on.
 */
const SURVEY = process.env.FLY1782_SURVEY === "1";
const SURVEY_DRIFT = [];
function processOwnersFor(name, readFiles) {
	const verified = VERIFIED_PROCESS_OWNERS[name];
	if (verified) {
		// Codex R2 MEDIUM-2: pin the attribution to the read sites it was traced
		// against. Without this, adding a NEW read site (in a new process) to an
		// already-mapped flag silently keeps the stale owner list — the exact
		// drift the unclassified check cannot see, because the name is mapped.
		const now = JSON.stringify([...new Set(readFiles)].sort());
		const then = JSON.stringify([...new Set(verified.readFiles)].sort());
		if (now !== then) {
			const msg =
				`VERIFIED_PROCESS_OWNERS["${name}"] was traced against ${then} but the registry now declares ${now}. ` +
				"Re-trace the new read site to its host process and update both `processes` and `readFiles`.";
			if (!SURVEY) throw new Error(msg);
			SURVEY_DRIFT.push({
				name,
				// not `then`: a `then` property makes the object thenable (biome
				// noThenProperty), which would break any await on this array.
				tracedAgainst: JSON.parse(then),
				now: JSON.parse(now),
			});
		}
		return { processes: verified.processes, evidence: verified.evidence };
	}
	if (readFiles.every((f) => f.startsWith(BRIDGE_DIR)))
		return { processes: [P.bridge], evidence: `全部读点在 ${BRIDGE_DIR} 下` };
	// Not throwing here: the snapshot covers all 148 registry flags, but only the
	// audited increment is shown to the founder. Unclassified is recorded
	// honestly, and asserted away below for anything IN SCOPE.
	return {
		processes: [UNCLASSIFIED],
		evidence: `读点不全在 ${BRIDGE_DIR} 下,且没有已核实的进程归属条目`,
		unclassified: true,
	};
}
// per-Lead launcher/manifest-derived current-state (global .env can't tell it).
const CONFIGURED_VALUE_OVERRIDES = {
	lead_chrome_enabled: {
		kind: "per_lead",
		resolve: perLeadChromeEnabled,
		note: "flywheel-lead-wrapper.sh 从每个 Lead manifest 读 .chromeEnabled 并 export 该 Lead 的 env",
	},
	lead_core_mention_gated: {
		kind: "per_lead",
		resolve: perLeadCoreMentionGated,
		note: "codex-lead.sh 用 core-room-gate-cli.js 按 projects.json core-room 拓扑逐 Codex Lead 计算并 export=1",
	},
};

function readLeadManifests() {
	const dir = path.join(HOME, ".flywheel/manifests");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
				return {
					leadId: j.leadId || j.agentId || f.replace(/\.json$/, ""),
					project: j.projectName || "?",
					chromeEnabled: j.chromeEnabled === true,
				};
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}
function perLeadChromeEnabled() {
	const leads = readLeadManifests();
	return {
		kind: "per_lead",
		source: "manifest",
		values: leads.map((l) => ({
			project: l.project,
			leadId: l.leadId,
			value: l.chromeEnabled,
		})),
		onCount: leads.filter((l) => l.chromeEnabled).length,
		total: leads.length,
	};
}
function perLeadCoreMentionGated() {
	// Exact per-Lead value requires the launcher's core-room-gate CLI over the live
	// projects.json topology (not statically resolvable here). Report the source
	// honestly rather than fabricating a global OFF.
	return {
		kind: "per_lead",
		source: "launcher_derived",
		values: null,
		note: "逐 Codex Lead 由 launcher 按 projects.json core-room 拓扑计算;精确值需跑 core-room-gate-cli。non-CoS Codex Lead 若订阅带 CoS 的 core room 则 ON。",
	};
}

// ── 4. activation derivation (toggleable-first + owning-process + override) ──
function deriveActivation(spec) {
	if (spec.dormant)
		return { activation: { n_a: true }, activationSource: "derived" };
	const override = ACTIVATION_OVERRIDES[spec.name];
	if (override)
		return {
			activation: override.activation,
			activationSource: "override",
			activationReason: override.reason,
		};
	if (spec.source === "project_config")
		return { activation: { bridge: "live" }, activationSource: "derived" }; // ConfigLoader mtime reload
	const files = spec.readSites.map((s) => s.file);
	if (files.some((f) => f.includes("lead-backends/")))
		return { activation: { lead: "restart" }, activationSource: "derived" };

	// FLY-1413 (Codex R2 HIGH-1): derive the boundary PER OWNING PROCESS. The old
	// code fell through to `{bridge:"restart"}` for everything, which put two
	// contradictory sentences on the same card — "restart the Bridge" next to
	// "the Bridge is not what reads this". Restarting the Bridge does nothing for
	// a flag the quota daemon / voice-bridge / a CLI reads.
	//
	// Codex R2 MEDIUM-1: `direct` used to return early with `{bridge:"live"}`,
	// which dropped the OTHER owners of a multi-process flag — `workflow_claims_read`
	// is console-toggleable in the Bridge AND read by the CLI, so the card said
	// "takes effect immediately" while its own banner said it is not hot. A direct
	// flag is live in the BRIDGE only; every other owner still has its own boundary.
	const { processes, unclassified } = processOwnersFor(spec.name, files);
	// Codex R3 MEDIUM-2 (a regression I introduced in R2): dropping the `direct`
	// early return meant an UNCLASSIFIED owner fell through to bridge:"restart",
	// flipping three out-of-scope direct flags from live to restart. Without a
	// traced attribution we have no better fact than the registry's own
	// toggleability, so fall back to exactly the pre-R2 behaviour.
	if (unclassified)
		return spec.toggleable === "direct"
			? { activation: { bridge: "live" }, activationSource: "derived" }
			: { activation: { bridge: "restart" }, activationSource: "derived" };
	const timingOf = (proc) => {
		if (proc === P.bridge && spec.toggleable === "direct")
			return ["bridge", "live"];
		if (proc === P.cli) return ["cli", "next_invocation"];
		if (proc === P.watcher) return ["watcher", "next_invocation"]; // sources .env per run
		if (proc === P.daemon) return ["daemon", "restart"];
		if (proc === P.voice) return ["voice", "restart"];
		return ["bridge", "restart"];
	};
	const activation = {};
	for (const proc of processes) {
		const [key, val] = timingOf(proc);
		activation[key] = val;
	}
	return { activation, activationSource: "derived_per_process" };
}

function envConfigured(spec) {
	const raw = spec.envVar ? envMap[spec.envVar] : undefined;
	if (spec.valueKind === "enum" || spec.valueKind === "value")
		return { set: raw !== undefined, value: raw ?? String(spec.default) };
	const eff = spec.polarity === "default_on" ? raw !== "0" : raw === "1";
	return { set: raw !== undefined, value: eff };
}
function projConfigured(spec) {
	if (spec.dormant) return { dormant: true };
	const byProject = projects.map((p) => {
		const cfg = projectYaml.get(p.name);
		const raw = cfg ? getByPath(cfg, spec.configKey) : undefined;
		let value;
		if (raw === undefined) value = spec.default;
		else if (spec.valueKind === "bool")
			value = raw === "true" || raw === "1" || raw === "yes" || raw === true;
		else value = String(raw);
		return { project: p.name, value, isDefault: value === spec.default };
	});
	return { byProject };
}

// ── 5. Build snapshot rows ──
const rows = FEATURE_FLAGS.map((spec) => {
	const { activation, activationSource, activationReason } =
		deriveActivation(spec);
	const row = {
		name: spec.name,
		category: spec.category,
		source: spec.source,
		scope: spec.scope,
		envVar: spec.envVar,
		configKey: spec.configKey,
		polarity: spec.polarity,
		valueKind: spec.valueKind,
		enumValues: spec.enumValues,
		default: spec.default,
		toggleable: spec.toggleable,
		dormant: !!spec.dormant,
		timings: [...new Set(spec.readSites.map((s) => s.timing))],
		readFiles: [...new Set(spec.readSites.map((s) => s.file))],
		registryDescription: spec.description,
		registryNote: spec.note ?? null,
		activation,
		activationSource,
	};
	if (activationReason) row.activationReason = activationReason;
	// FLY-1413: additive only — `configured` below still reports the raw config
	// idiom, so "config says on / runtime says off" stays visible on the card.
	const hardOff = RUNTIME_HARD_OFF[spec.name];
	if (hardOff) row.runtimeHardOff = hardOff;
	const dead = DEAD_BY_DEPENDENCY[spec.name];
	if (dead) row.deadByDependency = dead;
	const owners = processOwnersFor(row.name, row.readFiles);
	row.processOwners = owners.processes;
	row.processOwnerEvidence = owners.evidence;
	if (owners.unclassified) row.processOwnerUnclassified = true;
	// "Only the registry classification stands between this flag and a live
	// console toggle" is ONLY true when every consumer is the Bridge itself.
	row.bridgeOnlyConsumers =
		row.processOwners.length === 1 && row.processOwners[0] === P.bridge;
	const cvo = CONFIGURED_VALUE_OVERRIDES[spec.name];
	if (cvo) {
		row.configured = cvo.resolve();
		row.configuredNote = cvo.note;
	} else if (spec.scope === "bridge_global") {
		row.configured = { kind: "global_env", ...envConfigured(spec) };
	} else {
		row.configured = { kind: "project", ...projConfigured(spec) };
	}
	return row;
});

// ── 6. Assertions (fail loud; do not emit a wrong snapshot) ──
const names = rows.map((r) => r.name);
if (new Set(names).size !== names.length)
	throw new Error("snapshot: duplicate flag name");
// FLY-1782: in survey mode a stale table entry is exactly the signal we are
// hunting (its flag was deleted with its feature), so record instead of throw.
function tableGate(table, n, msg) {
	if (names.includes(n)) return true;
	if (!SURVEY) throw new Error(msg);
	SURVEY_DRIFT.push({ name: n, staleTable: table });
	return false;
}
for (const n of Object.keys(ACTIVATION_OVERRIDES))
	tableGate(
		"ACTIVATION_OVERRIDES",
		n,
		`ACTIVATION_OVERRIDES: unknown flag ${n}`,
	);
for (const n of Object.keys(CONFIGURED_VALUE_OVERRIDES))
	tableGate(
		"CONFIGURED_VALUE_OVERRIDES",
		n,
		`CONFIGURED_VALUE_OVERRIDES: unknown flag ${n}`,
	);
// FLY-1413: a typo in either new table must fail loudly, never silently no-op.
for (const n of Object.keys(RUNTIME_HARD_OFF))
	tableGate("RUNTIME_HARD_OFF", n, `RUNTIME_HARD_OFF: unknown flag ${n}`);
for (const [n, entry] of Object.entries(DEAD_BY_DEPENDENCY)) {
	if (
		!tableGate("DEAD_BY_DEPENDENCY", n, `DEAD_BY_DEPENDENCY: unknown flag ${n}`)
	)
		continue;
	if (!RUNTIME_HARD_OFF[entry.via])
		throw new Error(
			`DEAD_BY_DEPENDENCY: ${n} points at ${entry.via}, which is not hard-off`,
		);
	if (!entry.chain)
		throw new Error(`DEAD_BY_DEPENDENCY: ${n} has no verified chain`);
}

// ── FLY-1413: baseline diff — what is NEW since the FLY-1136 audit ──
const baseline = JSON.parse(
	fs.readFileSync(path.join(HERE, "baseline-fly1136.json"), "utf8"),
);
// Codex R2 MEDIUM-1: the anchor must NOT come from the file being verified —
// that is self-anchoring (edit both the names and the commit and it still
// "verifies"). Pin it here, in code, and assert the artifact agrees.
const BASELINE_ANCHOR = {
	commit: "dc62daac",
	path: "product/doc/FLY-1136-feature-flag-audit/snapshot.json",
};
if (
	baseline.provenance.commit !== BASELINE_ANCHOR.commit ||
	baseline.provenance.path !== BASELINE_ANCHOR.path
)
	throw new Error(
		`baseline-fly1136.json anchor mismatch: file says ${baseline.provenance.commit}:${baseline.provenance.path}, code pins ${BASELINE_ANCHOR.commit}:${BASELINE_ANCHOR.path}`,
	);
// Codex R1 BLOCKER-1: do not just trust the local JSON — re-derive the pinned
// baseline from git, so a hand-edited baseline (which would silently change the
// audit SCOPE, i.e. what the founder is asked to decide) fails loudly.
try {
	const pinned = JSON.parse(
		execFileSync(
			"git",
			["show", `${BASELINE_ANCHOR.commit}:${BASELINE_ANCHOR.path}`],
			{ cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
		).toString(),
	);
	const fromGit = JSON.stringify(pinned.registryNameSet.slice().sort());
	const local = JSON.stringify(baseline.registryNameSet.slice().sort());
	if (fromGit !== local)
		throw new Error(
			`BASELINE MISMATCH: baseline-fly1136.json !== ${BASELINE_ANCHOR.commit}:${BASELINE_ANCHOR.path}`,
		);
	baseline.provenance.verifiedAgainstGit = true;
} catch (err) {
	if (/BASELINE MISMATCH/.test(err.message)) throw err;
	// Branch not fetched on this machine → record it honestly, never pretend.
	baseline.provenance.verifiedAgainstGit = false;
	console.warn(
		`[extract] WARN: could not verify baseline against git (${err.message.split("\n")[0]}). Snapshot records verifiedAgainstGit:false.`,
	);
}
const baselineSet = new Set(baseline.registryNameSet);
const newSinceBaseline = names.filter((n) => !baselineSet.has(n)).sort();
const goneSinceBaseline = baseline.registryNameSet.filter(
	(n) => !names.includes(n),
);

// ── FLY-1782: second baseline layer — what has NEVER been audited ──
// FLY-1782 re-audits ALL 124, but "never looked at before" and "looked at three
// weeks ago, under a codebase that has since deleted a watchdog family, the
// three-stage pipeline and a receipt layer" are DIFFERENT evidence strengths and
// must not be reported as one number. The previously-audited set is the union of
// the two prior audits, each re-derived from git so a hand-edit fails loudly.
const PRIOR_AUDIT_ANCHORS = [
	{
		issue: "FLY-1136",
		commit: BASELINE_ANCHOR.commit,
		path: BASELINE_ANCHOR.path,
		field: "registryNameSet",
	},
	{
		issue: "FLY-1413",
		commit: "6019e021",
		path: "product/doc/FLY-1413-flag-audit-increment/snapshot.json",
		field: "newSinceBaseline",
	},
];
const priorAudited = new Set();
const priorAuditProvenance = [];
for (const anchor of PRIOR_AUDIT_ANCHORS) {
	let verified = false;
	let count = 0;
	try {
		const doc = JSON.parse(
			execFileSync("git", ["show", `${anchor.commit}:${anchor.path}`], {
				cwd: REPO,
				maxBuffer: 64 * 1024 * 1024,
			}).toString(),
		);
		const list = doc[anchor.field];
		if (!Array.isArray(list) || list.length === 0)
			throw new Error(`${anchor.issue}: ${anchor.field} missing or empty`);
		for (const n of list) priorAudited.add(n);
		verified = true;
		count = list.length;
	} catch (err) {
		// Never silently shrink the "never audited" set into a smaller, prettier
		// number — an unreadable anchor is recorded as unverified, not as zero.
		console.warn(
			`[extract] WARN: prior-audit anchor ${anchor.issue} unreadable (${err.message.split("\n")[0]}).`,
		);
	}
	priorAuditProvenance.push({ ...anchor, verified, count });
}
const allAnchorsVerified = priorAuditProvenance.every((a) => a.verified);
const neverAuditedBefore = allAnchorsVerified
	? names.filter((n) => !priorAudited.has(n)).sort()
	: null;

// FLY-1413 (Codex R2 HIGH-1): every flag the founder is asked about must have a
// VERIFIED process attribution. A guessed one is worse than none — it tells her
// to restart the wrong thing.
// FLY-1782 widens this from "the increment" to ALL 124: this round writes a row
// for every flag, so every row must carry a traced owner. The 32 flags the
// inherited table left as 未核实 were traced this round.
const unclassifiedInScope = rows.filter((r) => r.processOwnerUnclassified);
if (unclassifiedInScope.length && !SURVEY)
	throw new Error(
		`process owner unclassified for ${unclassifiedInScope.length} in-scope flag(s): ` +
			unclassifiedInScope
				.map((r) => `${r.name} [${r.readFiles.join(", ")}]`)
				.join(" | ") +
			". Trace each to the process that actually runs the read and add a VERIFIED_PROCESS_OWNERS entry — do NOT guess from the package path.",
	);

// The audit scope must reconcile: baseline − gone + new === current.
if (
	baseline.registryNameSet.length -
		goneSinceBaseline.length +
		newSinceBaseline.length !==
	rows.length
)
	throw new Error("baseline diff does not reconcile with the current registry");

const snapshot = {
	provenance: {
		capturedAt: new Date().toISOString(),
		registryContentSha256,
		registryCommit,
		projects: projects.map((p) => p.name),
		total: rows.length,
		baseline: {
			...baseline.provenance,
			newSinceBaseline: newSinceBaseline.length,
			goneSinceBaseline: goneSinceBaseline.length,
		},
	},
	registryNameSet: names.slice().sort(),
	newSinceBaseline,
	goneSinceBaseline,
	// FLY-1782: audit-scope layering (see the PRIOR_AUDIT_ANCHORS block above).
	// `neverAuditedBefore: null` means an anchor could not be re-derived from git
	// — treat the split as UNKNOWN, never as "everything was audited before".
	priorAuditProvenance,
	neverAuditedBefore,
	rows,
};

if (SURVEY) {
	fs.writeFileSync(
		path.join(HERE, "survey-drift.json"),
		`${JSON.stringify(
			{
				tableDrift: SURVEY_DRIFT,
				unclassifiedInScope: unclassifiedInScope.map((r) => ({
					name: r.name,
					readFiles: r.readFiles,
				})),
				allUnclassified: rows
					.filter((r) => r.processOwnerUnclassified)
					.map((r) => ({ name: r.name, readFiles: r.readFiles })),
				newSinceBaseline,
				goneSinceBaseline,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(
		`[survey] tableDrift=${SURVEY_DRIFT.length} unclassified=${rows.filter((r) => r.processOwnerUnclassified).length} new=${newSinceBaseline.length} gone=${goneSinceBaseline.length}`,
	);
}

const snapshotPath = path.join(HERE, "snapshot.json");
fs.writeFileSync(
	snapshotPath,
	// tab-indented to stay biome-clean across regenerations (repo formatter uses tabs)
	`${JSON.stringify(snapshot, null, "\t")}\n`,
);
// FLY-1413: tab indentation alone is NOT enough — the repo formatter also
// collapses short arrays onto one line, so raw JSON.stringify output fails
// `pnpm lint` on every regeneration. Format the artifact we just wrote so that
// re-running this script leaves the tree lint-clean (idempotent). Best-effort,
// same as the `registryCommit` lookup above: a missing toolchain warns loudly
// rather than failing the extract.
// NOTE: use `pnpm exec biome`, NOT `npx biome` — in this worktree (no local
// node_modules) `npx biome` exits 0 having silently formatted nothing, which is
// worse than an error. Hence the verify step: a silent no-op must still be loud.
try {
	execFileSync("pnpm", ["exec", "biome", "format", "--write", snapshotPath], {
		cwd: REPO,
		stdio: "pipe",
	});
	execFileSync("pnpm", ["exec", "biome", "check", snapshotPath], {
		cwd: REPO,
		stdio: "pipe",
	});
} catch (err) {
	console.warn(
		`[extract] WARN: snapshot.json is not formatter-clean (${err.message.split("\n")[0]}). Run \`pnpm lint --write\` before committing, or \`pnpm lint\` will fail.`,
	);
}
console.log(
	`snapshot.json written: ${rows.length} flags (env ${rows.filter((r) => r.scope === "bridge_global").length} / project ${rows.filter((r) => r.scope === "project").length}); registrySha ${registryContentSha256.slice(0, 12)}`,
);
console.log(
	`FLY-1413 audit scope: baseline ${baseline.registryNameSet.length} − gone ${goneSinceBaseline.length} + new ${newSinceBaseline.length} = ${rows.length}; hard-off ${Object.keys(RUNTIME_HARD_OFF).length}, dead-by-dependency ${Object.keys(DEAD_BY_DEPENDENCY).length}`,
);
