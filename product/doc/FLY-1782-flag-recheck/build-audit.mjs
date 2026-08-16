/**
 * FLY-1782 — 把 snapshot.json(机器事实)+ flags-data.js(人话判断)拼成
 * audit.md 里的逐条体检表。
 *
 * 硬门(任一不过就不出表,沿用 FLY-1136/1413 的纪律):
 *   G1  名字集合必须**逐字等于** registry 的 124 条 —— 多一条少一条都停。
 *   G2  每条都必须有人话判断 —— 不许出现空行占位。
 *   G3  人话判断层里**不许出现现值字样** —— 现值只能来自 snapshot,
 *       否则重跑 extract 会和人话打架(这是 FLY-1413 定的规矩)。
 *   G4  每条都必须有已核实的进程归属 —— 「未核实」不许进表。
 *   G5  snapshot 的 registryContentSha256 必须与当前 registry.ts 一致 ——
 *       否则表是拿旧快照渲染的。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLAGS } from "./flags-data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const snap = JSON.parse(
	fs.readFileSync(path.join(HERE, "snapshot.json"), "utf8"),
);

// ── G5: the snapshot must describe TODAY's registry ──
const registrySha = createHash("sha256")
	.update(
		fs.readFileSync(
			path.join(REPO, "packages/config/src/feature-flags/registry.ts"),
			"utf8",
		),
	)
	.digest("hex");
if (registrySha !== snap.provenance.registryContentSha256)
	throw new Error(
		`G5: snapshot.json was built from a different registry.ts (snapshot ${snap.provenance.registryContentSha256.slice(0, 12)} vs now ${registrySha.slice(0, 12)}). Re-run extract.mjs.`,
	);

// ── G1: exact name-set equality ──
const registryNames = snap.rows.map((r) => r.name).sort();
const dataNames = Object.keys(FLAGS).sort();
if (JSON.stringify(registryNames) !== JSON.stringify(dataNames)) {
	const extra = dataNames.filter((n) => !registryNames.includes(n));
	const missing = registryNames.filter((n) => !dataNames.includes(n));
	throw new Error(
		`G1: flags-data.js does not cover exactly the registry. extra=[${extra}] missing=[${missing}]`,
	);
}

const BUCKETS = {
	keep: "留",
	settle: "固化",
	clean: "清",
	foundation: "交地基",
	diverge: "分歧",
};
const STRENGTH = {
	verified: "本轮取证",
	default: "按默认",
	unresolved: "查无依据",
};

// ── G2 + G3 + G4 ──
// G3 works by forbidding the judgment layer from asserting a CURRENT VALUE.
// Talking about what `=0` / `=1` MEANS is the whole point of the plain-language
// column, so the ban is narrow and anchored: the phrases that claim a live state.
const VALUE_CLAIM = /(现在是开|现在是关|当前值是|现值为|目前设成)/;
for (const [name, d] of Object.entries(FLAGS)) {
	if (!d.plain?.trim() || !d.why?.trim())
		throw new Error(`G2: ${name} 缺人话判断(plain/why 不能为空)`);
	if (!BUCKETS[d.bucket])
		throw new Error(`G2: ${name} bucket 非法: ${d.bucket}`);
	if (!STRENGTH[d.strength])
		throw new Error(`G2: ${name} strength 非法: ${d.strength}`);
	if (VALUE_CLAIM.test(d.plain))
		throw new Error(
			`G3: ${name} 的 plain 里断言了现值 —— 现值只能来自 snapshot.json`,
		);
	const row = snap.rows.find((r) => r.name === name);
	if (row.processOwnerUnclassified || row.processOwners?.includes("未核实"))
		throw new Error(`G4: ${name} 进程归属未核实,不许进表`);
}

// ── rendering helpers (machine facts ONLY from snapshot) ──
function currentValue(row) {
	const c = row.configured;
	if (!c) return "—";
	if (c.dormant) return "**项目层 dormant(设了也不生效)**";
	if (c.kind === "project") {
		const on = c.byProject.filter(
			(p) => p.value === true || p.value === "enforce",
		);
		const explicit = c.byProject.filter((p) => p.isDefault === false);
		if (row.valueKind === "enum")
			return `逐项目:${c.byProject.map((p) => `${p.project}=${p.value}`).join(" / ")}`;
		return `逐项目:${on.length}/${c.byProject.length} 开${explicit.length ? `(显式设过:${explicit.map((p) => `${p.project}=${p.value}`).join("、")})` : "(全部按默认)"}`;
	}
	if (c.kind === "per_lead") {
		if (!c.values) return `逐 Lead(launcher 计算)`;
		const on = c.values.filter((v) => v.value === true || v.value === "1");
		return `逐 Lead:${on.length}/${c.values.length} 开`;
	}
	const v =
		typeof c.value === "boolean" ? (c.value ? "开" : "关") : `\`${c.value}\``;
	return c.set ? `**${v}(有人显式设过)**` : `${v}(没人设过=代码默认)`;
}
function activation(row) {
	const a = row.activation || {};
	if (a.n_a) return "不适用";
	const map = {
		bridge: "Bridge",
		lead: "Lead",
		cli: "命令行",
		watcher: "watcher",
		daemon: "配额守护",
		voice: "voice-bridge",
	};
	const word = {
		live: "秒级生效",
		restart: "要重启",
		next_invocation: "下次调用生效",
	};
	return (
		Object.entries(a)
			.map(([k, v]) => `${map[k] ?? k}:${word[v] ?? v}`)
			.join(" / ") || "—"
	);
}

const GROUPS = [
	["生命周期 / 存活检测", (r) => GROUP_OF[r.name] === 1],
	["ship / 批准链", (r) => GROUP_OF[r.name] === 2],
	["founder 通路 / issue 显示", (r) => GROUP_OF[r.name] === 3],
	["消息层 / 信箱", (r) => GROUP_OF[r.name] === 4],
	["DAG / workflow 派工", (r) => GROUP_OF[r.name] === 5],
	["cmux / tmux 视图", (r) => GROUP_OF[r.name] === 6],
	["Lead 侧(逐 Lead)", (r) => GROUP_OF[r.name] === 7],
	["治理门", (r) => GROUP_OF[r.name] === 8],
	["账号 / 配额 / 外部依赖", (r) => GROUP_OF[r.name] === 9],
	["Runner 提示词 / 逐项目能力", (r) => GROUP_OF[r.name] === 10],
];
// Group membership is derived from the ORDER of flags-data.js, which is authored
// in the same ten sections. Keeping one source avoids a second list to drift.
const SECTION_STARTS = {
	liveness_alerts: 1,
	auto_qa_killswitch: 2,
	founder_thread_notify: 3,
	mailbox_queue: 4,
	workflow_template_dispatch: 5,
	cmux_linked_view: 6,
	codex_lead_typing: 7,
	founder_consent_decision_mode: 8,
	quota_degraded_switch: 9,
	skill_framework_mode: 10,
};
const GROUP_OF = {};
{
	let cur = 1;
	for (const name of Object.keys(FLAGS)) {
		if (SECTION_STARTS[name]) cur = SECTION_STARTS[name];
		GROUP_OF[name] = cur;
	}
}

let md = "";
for (const [title, pred] of GROUPS) {
	const rows = snap.rows.filter(pred);
	if (!rows.length) continue;
	md += `\n#### ${title}(${rows.length} 条)\n\n`;
	md += "| 开关 | 在干嘛 | 现在 | 为什么是这个状态 | 改了怎么生效 | 裁决 |\n";
	md += "|---|---|---|---|---|---|\n";
	for (const r of rows) {
		const d = FLAGS[r.name];
		const why = d.note ? `${d.why}<br>▸ ${d.note}` : d.why;
		md += `| \`${r.name}\`<br><sub>${r.envVar ?? r.configKey}</sub> | ${d.plain} | ${currentValue(r)} | ${why} | ${activation(r)} | **${BUCKETS[d.bucket]}**<br><sub>${STRENGTH[d.strength]}</sub> |\n`;
	}
}

const counts = {};
for (const d of Object.values(FLAGS))
	counts[d.bucket] = (counts[d.bucket] ?? 0) + 1;
const strengths = {};
for (const d of Object.values(FLAGS))
	strengths[d.strength] = (strengths[d.strength] ?? 0) + 1;

const out =
	`<!-- GENERATED by build-audit.mjs — 不要手改这个文件,改 flags-data.js 然后重跑 -->\n` +
	`<!-- registry sha256: ${registrySha.slice(0, 16)} · 快照时间: ${snap.provenance.capturedAt} -->\n` +
	`裁决分布:${Object.entries(counts)
		.map(([k, v]) => `${BUCKETS[k]} ${v}`)
		.join(" · ")}\n\n` +
	`证据强度:${Object.entries(strengths)
		.map(([k, v]) => `${STRENGTH[k]} ${v}`)
		.join(" · ")}\n` +
	md;
fs.writeFileSync(path.join(HERE, "audit-table.md"), out);
console.log(
	`audit-table.md written: ${snap.rows.length} 条;裁决 ${JSON.stringify(counts)};强度 ${JSON.stringify(strengths)}`,
);
