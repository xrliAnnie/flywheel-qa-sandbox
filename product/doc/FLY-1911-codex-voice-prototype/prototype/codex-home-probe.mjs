/* FLY-1911:量「会话的写入到底落在哪个 codex home」。
 * ⛔ 只读:memories 库一律先复制到临时文件再读,绝不打开原库(它可能正被别的进程用)。
 * 用法:node codex-home-probe.mjs snapshot <标签>
 *       node codex-home-probe.mjs diff <标签A> <标签B>
 */
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

const HOME = process.env.HOME;
const OUT = `${HOME}/.fly1911/homeprobe`;
const HOMES = {
	公共: `${HOME}/.codex`,
	infra_bot: `${HOME}/.codex-infra-bot`,
	分身专属: `${HOME}/.codex-honeylemon`,
};
function memRows(db) {
	if (!existsSync(db)) return null;
	const tmp = `/tmp/fly1911-hp-${Date.now()}.sqlite`;
	try {
		copyFileSync(db, tmp);
		const q = (sql) =>
			execFileSync("sqlite3", [tmp, sql], { encoding: "utf8" }).trim();
		const tables = q("select name from sqlite_master where type='table'")
			.split("\n")
			.filter(Boolean);
		const rows = {};
		for (const t of tables)
			rows[t] = Number(q(`select count(*) from ${t}`) || 0);
		return rows;
	} catch (e) {
		return { 读不了: String(e.message).slice(0, 80) };
	} finally {
		try {
			unlinkSync(tmp);
		} catch {}
	}
}
function dirFacts(p) {
	if (!existsSync(p)) return null;
	const files = [];
	const walk = (d, depth) => {
		if (depth > 3) return;
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const f = `${d}/${e.name}`;
			if (e.isDirectory()) walk(f, depth + 1);
			else
				files.push({
					f: f.replace(p, ""),
					m: Math.round(statSync(f).mtimeMs),
					s: statSync(f).size,
				});
		}
	};
	try {
		walk(p, 0);
	} catch {}
	files.sort((a, b) => b.m - a.m);
	return { 文件数: files.length, 最近三个: files.slice(0, 3) };
}
function snap() {
	const o = { at: new Date().toISOString(), homes: {} };
	for (const [name, h] of Object.entries(HOMES)) {
		o.homes[name] = {
			存在: existsSync(h),
			memories: memRows(`${h}/memories_1.sqlite`),
			archived_sessions: dirFacts(`${h}/archived_sessions`),
			sessions: dirFacts(`${h}/sessions`),
			history: existsSync(`${h}/history.jsonl`)
				? statSync(`${h}/history.jsonl`).size
				: null,
		};
	}
	return o;
}
const [, , cmd, a, b] = process.argv;
mkdirSync(OUT, { recursive: true });
if (cmd === "snapshot") {
	const o = snap();
	writeFileSync(`${OUT}/${a}.json`, JSON.stringify(o, null, 1));
	console.log(`快照 ${a} 存好了 (${o.at})`);
	for (const [n, v] of Object.entries(o.homes))
		console.log(
			`  ${n}: memories=${JSON.stringify(v.memories)} archived=${v.archived_sessions?.文件数 ?? "-"} sessions=${v.sessions?.文件数 ?? "-"}`,
		);
} else if (cmd === "diff") {
	const A = JSON.parse(readFileSync(`${OUT}/${a}.json`, "utf8"));
	const B = JSON.parse(readFileSync(`${OUT}/${b}.json`, "utf8"));
	console.log(`${a}(${A.at}) → ${b}(${B.at})`);
	for (const n of Object.keys(A.homes)) {
		const x = A.homes[n],
			y = B.homes[n];
		const parts = [];
		for (const t of new Set([
			...Object.keys(x.memories || {}),
			...Object.keys(y.memories || {}),
		])) {
			const d = (y.memories?.[t] ?? 0) - (x.memories?.[t] ?? 0);
			if (d) parts.push(`memories.${t} ${d > 0 ? "+" : ""}${d}`);
		}
		for (const k of ["archived_sessions", "sessions"]) {
			const d = (y[k]?.文件数 ?? 0) - (x[k]?.文件数 ?? 0);
			if (d) {
				const old = new Set((x[k]?.最近三个 || []).map((f) => f.f));
				const neu = (y[k]?.最近三个 || [])
					.filter((f) => !old.has(f.f))
					.map((f) => f.f);
				parts.push(
					`${k} ${d > 0 ? "+" : ""}${d}${neu.length ? " 新增:" + neu.join(",") : ""}`,
				);
			}
		}
		if ((y.history ?? 0) !== (x.history ?? 0))
			parts.push(`history ${x.history}→${y.history}`);
		console.log(`  ${n}: ${parts.length ? parts.join(" · ") : "没变 ✅"}`);
	}
}
