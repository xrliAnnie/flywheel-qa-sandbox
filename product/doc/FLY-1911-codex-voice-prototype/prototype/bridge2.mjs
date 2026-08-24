#!/usr/bin/env node
/*
 * FLY-1911 任务 3:把 v3 焊进 Discord 桥。同一个文件也还能跑 v2(RT_VERSION=v2)。
 *
 * 为什么 v3 值得焊:v2 是回合制 —— 它说话的时候不听你说,而且不会「先应一声」。
 * Annie 的三条抱怨(问完很久没动静 / 打不断它 / 声音卡顿)都指向这里。
 *
 * ⭐ 顺手解掉「卡顿」最大的嫌疑人:
 *   v2 的音频是 24k 单声道,Discord 是 48k 立体声 ⇒ 上一版要做两次朴素重采样(线性插值/左右取平均)。
 *   v3 本身就是 48k 立体声 Opus,和 Discord 一模一样 ⇒ **这一版一次重采样都不做。**
 *   · 上行(她 → 它):Discord 的 Opus 包**原样**塞进 RTP,连解码都不解。
 *   · 下行(它 → 她):Opus 解成 48k 立体声 PCM 直接播,不改采样率。
 *   ⚠️ 这是**消除了一个嫌疑人**,不等于卡顿一定好了 —— 卡顿本来就没量过,别当成已修。
 *
 * ⚠️ v3 的铁律(上一轮验出来的):麦克风一停就当被拔了,会话自己关。
 *   所以两个方向都必须是**常开流**:没声音要送静音,不能不送。
 */
import "libsodium-wrappers";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { PassThrough } from "node:stream";
import {
	createAudioPlayer,
	createAudioResource,
	EndBehaviorType,
	entersState,
	getVoiceConnection,
	joinVoiceChannel,
	StreamType,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import OpusScript from "opusscript";
import {
	MediaStreamTrack,
	RTCPeerConnection,
	RtpHeader,
	RtpPacket,
} from "werift";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"); // 剥掉终端颜色码;不写成正则字面量,是因为字面量里带控制字符会被 lint 拦下(行为等价,已实测)

/* ⭐ 状态显示(FLY-1911,她定的形态):把会话状态发到【文字频道】。
 * 这是【回归不是新设计】—— 照抄 2026-07-17 那套(listening / 双方转写 / 断线一行)。
 * 当【库】用,不起服务:直接 import voice-bridge 的构建产物。
 * TivSendDeps 是三个纯 async 函数,不依赖 voice-bridge 的会话或运行时。
 * ⚠️ 为什么它在 v2 上比 v3 更需要:v2 是回合制,想事情时一声不吭(实测约 20 秒静音)——
 *   在那 20 秒里,人分不出「在想」和「又断了」。稳定换来的是更长的等待,而等待需要被看见。 */
const { TivPresenter } = await import(
	"/Users/xiaorongli/Dev/flywheel/packages/voice-bridge/dist/discord/TivPresenter.js"
);

const GUILD = process.env.GUILD_ID,
	CHAN = process.env.VOICE_CHANNEL_ID,
	TV = process.env.TOKEN_VAR || "TEST_BOT_TOKEN_1";
const TEXT_CHAN = process.env.TEXT_CHANNEL_ID || ""; // 状态显示发到这里;不设=不显示(字节兼容旧跑法)
const VER = process.env.RT_VERSION || "v3";
const OUT = process.env.OUT || "T3-bridge",
	RUN_MIN = Number(process.env.RUN_MIN || 10);
const LIVE = process.env.LIVE_LOG || `${process.env.HOME}/.fly1911/live.jsonl`;
const RAW = `${OUT}-raw.jsonl`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一条日志同时写两处:归档给我看,live 给她的窗口看
const log = (d, o) => {
	const l = JSON.stringify({ t: new Date().toISOString(), dir: d, obj: o });
	appendFileSync(`${OUT}.jsonl`, `${l}\n`);
	try {
		appendFileSync(LIVE, `${l}\n`);
	} catch {}
	console.log(l);
};
const rawlog = (o) => {
	try {
		appendFileSync(
			RAW,
			`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`,
		);
	} catch {}
};

const env = Object.fromEntries(
	readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.trim().startsWith("#"))
		.map((l) => [
			l.slice(0, l.indexOf("=")).trim(),
			l.slice(l.indexOf("=") + 1).trim(),
		]),
);
const token = env[TV];
if (!token) {
	console.error(`${TV} 不在 .env`);
	process.exit(1);
}

/* ⭐ 不漂移的节拍器 —— 这是这一版最重要的修。
 * 上一轮实测:setInterval(fn,20) 在负载下真实周期是 ~25ms,
 * 于是 4 分钟里该发 12000 帧只发了 9578 帧 ⇒ **音频是按真实时间的 80% 在送的**。
 * 后果两条,而且正好对上她抱怨的两件事:
 *   · 上行:她的话被拉长/断续送进去 ⇒ ASR 听错(这次把"有几个 PR 还没合并"听成了"有个邮件")
 *   · 下行:播放流喂不满 ⇒ player 饿着 ⇒ 她耳朵里就是**卡顿**
 * 修法:按绝对时刻排程,落后了就在同一拍里补发,不让误差累积。
 */
function pace(everyMs, tick) {
	let next = Date.now() + everyMs;
	const loop = () => {
		const now = Date.now();
		let n = 0;
		while (next <= now && n < 10) {
			try {
				tick();
			} catch (_e) {}
			next += everyMs;
			n++;
		} // 落后就补,最多补 10 帧防雪崩
		if (next <= now) next = now + everyMs; // 落后太多就认栽,重新对表
		setTimeout(loop, Math.max(1, next - Date.now()));
	};
	setTimeout(loop, everyMs);
}
const paceStats = { outTicks: 0, inTicks: 0, startedAt: Date.now() };
/* 三个开关 —— 不是为了留配置,是为了能做对照实验:
 * 一次只动一个变量,才说得出「是哪一个在起作用」。 */
const SW = {
	pacer: process.env.SW_PACER !== "0", // 不漂移节拍器 vs 裸 setInterval
	jitter: process.env.SW_JITTER !== "0", // 上行抖动缓冲 vs 空了就塞静音
	depth: process.env.SW_DEPTH !== "0",
}; // 下行按缓冲深度补写 vs 一拍一帧
// 关掉节拍器时退回原来那个会漂移的做法,好让对照跑的是真实的旧行为
const schedule = (ms, fn) => (SW.pacer ? pace(ms, fn) : setInterval(fn, ms));

const opus = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const FRAME = 960; // 20ms @48k
const SILENCE_PCM = Buffer.alloc(FRAME * 2 * 2);
let SILENCE_OPUS = null;
try {
	SILENCE_OPUS = Buffer.from(opus.encode(SILENCE_PCM, FRAME));
} catch (e) {
	console.error("静音帧编码失败", e);
}

/* ---------- codex app-server ---------- */
const BIN = realpathSync(
	process.env.CODEX_BIN ||
		"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex",
);
const cx = spawn(BIN, ["--enable", "realtime_conversation", "app-server"], {
	stdio: ["pipe", "pipe", "pipe"],
});
let threadId = null,
	rpcId = 0,
	buf = "";
const waiters = new Map();
let answerSdp = null;
const stats = {
	version: VER,
	roomOpusIn: 0,
	rtpOut: 0,
	rtpIn: 0,
	pcmOutBytes: 0,
	userTx: [],
	asstTx: [],
	plans: [],
	runs: [],
	answers: [],
	handoffs: [],
	approvals: 0,
	errors: [],
	dcKinds: new Set(),
};
/* 会话锚的存放处。必须是模块级 —— 收 codex 事件的那个 handler 和造 manifest 的
 * clientReady 回调是两个作用域,M 在那边看不见。 */
const RT = {
	realtimeStartedAt: null,
	realtimeClosedAt: null,
	durationMs: null,
	closeReason: null,
};

/* 没配 TEXT_CHANNEL_ID 时是个不做事的壳 ⇒ 旧跑法逐字不变。 */
let tiv = { status() {}, caption() {}, card() {}, error() {} };
/* outcome:一个名字不会骗人的终局字段。
 * 教训来自 ok —— 它听起来像「这场成了」,实际只是「探针没提前退出」,
 * 于是两份换号后的失败 manifest 顶着 ok=True,谁扫文件都会读成「v3 换号后成功过两次」。
 * 文件才是被查的东西,文档是被跳过的东西 ⇒ 判据必须长在文件里。
 * died  = 会话自己断了(closed 且不是我们主动要求的)
 * alive = 跑到我们自己收尾时它还活着(没 closed,或 closed 的原因就是我们要求的) */
const outcomeOf = () =>
	!RT.realtimeClosedAt
		? "alive"
		: RT.closeReason === "requested"
			? "alive"
			: "died";

function onCodexEvent(m) {
	const meth = m.method;
	// ① 原样落盘(音频只留大小)—— 上一轮那个「grep 出来是 0」的洞,从这里堵死
	if (meth === "thread/realtime/outputAudio/delta") {
		rawlog({
			msg: {
				...m,
				params: {
					...m.params,
					audio: { len: (m.params?.audio?.data || "").length },
				},
			},
		});
	} else rawlog({ msg: m });

	if (meth === "thread/realtime/sdp") {
		answerSdp = String(m.params?.sdp || "");
		log("SDP", { chars: answerSdp.length });
		return;
	}
	// v2 才走这条(音频在 JSON-RPC 上);v3 的音频走 RTP
	if (meth === "thread/realtime/outputAudio/delta") {
		globalThis.__v2Audio?.(Buffer.from(m.params?.audio?.data || "", "base64"));
		return;
	}
	if (meth === "thread/realtime/transcript/done") {
		const p = m.params || {};
		(p.role === "user" ? stats.userTx : stats.asstTx).push(p.text);
		if (p.role === "user") {
			try {
				globalThis.__resetCue?.();
			} catch {}
		} // 新的一轮,提示音重新可响
		log("TX", { role: p.role, text: p.text });
		try {
			tiv.caption(
				p.role === "user" ? "user" : "assistant",
				String(p.text || ""),
			);
		} catch {}
		return;
	}
	if (meth === "thread/realtime/itemAdded") {
		const it = m.params?.item || {};
		if (it.type === "handoff_request") {
			stats.handoffs.push({ heard: it.input_transcript ?? null });
			log("HANDOFF", { 交办时用的转写: it.input_transcript ?? null });
		}
		return;
	}
	// ⭐ 任务 2 挖出来的那批 —— 她要的 indicator 全在这里,以前被 continue 掉了
	if (meth === "item/started" || meth === "item/completed") {
		const it = m.params?.item || {};
		if (it.type === "commandExecution" && meth === "item/started") {
			stats.runs.push(it.command);
			log("RUN", { command: it.command });
			return;
		}
		if (it.type === "reasoning" && meth === "item/started") {
			log("THINK", {});
			return;
		}
		if (it.type === "agentMessage" && meth === "item/completed") {
			if (it.phase === "commentary") {
				stats.plans.push(it.text);
				log("PLAN", { text: it.text });
				/* 状态行第二态:把它自己写的那句原样放上去 —— 不是我们编的文案,是它的真实意图。
				 * 原样不截断:48 条实测最长 96 字,离 Discord 2000 上限很远。*/
				/* ⚠️ 顺序要紧:先起等待音拿到它的名字,状态行那一行才带得上编号。
				 * (先前写反过,tiv.card 引用了还没声明的 bedName —— 那是 TDZ,会被 catch 吞掉,
				 *  表现是「状态行安静地不出现」。语法检查查不出这种,只有跑一次才看得见。)*/
				let bedName = "";
				if (process.env.BED === "1") {
					try {
						bedName = globalThis.__bed?.(true) || "";
						log("BED", { state: "on", kind: bedName });
					} catch {}
				}
				// 新预告作废旧预告 —— 一次等待里 PLAN 会连来好几条
				/* ⛔ 「把预告念出来」已停用 —— 她的原话:「我不是很喜欢现在这个系统合成音的效果,
				 *    那我们不用做这个了。还是像上一个版本一样,就直接用那个等待的音乐在中间」。
				 * ⚠️ 她的理由指向【嗓子】,她的决定砍掉的是【功能】—— 两者范围不同。
				 *    换一个好嗓子的念法【从来没测过】:那是「未追求」,不是「已否决」。
				 * 代码不删,默认关(SPEAK=1 才开),和短提示音同一处理。*/
				if (process.env.SPEAK === "1") {
					try {
						globalThis.__speak?.(it.text);
					} catch {}
				}
				/* ⛔ 那行「🎧 等待音:X」已拿掉 —— 她的原话:「文字显示的时候不需要写什么等待音 B」。
				 * 它当初是为了 A/B 交替时让她知道在听哪一个;B 定了、不再交替之后,
				 * 它就从「测试需要的脚手架」变成了「产品里的调试输出」。
				 * ⚠️ 段名仍然记进日志(BED 事件),只是不再出现在她眼前。*/
				try {
					tiv.card(String(it.text || ""));
				} catch {}
				/* ⛔ 短提示音已退役 —— 她的原话:「如果只是一个短声音,首先它根本不需要」。
				 * 代码不删:那条注音通道正是等待音在用的。默认关闭,CUE=1 才响(只给复现实验用)。*/
				if (process.env.CUE === "1") {
					try {
						if (globalThis.__playCue?.())
							log("CUE", { ms: 200, hz: 880, 说明: "空窗开头那一声" });
					} catch {}
				}
				return;
			}
			if (it.phase === "final_answer") {
				stats.answers.push(it.text);
				log("ANSWER", { text: it.text });
				try {
					tiv.card("🗣 正在回答");
				} catch {} // 状态行第三态
				if (process.env.BED === "1") {
					try {
						globalThis.__bed?.(false);
						log("BED", { state: "off" });
					} catch {}
				}
				if (process.env.SPEAK === "1") {
					try {
						globalThis.__speakStop?.("答案就绪");
					} catch {}
				}
				return;
			}
		}
		return;
	}
	if (meth === "account/rateLimits/updated") {
		log("QUOTA", m.params?.rateLimits || {});
		return;
	}
	if (meth === "mcpServer/startupStatus/updated") {
		if (m.params?.status === "failed") log("MCP", m.params);
		return;
	}
	if (
		meth === "item/commandExecution/requestApproval" ||
		meth === "item/fileChange/requestApproval"
	) {
		stats.approvals++;
		log("APPROVE", { reason: (m.params?.reason || "").slice(0, 90) });
		cx.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: m.id,
				result: { decision: "acceptForSession" },
			})}\n`,
		);
		return;
	}
	if (meth === "error") {
		const e = (m.params?.error?.message || m.params?.message || "").slice(
			0,
			200,
		);
		stats.errors.push(e);
		log("CODEX-ERR", { msg: e });
		return;
	}
	/* ⚠️ 会话锚,和进程锚分开记(Lead 复核时咬到的系统偏差):
	 * manifest 的 startedAt 记的是**进程/桥起来**(GATEWAY),比**会话起来**早约 2.8 秒。
	 * 谁拿 startedAt 去减死亡时刻,每一场都会一致地多出那 2.8 秒而不自知 ——
	 * 六场一致地偏,所以看不出来。⇒ 时长只许用 durationMs,它锚在下面这两个时刻上。 */
	if (meth === "thread/realtime/started") {
		RT.realtimeStartedAt = new Date().toISOString();
		log("CODEX", { state: "realtime started", version: m.params?.version });
	}
	if (meth === "thread/realtime/closed") {
		RT.realtimeClosedAt = new Date().toISOString();
		RT.closeReason = m.params?.reason ?? null;
		if (RT.realtimeStartedAt)
			RT.durationMs =
				Date.parse(RT.realtimeClosedAt) - Date.parse(RT.realtimeStartedAt);
		log("CODEX", {
			state: "realtime closed",
			reason: m.params?.reason ?? null,
		});
		try {
			tiv.error(`语音会话错误:${m.params?.reason ?? "connection closed"}`);
		} catch {}
	}
}
cx.stdout.on("data", (d) => {
	buf += d;
	let n;
	for (;;) {
		n = buf.indexOf("\n");
		if (n < 0) break;
		const l = buf.slice(0, n).trim();
		buf = buf.slice(n + 1);
		if (!l) continue;
		let m;
		try {
			m = JSON.parse(l);
		} catch {
			continue;
		}
		try {
			onCodexEvent(m);
		} catch (e) {
			rawlog({ handlerThrew: String(e) });
		}
		if (m.id !== undefined && waiters.has(m.id)) {
			waiters.get(m.id)(m);
			waiters.delete(m.id);
		}
	}
});
cx.stderr.on("data", (d) => {
	const s = d.toString().replace(ANSI, "").trim();
	if (s) rawlog({ stderr: s.slice(0, 300) });
});
const rpc = (me, pa) => {
	const i = ++rpcId;
	cx.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa })}\n`,
	);
	return new Promise((r) => {
		waiters.set(i, r);
		setTimeout(() => {
			if (waiters.has(i)) {
				waiters.delete(i);
				r({ __timeout: true });
			}
		}, 30000);
	});
};

/* ---------- Discord ---------- */
const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const dc = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

dc.once("clientReady", async () => {
	log("GATEWAY", { bot: dc.user.tag });
	const M = {
		issue: "FLY-1911",
		probe: "任务3 v3 焊进 Discord",
		startedAt: new Date().toISOString(),
		codexResolved: BIN,
		codexSha256: sha(readFileSync(BIN)),
		probeSha256: sha(readFileSync(new URL(import.meta.url))),
		version: VER,
		resampling: "无(48k 立体声全程)",
		/* 账号身份戳(Lead 裁定,第 6 次重试起固定字段):没有它,「这场跑在哪个账号上」
		 * 的唯一证人是别人的切号时间线,而不是证据文件自己 —— P-6 那次的枢轴正好悬在这上面。
		 * 只读、绝不写入任何令牌;读不到就如实记 unreadable,不猜。 */
		/* ⚠️ 只记有无,绝不记值。
		 * 为什么单独记这一格:账号戳读的是 auth.json **文件**,而「请求实际用了哪份凭据」
		 * 是另一件事 —— 文件里写 chatgpt,不代表这条 realtime 请求没走环境里的 API key。
		 * 又一次「字段名比它记录的东西强」:account 那格看起来像在回答凭据问题,其实没有。 */
		openaiApiKeyPresent: !!(process.env.OPENAI_API_KEY || "").trim(),
		/* 开跑瞬间还有没有【别的同类执行体】在场。
		 * 为什么必须是字段:上一批我用一个旧定时器污染了一整场,而事后判断「那一场干净吗」
		 * 只能靠回忆 —— 而回忆正好会偏向我们想要的方向。
		 * 记的是「除我自己之外」的桥/问话者/跑批脚本/sleep 计时器的 pid。
		 * ⚠️ 它只看得见【此刻在跑的】,看不见【还在 sleep 里武装着、稍后才醒的】——
		 * 这个盲点是真的,不许把 count:0 读成「这一场一定干净」。 */
		concurrentTasks: (() => {
			try {
				const out = execSync("ps -eo pid,command 2>/dev/null || true", {
					timeout: 4000,
				})
					.toString()
					.split("\n");
				const me = String(process.pid);
				/* ⚠️ 尺子必须只认【真在跑它】,不认【命令行里提到它】。
				 * 预演时当场抓到假阳性:别人跑一句 pgrep 去找这些名字,他自己的命令行里就有这些字,
				 * 于是被我算成一个并发任务。⇒ 只匹配「解释器 + 脚本路径」那种形态,
				 * 并显式排掉 grep / pgrep / ps / eval 这类只是提到名字的行。 */
				const mentionsOnly = /\b(pgrep|grep|ps -eo|eval|awk|sed)\b/;
				const reallyRunning =
					/(^|\s)(node|bash|sh|zsh)\s+\S*(bridge2\.mjs|asker2\.mjs|rate\.sh|selftest[^ ]*\.sh)(\s|$)|(^|\s)sleep\s+[0-9]{3,}(\s|$)/;
				const hits = out
					.filter((l) => reallyRunning.test(l) && !mentionsOnly.test(l))
					.map((l) => l.trim().split(/\s+/)[0])
					.filter((pid) => pid && pid !== me && /^\d+$/.test(pid));
				return {
					count: hits.length,
					pids: hits.slice(0, 12),
					armedSleepers: (() => {
						try {
							/* 补上那个盲点本身:武装中的长 sleep 计时器(pid + 已跑多久)。
							 * 只记「正在跑的」堵不住第 12 场那种坑 —— 害我们的正是一个还在 sleep 里、
							 * 稍后才醒的执行体。这一格就是为它开的。 */
							return execSync("ps -eo pid,etime,command 2>/dev/null || true", {
								timeout: 4000,
							})
								.toString()
								.split("\n")
								.filter(
									(l) =>
										/(^|\s)sleep\s+[0-9]{3,}(\s|$)/.test(l) &&
										!/\b(pgrep|grep|ps -eo|eval|awk|sed)\b/.test(l),
								)
								.map((l) => {
									const c = l.trim().split(/\s+/);
									return { pid: c[0], elapsed: c[1] };
								})
								.filter((x) => x.pid && x.pid !== me && /^\d+$/.test(x.pid))
								.slice(0, 12);
						} catch (e) {
							return [{ unreadable: String(e?.message || e).slice(0, 80) }];
						}
					})(),
					说明: "count/pids = 此刻在跑的同类执行体;armedSleepers = 还在 sleep 里武装、稍后会醒的(第 12 场正是被这种害的)",
				};
			} catch (e) {
				return { unreadable: String(e?.message || e).slice(0, 100) };
			}
		})(),
		/* 网络身份戳:出口 IP / 默认网关 / 默认网卡 MTU。
		 * 只记这三个 —— ⛔ 不记 SSID、不记任何凭据。
		 * 理由和账号戳同源:不盖上去的话,这一场事后无法自证「跑在哪条路上」,
		 * 而换网络恰恰是我们唯一能一刀切开的变量。取不到就记 unreadable,不猜。 */
		network: (() => {
			const sh = (c) => {
				try {
					return execSync(c, { timeout: 4000 }).toString().trim();
				} catch (_e) {
					return null;
				}
			};
			const gw = sh(
				"route -n get default 2>/dev/null | awk '/gateway:/{print $2}'",
			);
			const ifn = sh(
				"route -n get default 2>/dev/null | awk '/interface:/{print $2}'",
			);
			return {
				egressIp:
					sh("curl -s --max-time 6 https://api.ipify.org") || "unreadable",
				defaultGateway: gw || "unreadable",
				defaultIface: ifn || "unreadable",
				defaultIfaceMtu:
					(ifn
						? sh(`ifconfig ${ifn} 2>/dev/null | awk '/mtu/{print $NF}'`)
						: null) || "unreadable",
			};
		})(),
		account: (() => {
			try {
				const a = JSON.parse(
					readFileSync(`${process.env.HOME}/.codex/auth.json`, "utf8"),
				);
				return {
					authFile: `${process.env.HOME}/.codex/auth.json`,
					auth_mode: a.auth_mode ?? null,
					last_refresh: a.last_refresh ?? null,
				};
			} catch (e) {
				return {
					authFile: `${process.env.HOME}/.codex/auth.json`,
					unreadable: String(e?.message || e).slice(0, 120),
				};
			}
		})(),
	};

	/* 开跑就先落一个桩,别让 manifest 在整场跑期间不存在。
	 * 理由(Lead 实地撞上的):对外面的人来说「正在跑」和「东西丢了」长得一模一样,
	 * 他 17:17 去看的时候差点把一场正常进行中的跑读成证据丢失。
	 * 结束时 bye() 会整份覆盖掉它 ⇒ 文件里还留着 status:"running" = 这场没跑到收尾,
	 * 这正是硬崩时应该看到的样子,不是假象。 */
	try {
		writeFileSync(
			`${OUT}-manifest.json`,
			JSON.stringify({ ...M, status: "running" }, null, 2),
		);
	} catch {}

	await rpc("initialize", {
		clientInfo: {
			name: "fly1911-bridge2",
			title: "FLY-1911 v3 Discord",
			version: "0.0.2",
		},
		capabilities: { experimentalApi: true },
	});
	cx.stdin.write(
		JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) +
			"\n",
	);
	await sleep(400);
	const th = await rpc("thread/start", {});
	threadId = th?.result?.thread?.id;
	if (!threadId) {
		log("RESULT", { ok: false, where: "thread/start" });
		return bye(M);
	}

	/* ---- 建 realtime 会话 ---- */
	let pc = null,
		outTrack = null;
	const inOpusQ = []; // 房里来的 Opus 包(原样,不解码)
	const outPcmQ = []; // 要放给她听的 48k 立体声 PCM
	/* ⭐ 提示音:空窗开头「叮」一声,告诉她它开始干活了。
	 * 为什么只能这么做:push 进 outPcmQ 是【排队】不是【叠加】—— 想盖在它说话上面得做混音。
	 * 而空窗里队列本来就是空的 ⇒ 这个限制和这个需求恰好互补,提示音放在空窗开头正好只需要排队。*/
	const CUE = (() => {
		const sr = 48000,
			ms = 200,
			n = Math.round((sr * ms) / 1000),
			b = Buffer.alloc(n * 4),
			fade = Math.round(sr * 0.015);
		for (let i = 0; i < n; i++) {
			let g = 1;
			if (i < fade) g = i / fade;
			else if (i > n - fade) g = (n - i) / fade; // 两头淡入淡出,不然会「咔」一下
			const v = Math.round(
				Math.sin((2 * Math.PI * 880 * i) / sr) * g * 0.18 * 32767,
			);
			b.writeInt16LE(v, i * 4);
			b.writeInt16LE(v, i * 4 + 2); // 左右声道同一份
		}
		return b;
	})();
	let cueDoneThisTurn = false; // 一轮只响一声
	globalThis.__playCue = () => {
		if (cueDoneThisTurn) return false;
		cueDoneThisTurn = true;
		outPcmQ.push(CUE);
		stats.pcmOutBytes += CUE.length;
		return true;
	};
	globalThis.__resetCue = () => {
		cueDoneThisTurn = false;
	};

	if (VER === "v3") {
		pc = new RTCPeerConnection({});
		const dchan = pc.createDataChannel("oai-events");
		dchan.onMessage.subscribe((msg) => {
			let o;
			try {
				o = JSON.parse(String(msg));
			} catch {
				return;
			}
			stats.dcKinds.add(o.type);
			rawlog({ dc: o.type, peek: JSON.stringify(o).slice(0, 300) });
		});
		outTrack = new MediaStreamTrack({ kind: "audio" });
		pc.addTransceiver(outTrack, { direction: "sendrecv" });
		pc.onTrack.subscribe((track) => {
			track.onReceiveRtp.subscribe((rtp) => {
				stats.rtpIn++;
				if (rtp.payload && rtp.payload.length > 2) {
					try {
						const pcm = Buffer.from(dec.decode(rtp.payload));
						outPcmQ.push(pcm);
						stats.pcmOutBytes += pcm.length;
					} catch {}
				}
			});
		});
		const off = await pc.createOffer();
		await pc.setLocalDescription(off);
		const r = await rpc("thread/realtime/start", {
			threadId,
			transport: { type: "webrtc", sdp: pc.localDescription.sdp },
			outputModality: "audio",
			voice: process.env.RT_VOICE || "cove",
			version: "v3",
			delegationAckFiller: process.env.ACK_FILLER !== "0",
			codexResponseHandoffMode: process.env.HANDOFF_MODE || "thinking",
			realtimeStartInstructions:
				"你必须始终使用中文回答，无论用户用什么语言提问。回答简短、口语化，像在语音通话里说话。",
		});
		if (r?.error) {
			M.startRejected = r.error;
			log("RESULT", { ok: false, where: "realtime/start", error: r.error });
			return bye(M);
		}
		// 接完握手 —— 不接的话事件不会回流
		const s2 = Date.now();
		while (!answerSdp && Date.now() - s2 < 20000) await sleep(100);
		/* ⚠️ 这里的 answer 是 **SDP answer**(WebRTC 握手应答),不是「它答话了」。
		 * 旧字段名叫 gotAnswer,把这两件事撞在了一起 —— 一份链路全空的失败 manifest 顶上
		 * 写着 gotAnswer:true,差点让人据此叫 founder 进一个已经死掉的房间。
		 * 所以握手这个事实改叫 sdpAnswered,gotAnswer 让位给「它真的答话了」(见文件末尾推导)。 */
		M.sdpAnswered = !!answerSdp;
		if (!answerSdp) {
			log("RESULT", { ok: false, where: "没等到 SDP answer" });
			return bye(M);
		}
		await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
		const s3 = Date.now();
		while (pc.connectionState !== "connected" && Date.now() - s3 < 25000)
			await sleep(200);
		M.pcState = pc.connectionState;
		log("PC", { state: pc.connectionState });
		if (pc.connectionState !== "connected") {
			log("RESULT", {
				ok: false,
				where: "WebRTC 没连上",
				state: pc.connectionState,
			});
			return bye(M);
		}
	} else {
		const r = await rpc("thread/realtime/start", {
			threadId,
			transport: { type: "websocket" },
			outputModality: "audio",
			voice: process.env.RT_VOICE || "marin",
			version: "v2",
			/* 默认不变;RT_START_INSTR 只在「录音色样本」那种一次性用途里覆盖它。
			 * ⇒ 让每个音色在连上的那一刻就念同一句话,不经过对话 —— 对话里它可能拒绝照念。*/
			realtimeStartInstructions:
				process.env.RT_START_INSTR ||
				"你必须始终使用中文回答。回答简短、口语化。",
		});
		if (r?.error) {
			M.startRejected = r.error;
			log("RESULT", { ok: false, where: "realtime/start", error: r.error });
			return bye(M);
		}
	}

	/* ---- 进房 ---- */
	const g = await dc.guilds.fetch(GUILD);
	const conn = joinVoiceChannel({
		channelId: CHAN,
		guildId: GUILD,
		adapterCreator: g.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});
	try {
		await entersState(conn, VoiceConnectionStatus.Ready, 25000);
		log("JOINED", {});
	} catch (e) {
		log("RESULT", {
			ok: false,
			where: "discord",
			reason: String(e?.message || e),
		});
		return bye(M);
	}

	/* ---- 嘴:把它的声音放进房里(48k 立体声,不重采样) ---- */
	const speaker = new PassThrough();
	const F48 = Buffer.alloc(FRAME * 2 * 2);
	let outCarry = Buffer.alloc(0);
	globalThis.__v2Audio = (raw24) => {
		// v2 回退路径才需要:24k 单声道 → 48k 立体声
		const n = raw24.length / 2,
			o = Buffer.alloc(n * 2 * 4);
		let k = 0;
		for (let i = 0; i < n; i++) {
			const cur = raw24.readInt16LE(i * 2),
				nxt = i + 1 < n ? raw24.readInt16LE((i + 1) * 2) : cur,
				mid = (cur + nxt) >> 1;
			for (const v of [cur, mid]) {
				o.writeInt16LE(v, k);
				o.writeInt16LE(v, k + 2);
				k += 4;
			}
		}
		outPcmQ.push(o.subarray(0, k));
		stats.pcmOutBytes += k;
	};
	/* ⭐ 下行不能「一拍写一帧」。
	 * discord 的 player 是**按精确 50 帧/秒来拉**的,而我们的定时器实测只有 48 帧/秒(慢 4%)——
	 * 差这 4% 意味着**每秒有约 2 次它伸手来拿、缓冲里却是空的**,那就是一次断音。
	 * 修法:不数自己写了几帧,而是**把缓冲维持在目标深度**;它拉得快,我们就多写几帧补上。
	 * 这样即便定时器不准,player 也永远拿得到。 */
	/* 等待音:【连续生成】,不是循环一段样本 ⇒ 结构上就没有循环接缝这回事。
	 * 默认关着(BED_KIND 不设 = 逐字维持旧行为)。*/
	let bedGain = 0,
		bedPhase = 0;
	/* 取样函数搬到 beds.mjs —— 那样可以离线渲染【真正在跑的这份代码】来量它。
	 * ⛔ 下面这条混音路径没动:换的是放哪一段,不是怎么放。*/
	const { BEDS, BED_NAMES } = await import(
		new URL("./beds.mjs", import.meta.url)
	);
	/* 她挑了 3 和 4,要在真跑里都试 ⇒ 一场里交替:第一次等待放 3,第二次放 4,如此轮换。
	 * ⇒ 她一场就能直接对比,不用为此重开一场。*/
	/* ⭐ 她定了 B ⇒ 默认就放 B,不再交替。BED_ROTATE 还在,想再做 A/B 时用得上。*/
	const ROTATE = (process.env.BED_ROTATE || "boxB")
		.split(",")
		.filter((k) => BEDS[k]);
	let rotI = 0;
	/* ⭐「把预告念出来」:它自己的嗓子念不了(实测两次),所以用另一个合成嗓子。
	 * ⛔ 绝不进 outPcmQ —— 排队的东西不可能被瞬间切掉,而「能被瞬间切掉」是整条规则的前提。
	 * 规则:任何更新的话作废正在念的那句(答案作废预告,新预告也作废旧预告)。*/
	const { synth, findPauses } = await import(
		new URL("./speak.mjs", import.meta.url)
	);
	const SPK = {
		buf: null,
		pos: 0,
		gain: 0,
		stopping: false,
		cutAt: 0,
		pauses: [],
		gen: 0,
	};
	const spkActive = () => !!SPK.buf;
	globalThis.__speak = async (text) => {
		const my = ++SPK.gen; // 新的一句作废旧的,包括还在合成中的
		let pcm;
		try {
			pcm = await synth(String(text || ""));
		} catch (e) {
			log("SPEAK-ERR", { e: String(e?.message || e) });
			return;
		}
		if (my !== SPK.gen) return; // 合成期间又来了更新的一句 ⇒ 这一句作废
		SPK.buf = pcm;
		SPK.pos = 0;
		SPK.stopping = false;
		SPK.cutAt = 0;
		SPK.pauses = findPauses(pcm);
		log("SPEAK", {
			state: "start",
			秒: +(pcm.length / 4 / 48000).toFixed(1),
			停顿数: SPK.pauses.length,
		});
	};
	globalThis.__speakStop = (why) => {
		SPK.gen++; // 让还在合成的那一句也作废
		if (!SPK.buf || SPK.stopping) return;
		// 切在接下来 400ms 内的下一个停顿;没有就当场淡出
		const win = SPK.pos + 48000 * 0.4;
		const p = SPK.pauses.find((x) => x > SPK.pos && x <= win);
		SPK.cutAt = p ?? SPK.pos;
		SPK.stopping = true;
		log("SPEAK", { state: "stop", why, 切在: p ? "下一个停顿" : "当场淡出" });
	};
	const BED = { on: false, kind: ROTATE[0], sample: BEDS[ROTATE[0]] };
	globalThis.__bed = (on) => {
		/* ⚠️ 一次等待里 PLAN 可能来好几条(自测里两条只隔 1.3 秒)。
		 * 只有【从没响到响】那一次才换下一段 —— 否则她会听见等待音在中途自己变了,
		 * 而状态行也会在一秒内先写 3 再写 4。⇒ 换段以【等待】为单位,不以 PLAN 为单位。*/
		if (on && !BED.on) {
			BED.kind = ROTATE[rotI % ROTATE.length];
			BED.sample = BEDS[BED.kind];
			rotI++;
		}
		BED.on = !!on;
		return BED_NAMES[BED.kind] || BED.kind;
	};
	const TARGET_FRAMES = 5; // 100ms 余量:够吸收抖动,又不至于让延迟明显变大
	let starved = 0,
		wrote = 0;
	schedule(20, () => {
		paceStats.outTicks++;
		let guard = 0;
		const oneFrame = () => {
			while (outCarry.length < F48.length && outPcmQ.length)
				outCarry = Buffer.concat([outCarry, outPcmQ.shift()]);
			const hasVoice = outCarry.length >= F48.length;
			let frame;
			if (hasVoice) {
				frame = Buffer.from(outCarry.subarray(0, F48.length));
				outCarry = outCarry.subarray(F48.length);
			} else frame = Buffer.from(F48); // 常开流:没内容就送静音,流一断 player 就 idle 再也不消费
			/* ⭐ 等待音(她要的是「持续的声音」不是「响一下」)。
			 * 🔴 关键在于它【不进 outPcmQ】—— 进队列就是排队,会把它开口那句往后推。
			 *    这里是在【写出去那一刻】把等待音叠进当前这一帧,所以它结构上不可能延迟或盖住说话:
			 *    一旦队列里有话,gain 立刻往 0 走,几十毫秒内让干净。*/
			/* 预告:在写出去那一刻叠进当前帧 ⇒ 队列一有话就能瞬间让路,不会推迟答案 */
			if (SPK.buf) {
				const n = SPK.buf.length / 4;
				for (let i = 0; i < FRAME; i++) {
					if (SPK.pos >= n) {
						SPK.buf = null;
						SPK.gain = 0;
						break;
					}
					const t = SPK.stopping && SPK.pos >= SPK.cutAt ? 0 : 1;
					SPK.gain += (t - SPK.gain) * 0.0005; // 约 50ms 进出,不「咔」
					const v = Math.round(SPK.buf.readInt16LE(SPK.pos * 4) * SPK.gain);
					const o = i * 4;
					frame.writeInt16LE(
						Math.max(-32768, Math.min(32767, frame.readInt16LE(o) + v)),
						o,
					);
					frame.writeInt16LE(
						Math.max(-32768, Math.min(32767, frame.readInt16LE(o + 2) + v)),
						o + 2,
					);
					SPK.pos++;
					if (SPK.stopping && SPK.gain < 0.001) {
						SPK.buf = null;
						SPK.gain = 0;
						break;
					}
				}
			}
			if (BED.on || bedGain > 0.0001) {
				const target = BED.on && !hasVoice && !spkActive() ? 1 : 0; // 念的时候等待音让位
				for (let i = 0; i < FRAME; i++) {
					bedGain += (target - bedGain) * 0.06; // ~60ms 收敛,进出都不「咔」
					const v = Math.round(BED.sample(bedPhase++) * bedGain * 32767);
					if (bedGain > 0.0001) {
						const o = i * 4;
						frame.writeInt16LE(
							Math.max(-32768, Math.min(32767, frame.readInt16LE(o) + v)),
							o,
						);
						frame.writeInt16LE(
							Math.max(-32768, Math.min(32767, frame.readInt16LE(o + 2) + v)),
							o + 2,
						);
					}
				}
				if (target === 0 && bedGain <= 0.0001) bedGain = 0;
			}
			speaker.write(frame);
			wrote++;
		};
		if (SW.depth) {
			while (
				speaker.readableLength < TARGET_FRAMES * F48.length &&
				guard++ < 12
			)
				oneFrame();
		} else oneFrame(); // 旧行为:一拍只写一帧,播放器拉得比我们快就会饿着
		if (speaker.readableLength < F48.length) starved++; // 真饿着了,记一笔
	});
	globalThis.__outStats = () => ({
		播放缓冲写入帧: wrote,
		缓冲见底次数: starved,
	});
	const player = createAudioPlayer();
	conn.subscribe(player);
	player.on("error", (e) =>
		log("PLAYER-ERR", { msg: String(e?.message || e) }),
	);
	player.play(createAudioResource(speaker, { inputType: StreamType.Raw }));
	/* ⭐ 真正的尺子:missedFrames 是 discord 的播放器自己记的
	 * 「我到点伸手拿音频、结果没拿到」的次数 —— 每一次就是她耳朵里的一次断音。
	 * 我原先自己数的「缓冲见底」是我在**我的**时刻看到的,不是播放器的经历 ——
	 * 那是个近似,不是那个属性本身。这里换成播放器自己的账。 */
	globalThis.__missed = () => {
		const st = player.state;
		return {
			状态: st.status,
			播放器漏掉的帧:
				st.status === "playing" || st.status === "buffering"
					? (st.missedFrames ?? null)
					: null,
			已播放毫秒: st.resource?.playbackDuration ?? null,
		};
	};

	/* ---- 耳朵:房里的 Opus 包原样往上送(v3),或解码降采样(v2) ---- */
	const subs = new Set();
	conn.receiver.speaking.on("start", (uid) => {
		if (uid === dc.user.id || subs.has(uid)) return;
		subs.add(uid);
		log("SPEAKING", { userId: uid });
		const s = conn.receiver.subscribe(uid, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
		});
		s.on("data", (chunk) => {
			stats.roomOpusIn++;
			if (VER === "v3")
				inOpusQ.push(chunk); // ← 原样,不解码不重采样
			else {
				try {
					const pcm48 = Buffer.from(dec.decode(chunk));
					const n = pcm48.length / 4,
						o = Buffer.alloc(Math.floor(n / 2) * 2);
					let k = 0;
					for (let i = 0; i + 1 < n; i += 2) {
						const l = pcm48.readInt16LE(i * 4),
							r2 = pcm48.readInt16LE(i * 4 + 2);
						o.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r2) >> 1)), k);
						k += 2;
					}
					globalThis.__v2In?.(o.subarray(0, k));
				} catch {}
			}
		});
		s.on("end", () => {
			subs.delete(uid);
			log("STREAM-END", { userId: uid });
		});
	});

	/* ---- 上行常开流 ---- */
	if (VER === "v3") {
		let seq = (Math.floor(Date.now() / 7) % 30000) + 1,
			ts = 0;
		const ssrc = outTrack.ssrc || 123456789;
		/* 抖动缓冲:房里的包不会精准每 20ms 到一个,时快时慢。
		 * 一旦某一拍队列恰好是空的就塞静音,等于**在她一句话中间剪进一段空白** —— ASR 会听错。
		 * 所以:攒够 PREBUF 帧才开始放,放空了才回到静音状态。 */
		const PREBUF = 3;
		let draining = false;
		schedule(20, () => {
			paceStats.inTicks++;
			let payload;
			if (SW.jitter) {
				if (!draining && inOpusQ.length >= PREBUF) draining = true;
				if (draining && inOpusQ.length === 0) draining = false;
				if (draining && inOpusQ.length) {
					payload = inOpusQ.shift();
				} else {
					payload = SILENCE_OPUS;
					stats.silenceOut = (stats.silenceOut || 0) + 1;
				}
			} else {
				// 旧行为:队列这一拍恰好空了就塞静音 —— 等于在她一句话中间剪进空白
				if (inOpusQ.length) {
					payload = inOpusQ.shift();
				} else {
					payload = SILENCE_OPUS;
					stats.silenceOut = (stats.silenceOut || 0) + 1;
				}
			}
			if (inOpusQ.length > PREBUF * 4)
				inOpusQ.splice(0, inOpusQ.length - PREBUF * 2); // 攒太多说明追不上,丢老的保实时
			if (!payload) return;
			try {
				outTrack.writeRtp(
					new RtpPacket(
						new RtpHeader({
							version: 2,
							payloadType: 96,
							sequenceNumber: seq++ & 0xffff,
							timestamp: ts >>> 0,
							ssrc,
						}),
						payload,
					),
				);
				stats.rtpOut++;
			} catch (_e) {}
			ts = (ts + FRAME) >>> 0;
		});
	} else {
		const F24 = Buffer.alloc(24000 * 2 * 0.02);
		const inQ = [];
		let inCarry = Buffer.alloc(0);
		globalThis.__v2In = (b) => inQ.push(b);
		schedule(20, () => {
			if (!threadId) return;
			while (inCarry.length < F24.length && inQ.length)
				inCarry = Buffer.concat([inCarry, inQ.shift()]);
			let f;
			if (inCarry.length >= F24.length) {
				f = inCarry.subarray(0, F24.length);
				inCarry = inCarry.subarray(F24.length);
			} else f = F24;
			rpc("thread/realtime/appendAudio", {
				threadId,
				audio: {
					data: f.toString("base64"),
					sampleRate: 24000,
					numChannels: 1,
					samplesPerChannel: f.length / 2,
				},
			});
		});
	}

	/* 三个注入函数 —— TivSendDeps 要的就是这三个,不是 Discord 客户端。
	 * ⚠️ 每个都吞掉自己的失败:原设计的纪律是「会议不能因为一条字幕发失败就死」。 */
	if (TEXT_CHAN) {
		try {
			const tc = await dc.channels.fetch(TEXT_CHAN);
			const deps = {
				async send(text) {
					try {
						await tc.send(text);
					} catch (e) {
						log("TIV-ERR", {
							op: "send",
							e: String(e?.message || e).slice(0, 120),
						});
					}
				},
				async sendForId(text) {
					try {
						const m2 = await tc.send(text);
						return { messageId: m2.id };
					} catch (e) {
						log("TIV-ERR", {
							op: "sendForId",
							e: String(e?.message || e).slice(0, 120),
						});
						return { messageId: "" };
					}
				},
				async edit(id, text) {
					try {
						if (!id) return;
						const m2 = await tc.messages.fetch(id);
						await m2.edit(text);
					} catch (e) {
						log("TIV-ERR", {
							op: "edit",
							e: String(e?.message || e).slice(0, 120),
						});
					}
				},
			};
			tiv = new TivPresenter({
				deps,
				founderName: "Annie",
				assistantName: "助理",
				log: (l) => log("TIV", { line: String(l).slice(0, 160) }),
			});
			log("TIV", { line: `状态显示已接上,发往文字频道 ${TEXT_CHAN}` });
		} catch (e) {
			log("TIV-ERR", { op: "init", e: String(e?.message || e).slice(0, 160) });
		}
	}

	log("READY", {
		msg: "房里可以说话了",
		通道: VER,
		重采样: VER === "v3" ? "没有" : "有(24k↔48k)",
		runMinutes: RUN_MIN,
	});
	/* ⭐ 状态行跟着对话流往下走(她的原话:「对话不是一个一个往下走的吗?正常跟着对话流一个一个往下走就行」)。
	 * 为什么原来那样不行 —— 核过不是猜的:Discord 按【创建时间】排序,原地改不会把消息挪下来。
	 * 她那一场里,状态行发于 01:50:12、最后改于 01:56:08(全频道最新的内容),
	 * 却被压在最下面往上数第 25 条 —— 位置最老,内容最新,所以她看不到。
	 * ⇒ 改用发新消息。「不刷屏」那条给位置让路(她 7 月同意不刷屏时,那张截图是一问一答,
	 *    状态行本来就在最下面 —— 两条需求在那个退化场景里看起来相容,真实连续对话里才打架)。*/
	try {
		tiv.card("🎙 listening");
	} catch {}

	// v3 没有文字触发口(服务端支持的动作清单里没有 response.create),打招呼这一步只在 v2 有效。
	if (VER === "v2") {
		await sleep(1200);
		await rpc("thread/realtime/appendSpeech", {
			threadId,
			text: "我上线了，现在可以跟我说话。",
		});
	} else
		log("NOTE", {
			msg: "v3 是音频驱动的:没有文字触发口,所以不会自己先打招呼 —— 直接对它说话就行",
		});

	setTimeout(() => {
		const el = (Date.now() - paceStats.startedAt) / 1000;
		M.开关 = SW;
		M.播放缓冲 = globalThis.__outStats?.() ?? null;
		M.播放器自己的账 = globalThis.__missed?.() ?? null;
		M.节拍器 = {
			上行帧每秒: +(paceStats.inTicks / el).toFixed(2),
			下行帧每秒: +(paceStats.outTicks / el).toFixed(2),
			/* 判据带阈值(Lead 裁定后改的;旧写法拿 50.00 当线,墙钟排程永远压不到,一条永远
			 * 无法满足的验收线不是严格,是失效)。阈值 47.5 的出处:实测里逐字听对的臂全部
			 * ≥47.9(T3c/d/f/g/i 五臂),听错的两臂是 43.7(部分错)和 39.9(全错);真边界在
			 * 43.7 和 47.9 之间没量过,所以把线贴着已知好的那侧放。低于 47.5 = 红,别放行。 */
			达标线: 47.5,
			说明: "逐字听对的臂全部≥47.9,听错的臂≤43.7;真边界未量,线贴好的一侧。低于47.5会造成听错(卡顿另判)",
		};
		/* ⭐ ok / gotAnswer 从**实质内容**推导,不再独立写死。
		 * 旧写法:ok 无条件 true(只表示探针跑满没提前退出)、gotAnswer=有没有 SDP 应答。
		 * 两个都能在链路完全不通时显示成功 —— **一个在失败时显示成功的字段,
		 * 会让每一个下游读者做错决定。**
		 * 新判据:听见她说话(userTx)且它真的说了话(asstTx 或 answers)才算通。 */
		const heard = stats.userTx.length > 0;
		const spoke = stats.asstTx.length > 0 || stats.answers.length > 0;
		Object.assign(M, {
			ok: heard && spoke,
			gotAnswer: spoke,
			通不通: {
				听见她: heard,
				它说了话: spoke,
				说明: "ok 现在表示链路真的通了;sdpAnswered 才是 WebRTC 握手那件事",
			},
			roomOpusIn: stats.roomOpusIn,
			rtpOut: stats.rtpOut,
			rtpIn: stats.rtpIn,
			silenceOut: stats.silenceOut ?? 0,
			pcmOutBytes: stats.pcmOutBytes,
			userTranscripts: stats.userTx,
			assistantTranscripts: stats.asstTx,
			plans: stats.plans,
			runs: stats.runs,
			answers: stats.answers,
			handoffs: stats.handoffs,
			approvals: stats.approvals,
			codexErrors: stats.errors,
			dcEventKinds: [...stats.dcKinds].slice(0, 60),
		});
		log("RESULT", M);
		bye(M);
	}, RUN_MIN * 60000);

	function bye(m) {
		try {
			writeFileSync(
				`${OUT}-manifest.json`,
				JSON.stringify({ ...(m ?? M), ...RT, outcome: outcomeOf() }, null, 2),
			);
		} catch {}
		try {
			getVoiceConnection(GUILD)?.destroy();
		} catch {}
		try {
			pc?.close();
		} catch {}
		try {
			cx.stdin.end();
		} catch {}
		setTimeout(() => {
			try {
				cx.kill("SIGKILL");
			} catch {}
			dc.destroy();
			process.exit(0);
		}, 1200);
	}
	globalThis.__bye = bye;
});
function _bye(m) {
	try {
		if (m)
			writeFileSync(
				`${OUT}-manifest.json`,
				JSON.stringify({ ...m, ...RT, outcome: outcomeOf() }, null, 2),
			);
	} catch {}
	try {
		getVoiceConnection(GUILD)?.destroy();
	} catch {}
	try {
		cx.stdin.end();
	} catch {}
	setTimeout(() => {
		try {
			cx.kill("SIGKILL");
		} catch {}
		dc.destroy();
		process.exit(0);
	}, 1200);
}
dc.login(token).catch((e) => {
	console.error("登录失败", e);
	process.exit(1);
});
