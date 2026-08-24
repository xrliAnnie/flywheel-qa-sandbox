/* FLY-1911 实验 A 的中继:分身在沙箱里写不了 ~/.flywheel(comm 的库在那儿),
 * 所以它把要说的话写成文件,由我(沙箱外)替它送,并把回执写回它读得到的地方。
 * ⚠️ 这个中继是会安静死掉的东西 ⇒ 它必须留下两样:
 *   ① 每条消息的回执(它自己能看出没送成)
 *   ② 自己还活着的证据(心跳文件 + 起止各报 Lead 一次)—— ⛔ 不靠「没报错」推断它活着 */

import { execFileSync } from "node:child_process";
import {
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

/* ⭐ 核对只在这一侧做 —— 中继在沙箱外,分身够不着这里。
 * 它只能给一个【名字】,命令写死在下面这张很小的只读清单里。
 * ⛔ 清单外 ≠ 拒发:清单外一律照发,只是标「它说的,未核」。
 * ⚠️ 这张清单是会长的东西,每加一项都在扩大「我们替它背书」的范围 —— 加项要有理由。 */
const CHECKS = {
	runners: {
		说明: "哪些 runner 会话还活着",
		run: () =>
			execFileSync(
				"sqlite3",
				[
					"-readonly",
					`${process.env.HOME}/.flywheel/teamlead.db`,
					"select issue_id,status from sessions where status='running' order by issue_id;",
				],
				{ encoding: "utf8" },
			),
	},
	prs: {
		说明: "主仓还没合并的 PR",
		run: () =>
			execFileSync(
				"/opt/homebrew/bin/gh",
				[
					"pr",
					"list",
					"--repo",
					"xrliAnnie/flywheel",
					"--limit",
					"40",
					"--json",
					"number,title",
					"--jq",
					'.[]|"#"+(.number|tostring)+" "+.title',
				],
				{ encoding: "utf8" },
			),
	},
	head: {
		说明: "主仓最新一次提交",
		run: () =>
			execFileSync(
				"git",
				["-C", "/Users/xiaorongli/Dev/flywheel", "log", "--oneline", "-1"],
				{ encoding: "utf8" },
			),
	},
};
/* 拿它话里的编号/数字,去跟【我们自己跑出来的】那份输出核 */
function verify(msg, out) {
	const toks = [...new Set(msg.match(/FLY-\d+|#\d+|\d+/g) || [])];
	const lines = out.split("\n").filter((l) => l.trim()).length;
	const bad = toks.filter((t) => {
		if (out.includes(t)) return false;
		if (/^\d+$/.test(t) && Number(t) === lines) return false; // 合法的「共 N 个」
		return true;
	});
	return { ok: bad.length === 0, bad };
}
const DIR = `${process.env.HOME}/.fly1911/outbox`;
const BEAT = `${DIR}/.relay-alive`;
const CLI =
	"/Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js";
const EXEC = "voice-honeylemon-fly1911";
const log = (...a) =>
	console.log(`${new Date().toISOString().slice(11, 19)}Z`, ...a);

function tellLead(text) {
	try {
		const out = execFileSync(
			"node",
			[
				CLI,
				"ask",
				"--lead",
				"flywheel-product-lead",
				"--exec-id",
				EXEC,
				"--report",
				text,
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return { ok: true, out: String(out).trim() };
	} catch (e) {
		const merged = String(e.stdout || "") + String(e.stderr || "");
		/* nudge 失败但行留住 ⇒ CLI 退出码非 0 也可能其实入队了。据实转述,不替它判断。 */
		return { ok: false, out: merged.trim() || String(e.message) };
	}
}
writeFileSync(
	BEAT,
	JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
);
setInterval(
	() =>
		writeFileSync(
			BEAT,
			JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
		),
	5000,
);
log("中继起了 pid", process.pid, "看着", DIR);
tellLead(
	"【中继·上线】FLY-1911 语音分身的中继起来了(pid " +
		process.pid +
		")。它死了你会收到下线那条;⛔ 但如果它是被 kill -9 打死的,下线那条不会有 —— 那时看心跳文件 " +
		BEAT,
);

/* 开机对账:上一轮死在半路的消息会留下 .taken(认领了但没送出)。
 * ⚠️ 它们既没送出、也没有回执 —— 那正是「消息在中间没了」的形状。⇒ 起来先把它们捡回来重发。 */
try {
	for (const f of readdirSync(DIR).filter((f) => f.endsWith(".msg.taken"))) {
		renameSync(`${DIR}/${f}`, `${DIR}/${f.replace(/\.taken$/, "")}`);
		log("捡回上一轮死在半路的:", f.replace(/\.taken$/, ""));
	}
} catch {}

setInterval(() => {
	let files;
	try {
		files = readdirSync(DIR)
			.filter((f) => f.endsWith(".msg"))
			.sort();
	} catch {
		return;
	}
	for (const f of files) {
		const p = `${DIR}/${f}`,
			claim = `${p}.taken`;
		try {
			renameSync(p, claim);
		} catch {
			continue;
		} // 原子认领,防重复送
		let body = "";
		try {
			body = readFileSync(claim, "utf8");
		} catch {}
		/* 迟到标注:中继死过一轮再起来时,队列里可能压着旧消息 —— 别让它读起来像刚说的 */
		/* 先看它有没有要求核对(第一行 CHECK: <名字>) */
		let checkName = "",
			msgBody = body;
		const mm = body.match(/^CHECK:[ \t]*(.*?)\r?\n---\r?\n([\s\S]*)$/);
		if (mm) {
			checkName = mm[1];
			msgBody = mm[2];
		} else {
			const m2 = body.match(/^---\r?\n([\s\S]*)$/);
			if (m2) msgBody = m2[1];
		}
		let stamp = "",
			verdict = "未核";
		if (checkName && CHECKS[checkName]) {
			let out = "";
			try {
				out = CHECKS[checkName].run();
			} catch (e) {
				out = "";
				log("核对失败", checkName, String(e.message).slice(0, 120));
			}
			if (out) {
				const v = verify(msgBody, out);
				verdict = v.ok ? "已核" : "不符";
				stamp =
					"\n\n—— 【" +
					verdict +
					"】我们这一侧自己跑了「" +
					CHECKS[checkName].说明 +
					"」这条查询,结果如下(分身碰不到这一步)——\n" +
					out.split("\n").slice(0, 30).join("\n") +
					(v.ok
						? ""
						: "\n⚠️ 它话里这些编号/数字在上面这份结果里找不到:" +
							v.bad.join("、"));
			} else {
				verdict = "未核";
				stamp =
					"\n\n—— 【未核】它要求核对「" +
					checkName +
					"」,但我们这一侧跑那条查询失败了 ——";
			}
		} else if (checkName) {
			verdict = "未核";
			stamp =
				"\n\n—— 【未核】它要求核对「" +
				checkName +
				"」,但那不在我们的清单里(清单里只有:" +
				Object.keys(CHECKS).join(" / ") +
				")——";
		} else {
			stamp = "\n\n—— 【未核】这是它说的,我们这一侧没有可以重查的来源 ——";
		}
		let ageMin = 0;
		try {
			ageMin = Math.round(
				(Date.now() - Number(statSync(claim).mtimeMs)) / 60000,
			);
		} catch {}
		const late =
			ageMin >= 5
				? `\n\n⚠️ 迟到:这条在队列里压了约 ${ageMin} 分钟(中继当时不在),不是刚说的。`
				: "";
		const r = tellLead(
			"【语音分身·Honey Lemon】(会议室里那个,不是 runner)\n\n" +
				msgBody.trim() +
				stamp +
				late,
		);
		const receipt = {
			at: new Date().toISOString(),
			送出: r.ok,
			核对: verdict,
			原样输出: r.out.slice(0, 500),
		};
		writeFileSync(
			p.replace(/\.msg$/, ".receipt"),
			JSON.stringify(receipt, null, 1),
		);
		log(r.ok ? `送出 ${f}` : `⛔ 没送出 ${f} :: ${r.out.slice(0, 120)}`);
		try {
			unlinkSync(claim);
		} catch {}
	}
}, 2000);
const bye = (why) => {
	try {
		tellLead(
			"【中继·下线】FLY-1911 中继退出(" +
				why +
				")。⚠️ 在它重新起来之前,分身说的话到不了你这里。",
		);
	} catch {}
	try {
		unlinkSync(BEAT);
	} catch {}
	process.exit(0);
};
process.on("SIGTERM", () => bye("SIGTERM"));
process.on("SIGINT", () => bye("SIGINT"));
