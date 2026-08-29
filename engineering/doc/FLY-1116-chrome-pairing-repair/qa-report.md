# FLY-1116 Claude-in-Chrome 全机断连 — QA 验收报告

Issue: FLY-1116
日期: 2026-07-10
基于: plan.md（§1 验收表 D1/D2、§3 D3 QA 合同）、exploration.md、research.md

## 0. QA 结论

**PASS。** 两个交付物均按 plan §1 验收标准 + §3 D3 QA 合同验证通过：

| 交付 | 验收标准 | 结果 |
|---|---|---|
| D1 修好 | 独立会话 A4 三连（list≥1 + tabs_context + navigate/read）+ 实例账号对齐确认 | ✅ 本 QA 会话现场活验，org-ID 铁证逐字一致 |
| D2 chrome-repair skill | flywheel-skills PR 五道门绿 + skill 自带 fixture 绿 + 诊断合同在隔离 mock 上稳定 | ✅ CI guard=SUCCESS、fixture 16/16、脚本 shellcheck 干净、真机只读运行合同成立 |

QA 阶段全程**非破坏**：只跑只读诊断、只读 MCP 三连、导航用自建干净 tab（example.com）并用后即关；**未对 founder profile 做任何修复动作**（无自然同型故障可归因，符合协议「绝不为凑实验主动破坏已修复的 profile」）。

## 1. D1 — 修好（真机活验，非仅复核）

D3 合同要求 D1 以「事故原始证据 + implement 阶段 A4 复核」为准。本 QA **超出该要求**：从一个**独立的、与实现阶段不同账号的 QA 会话**跑了一次全新的活 A4 三连 + org-ID 铁证，实时确认 founder-path 能力可用。

QA 会话身份（`~/.claude.json`）：personal1（account email 按 §9 redact），org `e312281b…`，env override=0。

**A4 三连（2026-07-10 ~15:58 PDT，本 QA 会话工具返回，最小化摘录）**：

1. `list_connected_browsers` → **1 个浏览器**：`isLocal:true`、`osPlatform:macOS`、`connectedAt=2026-07-10 15:08:16 PDT`（deviceId 已 redact）。=0 假阴性陷阱不适用（见下账号对齐）。
2. `tabs_context`（createIfEmpty）→ 正常返回 tab group + 可用 tab。
3. `navigate https://example.com` + `read_page` → 读回「Example Domain」标题与正文。通路健康。

**实例确认 = org-ID 铁证法（skill §4，无 founder 路径的唯一实锤）**：

- 从连上的浏览器 `navigate https://claude.ai/settings/account` 读页面 **Organization ID = `e312281b-1f25-4ff7-95c6-677c28bb52ed`**。
- 与 QA 会话 `~/.claude.json` `oauthAccount.organizationUuid = e312281b-1f25-4ff7-95c6-677c28bb52ed` **逐字一致** ⇒ CLI 凭据账号 == 扩展 token 账号（L2 维度对齐实锤）。

**关键观察（再次实证 skill 的核心教训）**：本次机器账号已从事故夜的 shopping、implement 阶段的 northwestern **再次漂移到 personal1**（Keychain mdat=20260710221401Z=当天新写）。健康的判据**不是「哪个账号」，而是「CLI == 扩展」是否对齐** —— 现两侧均在 personal1，故 list≥1 且三连全过。这正是 SKILL.md §0 铁律 2 的活样本。

## 2. D2 — chrome-repair skill（skills/generic/chrome-repair/）

canonical 落点 = flywheel-skills repo（PR #16，branch `FLY-1116-chrome-repair`），本仓仅设计文档（同 FLY-510 两仓模式，符合 research §7 决策）。

### 2.1 CI 五道门 + 门⑦ fixture（权威）

- PR #16 CI `guard`（skill-guard workflow）= **SUCCESS**；`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`。
- 独立审读 `scripts/skill-guard.sh`：门是**真门**，非空绿。门③ shellcheck 用 `find skills -path '*/scripts/*' -name '*.sh'`（只扫 scripts/ 下 shell），门⑦ 真 `bash chrome_diagnose_test.sh`。

### 2.2 fixture 测试（诊断合同在隔离 mock 上验证，D3 合同 step 2）

独立复跑 `tests/chrome_diagnose_test.sh`（自带 HOME 沙箱 + PATH shim，跨平台确定性）：**16/16 PASS**。覆盖：
healthy→READY/exit0；无/损坏/无 oauthAccount 的 `.claude.json`→DEGRADED；keychain 缺失×env override(0→DEGRADED / 1→READY+NOTE)；0 native host→DEGRADED；多 native host→READY；非 macOS→UNKNOWN；security 错误→UNKNOWN；**DEGRADED beats UNKNOWN**；**pgrep rc≥2→UNKNOWN（不误读为 0 hosts）**；**pgrep 锚定模式断言 `--chrome-native-host$`**（防事故里的 meta-observer 误命中）；**no-leak：token 值绝不出现在输出**（两处断言）。

### 2.3 真机只读运行（脚本本机子集合同成立）

`bash scripts/chrome-diagnose.sh`（只读，无 `security -w`、不打印 secret、不起 claude 会话）：
```
LOCAL_STATUS=READY  (exit 0)
EV cli_config=OK email=<redacted>
EV env_override=0
EV keychain=present mdat=<redacted>
EV native_host_count=1 pids=428
EV native_host pid=428 lstart=Fri Jul 10 15:08:16 2026
```
Banner 首行即声明 `LOCAL_READY != HEALTHY`（事故核心教训写在显著位置）。脚本 `shellcheck` 零 finding。

### 2.4 skill 内容合同抽查

- §0 三铁律（LOCAL_READY≠HEALTHY / 验收会话必须同账号 / founder 攒批）、§3 分支修复算法（先 L2 再 L1 ladder，R4 是 L2 分支不是 ladder 步）、§4 A4+org-ID 铁证法、§8 负知识（每条标注「机制推导 ≠ 实测证伪」）—— 与 plan §2.1 逐字一致，Codex R1/R2 已 fold（git log 实证）。
- 证明级别措辞诚实：L1 全程保持「最佳解释假说」，负知识的当晚观察标为「不可归因/假阴性」而非硬证伪 —— 与真实证据强度匹配，无过度声称。

## 3. 边界与遗留（不阻塞 ship）

1. **skill 是文档 + 只读脚本，无生产代码改动** ⇒ 回滚 = revert PR，零生产影响；不触碰生产 Bridge/Lead。
2. **Chrome 活连接是易变、账号作用域状态**，非本 PR 持久化的「修复位」。本 QA **实证的范围** = ①「修好当下可用」（活 A4 现场三连 + org-ID 铁证）②「skill 的**诊断合同**可照方复现」（fixture 16/16 + 真机只读脚本）。**本轮既无自然同型故障、也未注入**（协议禁止为凑实验破坏已修复 profile），故 skill 的**修复动作序（R4–R6/R2/升级）未被本轮实战演练**——其正确性仍以源码级机制推导 + implement 阶段闭环证据为据，非本 QA 现证。若日后账号再漂移或 worker idle 死，正是 skill 的用武场景，非本交付缺陷。
3. E3 存活窗 implement 阶段实测 `NOT_OBSERVED_WITHIN=4h24m`（未观察到 idle 断连）⇒ skill preflight 不写伪精确 idle 阈值，只保「每次 founder-path QA 开跑前 preflight」。本 QA 期间连接自 15:08:16 起单条未断，与该模型一致。
4. keepalive/断连监控、机器减负、上游 bug 报告 = plan §4 冻结解除后再立单，本 issue 不做。

## 4. QA 收尾（D3 step 5）

QA 期间**未触碰 founder profile 的修复态**（只做只读诊断 + 只读 MCP 三连 + 自建 example.com tab 用后即关）。收尾 LIVENESS-CHECK：`list_connected_browsers` 仍 ≥1（同一条 connectedAt=15:08:16 连接）。founder profile 状态未被本 QA 改变。
