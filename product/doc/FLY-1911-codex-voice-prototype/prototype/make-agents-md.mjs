/* FLY-1911:把「桥在会话创建时注入的那一份」原样写成 ~/.codex-honeylemon/AGENTS.md,
 * 让【文件夹本身携带身份】—— 任何用这个 CODEX_HOME 起的 Codex CLI,一开会话就是 Honey Lemon。
 * ⛔ 第一版故意不做任何「转换」:同一份载荷、两条投递路径,好做 A/B。
 * ⚠️ 载荷大小会随上游文件变(记忆索引 8/21 23:43 被压过 42KB→14KB)⇒ 每次跑都会打印实际字符数,别引用旧数字。 */
import { readFileSync, writeFileSync } from "node:fs";

const H = process.env.HOME;
const FILES = [
	[
		"identity",
		`/Users/xiaorongli/Dev/flywheel/.lead/flywheel-product-lead/identity.md`,
	],
	["记忆索引", `${H}/.claude/agent-memory/flywheel-product-lead/MEMORY.md`],
	["数据地图", `${H}/.fly1911/hl-datamap.md`],
	[
		"founder-only-authority 合同",
		`/Users/xiaorongli/Dev/flywheel/packages/teamlead/lead-rules-base/founder-only-authority.md`,
	],
];
const strip = (s) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
const head = `<!-- FLY-1911:这个文件让【文件夹本身携带身份】。
     内容 = 桥在会话创建时注入的那一份逐字相同,⛔ 不是新写的、也不是「转换」过的。
     由 make-agents-md.mjs 生成,别手改 —— 改上游那四个文件再重跑。 -->\n`;
let out = head;
for (const [name, f] of FILES) {
	try {
		const body = strip(readFileSync(f, "utf8")).trim();
		if (body) out += `\n\n<!-- ===== ${name} ===== -->\n\n${body}`;
	} catch (e) {
		console.log(`  ⚠️ 读不到 ${f}:${String(e.message).slice(0, 60)}`);
	}
}
const dest = process.env.AGENTS_DEST || `${H}/.codex-honeylemon/AGENTS.md`;
writeFileSync(dest, out);
console.log(`  写好 ${dest}:${out.length} 字符 / ${FILES.length} 个来源`);
