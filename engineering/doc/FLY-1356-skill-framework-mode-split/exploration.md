# FLY-1356 skill_framework_mode 三选一开关 + 生产分流 — 探索

Issue: FLY-1356 (https://linear.app/geoforge3d/issue/FLY-1356/eng-建三选一开关-skill-framework-modeabc-生产分流-瘦身第一刀的-build)
日期: 2026-07-20
基于: 无(上游输入 = `product/doc/FLY-1326-superpowers-vs-matt-skills/{research,plan}.md`,R6-approved)

## 问题陈述

Annie 批准的瘦身工程 v3 第一刀:把「Superpowers 留 / 换 Matt / 都不装」从纯 intel 变成可运行、
可回滚、可归因的生产实验基建。本单只建不 ship;入库/ship 仍是 Annie 最后 gate。

要建三样:

1. **枚举 flag `skill_framework_mode`**:三值互斥 `superpowers`(A=现状)/ `matt`(B)/ `bare`(C),
   **A = 默认 + kill-switch,秒级钉回现状不重启**。
2. **生产分流**:per-issue、派单时定死,dispatch 层 `hash(issueId) → {A,B,C}`(≈33/33/33,可复现,
   同一单从头到尾同一模式),指派记录在案可归因。
3. **评测复用 FLY-1260 框架**:阶段一 529 房排雷(盲评三硬指标),阶段二生产分流几天 + Annie 体感。
   本单为评测提供「可强制指定臂 + 可归因查询」的钩子,不另造评测系统。

## 上游输入(FLY-1326 intel 的硬结论,直接约束本设计)

- 「重」的真身 = SessionStart hook 常驻注入(1,370 tok)+ catalog metadata(408 tok);
  **省的 100% 来自 hook**。
- **三臂差异分两层,缺一层 B/C 就被污染**(FLY-1326 plan §3,Codex R5 抓出的关键漏层):
  - ① **prompt/模板层**:活跃直接耦合仅 2 个文件 —— `agents/generic-executor.md`(99–204 四步流)
    + `.flywheel/agents/engineering/designer-executor.md`(:68/:141 裸名 `brainstorming`);
    workflow 模板(3 文件/4 node)flag-gated default-off,评测期间必须保持 OFF。
  - ② **session-launch / 插件可见性层**:Superpowers 的 hook+catalog 是插件 SessionStart 注入,
    不受 prompt 层控制,必须逐 session 控制插件可见性。
- **B 臂钉死定义**(FLY-1326 plan §2):Matt commit `9603c1cc`,只 vendor 6 个 skill
  (`tdd`/`code-review`/`grilling`/`diagnosing-bugs` + `to-spec`/`to-tickets` 翻 model-invoked),
  可编辑 copy 形态(不用只读 plugin bundle),每个 frontmatter 改动 diff 留档。
- **C 臂**:纯自有机器(BRAINSTORM GATE → `/write-plan` → flywheel-tdd → Codex gate),本就存在。

## 依赖与排程

- ⚠️ **FLY-1335 先行**(PR #646,同 overnight batch):修法 = config 声明 `default_agent: general`
  (走 dispatcher 现成 Step 3a)+ ConfigLoader C-lite 警告,**AgentDispatcher 零代码改动**。
  落地后 Flywheel label 未命中 issue 落项目 `general-executor.md`(0 Superpowers prompt 耦合),
  shipped generic 只剩显式 `agentName:"generic"` 一条路。**本设计按 1335 落地后的派发语义写;
  开启 split 的前置条件 = 1335 已 live**。
- FLY-1299(第二刀)共用同一评测底座,顺序在后,本单不碰提示词清理。

## 关键机制发现(本 session 实测/实读,决定性地简化了设计)

1. **session-launch 层有现成通路(FLY-615 ponytail + FLY-751 slim-MCP 先例)**:
   `TmuxAdapter.buildClaudeArgs` 已支持 per-launch `--settings '{"enabledPlugins":{...}}'`
   (`ctx.enablePonytail` / `ctx.disabledPlugins` / `ctx.enabledPluginsExtra` 三源合并进单 flag;
   per-launch settings = 最高非-managed 优先级,真机 spike 已证 `false` 能阻止插件 MCP 子进程)。
2. **本 session 新增真机 spike(带阳性对照)**:
   - 对照组 `claude -p`(无 settings)→ 回答 **YES**(context 含 using-superpowers 注入)——尺子没坏;
   - 处理组 `claude -p --settings '{"enabledPlugins":{"superpowers@superpowers-dev":false}}'`
     → 回答 **NO** —— **per-launch disable 真能压掉 SessionStart hook 注入,不只是 MCP**。
   - 插件 key 实测 = `superpowers@superpowers-dev`(user scope,`claude plugin list` 双证)。
3. **归因记录有现成先例**:`sessions` 表已有 `ponytail_condition` / `design_backend` / `doc_tier` /
   `agent_match_method` 列;`design_backend` 的「admission 锁定 → phase/retry/rescue 线程传递」
   就是 mode 粘性传递要走的同一条轨。
4. **flag 基建有现成先例**:FLY-709 注册表(`packages/config/src/feature-flags/registry.ts`)支持
   enum flag + call_time readSite + `direct` toggle(需 live-observe proof test)→
   「秒级钉回、不重启」= flag console 直改 in-proc env + .env 双写,现成机制。

## 设计决策点

### D1. flag 形态:enum 四值(不是三值)

`FLYWHEEL_SKILL_FRAMEWORK_MODE` ∈ `superpowers | matt | bare | split`,默认 `superpowers`。

- 前三值 = **全局强制**该模式(kill-switch = 设回 `superpowers`,或直接 unset = 默认);
- `split` = 开启生产分流(hash 分桶)。
- 理由:issue 要「三值互斥 + A 默认 + kill」+「分流」两种状态机;单 enum 把「实验开/关」和
  「强制某臂」收进一个开关,kill 动作 = 一次 toggle,语义无歧义。
- 非法值 → **fail-closed 回 `superpowers`** + 告警(生产永不因 flag 拼错进实验臂)。

### D2. 分桶位置与解析顺序

run admission(runs-route → run-dispatcher,即 `design_backend`/`doc_tier` 同位点)一次解析、
一次落库,之后 phase/retry/rescue 只读 stamp:

1. flag ≠ `split` → **flag 值直接生效**(强制层,压过一切;override 参数此时 fail-loud 400);
2. flag = `split`:显式 per-dispatch override(529 评测用)> 同 issue 已有 stamp(粘性)>
   `hash(issueIdentifier) % 3`。
3. hash 用 Linear identifier 字符串(如 `FLY-1234`)的 sha256 取前 4 字节 mod 3 —— 可复现、
   人肉可验、≈33/33/33(附分布测试)。

### D3. 归因记录

`sessions` 新增两列:`skill_framework_mode TEXT` + `skill_framework_mode_via TEXT`
(`default | forced | hash | override | sticky | fallback_superpowers`)。所有 runner session 都记
(codex/agy/kimi 段也记,机制上 no-op,归因完整)。

### D4. 模式如何生效(两层各自的落点)

| 层 | A(superpowers) | B(matt) | C(bare) |
|---|---|---|---|
| 插件层(claude-tmux spawn) | **零改动,不加任何 enabledPlugins 条目**(字节兼容) | superpowers=false + matt-skills=true | superpowers=false |
| prompt 层 | 基准文件原样 | `<agent-file>.matt.md` 变体(仅 2 个耦合文件有) | `<agent-file>.bare.md` 变体(同上) |

变体解析规则:mode ∈ {matt,bare} 时先找同目录 `<name>.<mode>.md`,不存在回落基准文件
(绝大多数 agent 文件 0 耦合,天然共用基准)。B/C 变体全文冻结在仓里 = 臂定义即代码。

### D5. B 臂 vendor 形态:本地 plugin(ponytail 同款)

`vendor/matt-skills/` 进仓(6 skill 冻结 @ `9603c1cc` + 2 个 frontmatter flip diff 留档 + MIT
LICENSE 保留)→ `scripts/setup-matt-skills.sh` 装成 user-scope 本地 plugin 且
**settings.json 默认 disabled**(A/C session 永远看不见)→ B session 经 per-launch
`enabledPluginsExtra` 开启(FLY-1185 §2.7 已证 per-launch 正向 opt-in 压过机器级 default-off)。
readiness probe(ponytail 同款 `claude plugin details`)失败 → **该 session 回落 A + via
记 `fallback_superpowers`+ 告警**(绝不静默跑「残缺 B」污染臂)。

### D6. kill 语义的诚实边界

「秒级钉回」作用于**新派发 / 新 phase spawn / respawn**(解析是 call_time,flag console 直改即生效);
**存量 in-flight B/C session 的插件状态是 spawn 时定死的,不追改**(SessionStart 即使 compact 重触发,
per-launch settings 仍随该进程)。要立即清场 = ops 终止存量 runner(现有 close-runner 通路),
写进 runbook,不假装 flag 能改活进程。

### D7. Lead / 非 runner session 不碰

本 flag 只作用 Runner spawn 路径(TmuxAdapter);Lead(claude-lead.sh)、Bridge、CLI 均不读它。
Lead 的 Superpowers 消费不在本刀范围(那是 FLY-1299 之后的事)。

## 已发 Lead 的非阻塞 scope 问题

split 作用域 = 全 Bridge claude runner 派发(含 sub/joycon 等内容项目)vs 仅 Flywheel 项目?
issue 原文只说「dispatch 层 hash(issueId)」。**推荐 v1 全局**(实现最简、与原文一致、逐 session
记录可归因;内容项目 prompt 层 0 耦合,仅插件注入层变化)。question id `e2c42079`,不答复按推荐走。

## 否决的替代方案

- **CLAUDE_CONFIG_DIR 隔离实现 B/C**:重(auth/插件缓存全套复制)、碰凭据、FLY-572 证明能做但
  代价高;per-launch settings 一行 flag 等效且已被两个先例 + 本 session spike 三重证实。否决。
- **Matt skills 走 FLY-216 flywheel-skills 机器级分发**:机器级 = 所有 session 可见,直接污染
  A/C 臂 catalog(违反 FLY-1326 plan §3②)。否决;评测期用 default-disabled 本地 plugin。
  若 B 臂胜出、永久采纳,再走 FLY-216 正式 vendor(那时不再需要臂隔离)。
- **bool 两枚 flag(experiment_on + forced_mode)**:两 flag 组合出 8 态,kill 要动两处。否决。
- **hash 用 Linear UUID**:不可人肉验证,identifier 字符串更可审计。否决。
