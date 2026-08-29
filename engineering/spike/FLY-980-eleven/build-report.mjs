// FLY-980 S8 — founder 一页 HTML 生成:终选声线 mp3 以 data-URI 内嵌试听
// (托管 CSP 拒 media data-URI 时报告内有本地文件夹兜底指引)。
// usage: node build-report.mjs > ~/fly980-eleven/report/founder.html
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 24kbps mono 压缩版(publish-report 512KB 上限);原味样本在 audition/
const AUD =
	process.env.FLY980_AUDIO_DIR ??
	join(homedir(), "fly980-eleven", "audition-small");
const FINALS = [
	["Tadashi", "工程 Lead·男声专业", "tadashi", "cjVigY5qzO86Huf0OWal"],
	["Aunt Cass", "总管·女声温和", "cass", "EXAVITQu4vr4xnSDxMaL"],
	["Honey Lemon", "产品·女声活泼", "honeylemon", "cgSgspJ2msm6clMCkdW9"],
	["Mufasa", "陪练·男声沉稳", "mufasa", "JBFqnCBsd6RMkjVDRZzb"],
	["Belle", "生活助理·女声明亮", "belle", "Xb7hH8MSUJpSbSDYk0k2"],
	["Peter", "GeoForge·男声阳光", "peter", "bIHbv24MWmeRgasZH58o"],
	["Hiro", "Joy-Con·男声年轻", "hiro", "SOYHLrjzK2X1ezoPC6cr"],
	["Simba", "wildcard", "simba", "SAz9YHcvj6GT2YYXdXww"],
];

function audioTag(lead, vid, lang) {
	try {
		const b = readFileSync(join(AUD, lead, `${vid}-${lang}-final.mp3`));
		return `<audio controls preload="none" src="data:audio/mpeg;base64,${b.toString("base64")}"></audio>`;
	} catch {
		return "<em>样本缺</em>";
	}
}

const voiceRows = FINALS.map(([name, desc, lead, vid]) => {
	const note =
		lead === "simba"
			? '<span class="badge urgent">en女/zh男 变声·留 Annie 拍</span>'
			: lead === "peter"
				? '<span class="badge medium">阳光感欠佳·终审注意</span>'
				: '<span class="badge new">中英一致</span>';
	return `<tr><td><b>${name}</b><br><span class="dim">${desc}</span></td><td>${note}</td><td>${audioTag(lead, vid, "zh")}</td><td>${audioTag(lead, vid, "en")}</td></tr>`;
}).join("\n");

console.log(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>/eleven 可行性报告 — FLY-980</title>
<style>
body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;margin:0;padding:16px}
.wrap{max-width:960px;margin:0 auto}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:20px;margin:14px 0}
.card.green{border-left:4px solid #34c759}.card.amber{border-left:4px solid #ff9500}.card.blue{border-left:4px solid #007aff}
h1{font-size:24px;color:#1a365d}h2{font-size:18px;color:#1a365d;margin-top:0}
table{width:100%;border-collapse:collapse;font-size:14px}
th{color:#86868b;font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid #eee}
td{padding:8px;border-bottom:1px solid #f2f2f2;vertical-align:top}
.dim{color:#86868b;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600}
.badge.new{background:#e8f9ee;color:#34c759}.badge.urgent{background:#ffe9e7;color:#ff3b30}.badge.medium{background:#f2f2f4;color:#86868b}
.big{font-size:30px;font-weight:700;color:#1a365d}
audio{width:150px;height:32px}
code{font-family:'SF Mono',monospace;font-size:12px;background:#f2f2f4;padding:1px 5px;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.stat{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px;text-align:center}
@media(max-width:600px){audio{width:110px}}
</style></head><body><div class="wrap">
<h1>/eleven 完整线可行性 — go/no-go</h1>
<p class="dim">FLY-980 spike · 2026-07-08 · ElevenLabs Agents(耳+嘴) + Claude 订阅脑(Custom LLM) 真机实测</p>

<div class="card green"><h2>结论：条件 GO —— 链路全通，体验有天花板</h2>
<p><b>协议、打断、工具、多 Lead 声线、成本全部真机走通，无死刑项。</b>唯一的天花板是 claude -p 订阅脑的首 token（2-6s 波动）：靠「3 秒垫话 + 15s 平台等待窗」能把体验从"断线"救到"能用"——听感是<b>秘书式</b>（"稍等哈，我想一下"→ 几秒后给答案），不是 /gemini 那种即答。适合<b>汇报/问状态/讨论</b>场景；抢答式闲聊不是它的形态。要即答只有换 API 直连脑（按 token 计费，违订阅原则——这个取舍归你拍）。</p></div>

<div class="grid">
<div class="stat"><div class="big">179ms</div><div class="dim">平台+隧道基线首音<br>(echo 脑,5 轮中位)</div></div>
<div class="stat"><div class="big">~3.0s</div><div class="dim">用户听到垫话<br>(soft timeout 配置值)</div></div>
<div class="stat"><div class="big">4-6s</div><div class="dim">用户听到真答案<br>(claude 订阅脑,负载相关)</div></div>
<div class="stat"><div class="big">$0</div><div class="dim">订阅池内现金成本<br>(月池≈15 小时会话)</div></div>
</div>

<div class="card blue"><h2>三条语音线对比</h2>
<table><tr><th>维度</th><th>/glaw<br><span class="dim">Gemini耳+Claude脑</span></th><th>/gemini<br><span class="dim">Gemini 全包</span></th><th>/eleven<br><span class="dim">ElevenLabs+Claude脑</span></th></tr>
<tr><td>首音(答案)</td><td>秒级(同款 claude -p 脑瓶颈)</td><td><b>0.8-1.0s</b></td><td>垫话 3s / 答案 4-6s</td></tr>
<tr><td>脑</td><td>真 Flywheel 脑(人格+资料)</td><td>裸 Gemini(没有 Flywheel 记忆)</td><td><b>真 Flywheel 脑</b></td></tr>
<tr><td>声线</td><td>edge-tts 播音腔</td><td>30 prebuilt</td><td><b>海量库,per-Lead 差异化+克隆潜力</b></td></tr>
<tr><td>打断</td><td>自建</td><td>平台有</td><td><b>平台托管,~660ms 检测,自动中止脑请求</b></td></tr>
<tr><td>工具</td><td>自建</td><td>Gemini FC</td><td>平台工具真机通 + shim 内消化(安全边界在我们侧)</td></tr>
<tr><td>60min 成本</td><td>edge-tts 免费+脑订阅$0</td><td>~$0.68(gated×3)</td><td>订阅池内 <b>$0</b> / 超池后 ~$4.8</td></tr>
<tr><td>会话时限</td><td>—</td><td>15min(重连税)</td><td><b>平台托管,无 15min 墙</b></td></tr></table>
<p class="dim">/glaw、/gemini 列引用 FLY-968 实测(<24h)。</p></div>

<div class="card amber"><h2>体验实录（试听要点）</h2>
<p>① 说话结束 ~3s：垫话「稍等哈，我想一下。」响起（会话不死，这是生死开关——不开垫话平台 8s 就断线）；② 再等 1-3s：真答案播出，声线自然；③ 打断随时有效；④ 中英都听得懂、答得对，英文轮自动切英语。慢答案偶尔会"跨轮"（你已问下一句，上一句答案才到）——产品化要处理。</p></div>

<div class="card"><h2>8-Lead 终选声线（建议，终审权在你）</h2>
<p class="dim">同一 voice ID 中英双样本(multilingual_v2 高质量档)。⚠️ 发现：英文 premade 声线说中文可能变声（16 候选中 3 个），每把声线上岗前必须双语实测——以下已筛过。</p>
<table><tr><th>Lead</th><th>一致性</th><th>中文试听</th><th>英文试听</th></tr>
${voiceRows}
</table>
<p class="dim">试听不出声 = 托管 CSP 拒 data-URI 音频 → 本地打开 <code>~/fly980-eleven/audition/</code> 全量 66 条样本。</p></div>

<div class="card blue"><h2>成本两条线 + 本次消耗</h2>
<p>① <b>订阅池内</b>：Agents 会话实测走 credits 池（~177 credits/分钟），$22/月池 ≈ <b>15 小时会话，现金 $0</b>；脑侧 claude 订阅 $0 边际。② <b>超池后</b>：$0.08/min ≈ $4.8/小时。本次 spike 全程（35+ 轮会话 + 66 条声线合成）共耗 <b>6,095 credits ≈ 3.8% 月池</b>。</p></div>

<div class="card"><h2>建议的下一步</h2>
<p>1️⃣ 你试听终选声线 + 拍 Simba 变声去留；2️⃣ 拍「秘书式体验够不够」——够 → Honey Lemon 立 /eleven 产品 PRD（生产配方已验证：cascade 15s + 垫话 3s + workspace secret 鉴权 + 单 agent per-session override）；3️⃣ 「快 vs 订阅」取舍（API 直连脑可到 1-2s 但按 token 计费）。TTS-only 组件路线已按你的拍板否掉，未测。</p></div>

<p class="dim">全部证据/复现命令: engineering/doc/FLY-980-elevenlabs-tts-spike/evidence/ · 原始音频/数据: ~/fly980-eleven/</p>
</div></body></html>`);
