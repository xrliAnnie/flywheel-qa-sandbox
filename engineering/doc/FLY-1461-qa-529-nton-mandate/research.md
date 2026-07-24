# FLY-1461 QA executor 硬规矩:529 房真 Discord N-to-N — 调研

Issue: FLY-1461 (https://linear.app/geoforge3d/issue/FLY-1461/qa-executor-md-关单前必须跑-529-房真-discord-n-to-ndiscord-capable-单自记忆不靠-lead)
日期: 2026-07-24
基于: exploration.md

---

## 1. 目标文件与加载路径(已核实)

| 事实 | 证据 |
|------|------|
| Flywheel 自托管 QA runner 运行时加载 | `.flywheel/agents/engineering/qa-executor.md`(`.flywheel/config.yaml:166` `agents.qa.agent_file`) |
| runner spawn 时现读进 prompt | `packages/edge-worker/src/Blueprint.ts` `readAgentFile`(40k-char 截断;本文件仅 3.3KB,预算充足) |
| 根目录 `agents/qa-executor.md` | shipped, project-agnostic 默认版(`agents/qa-executor.md:7`),给**没自有 qa agent 的下游项目**用——**本单不动它**(529 是 Flywheel 内部设施,写进去=给下游无法执行的指令) |
| 现有锚点 | `.flywheel/agents/engineering/qa-executor.md:19` 已有 "Real-machine E2E for user-facing flows … Browser surfaces → Claude-in-Chrome",但没点名 529 / 无判据 / 无反模式 / 无豁免话术 |

## 2. 529 QA Room 机制(可直接引用的命令行事实)

### 2.1 `scripts/test-deploy.sh` — 部署候选 PR head 进隔离 slot(零碰生产)
- 用法头:`# FLY-96: Deploy a test slot (Bridge + Lead) for Discord E2E testing.`(`test-deploy.sh:2`);`Usage: scripts/test-deploy.sh [slot-number] [--digest <channel-id>]`(`:4`)。
- **候选 head 入口**:`--from-branch <branch>`(`test-deploy.sh:156-159`,默认 `main` `:198`)。把候选分支从 **sandbox remote clone** 进 slot,**不碰本地生产 checkout**:`git clone --branch "${FROM_BRANCH}" "${SANDBOX_REMOTE_URL}" "${HOST_REPO}"`(`:775`),落 `SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"`(`:599`)。
- **N-to-N 关键 flag**:`--extra-lead <slotId>:<deptLabel>`(`:170-173`,注释 `:138-140`)——"borrow another slot's bot/channel as a SECOND real Lead on THIS slot's single Bridge (N-to-N routing topology)"。
- `--mode slot|mirror|roundtable`(`:160-163`);`--alerts`(`:164-165`)= FLY-529 隔离告警镜像;`--lead-label`、`--extra-lead` 组合出多 Lead 拓扑。
- **零碰生产证据**:一切落 `SLOT_DIR`(`:599`);`discord-state/.env` 只写 test bot token(`:834-837`);`access.json` 只含测试频道(`:839,871`);HOST_REPO 的 `.flywheel/config.yaml` **只开 `approve_to_ship`**(`:795-830`);权威文档 `packages/qa-framework/README.md:343-349`("cwd 含 flywheel-test-slot → kind:sandbox,never pollutes production numbers")。
- **硬前置坑**(memory `reference_529_bridge_wipes_prod_delivery_secret`):起任何隔离 Bridge 必须设 `FLYWHEEL_DELIVERY_SECRET_PATH`,否则 `removeOrphanVersions` 清掉生产 delivery secret(潜伏损坏)。

### 2.2 slot → channel 映射(`scripts/test-slots.example.json`,真实在 `~/.flywheel/test-slots.json`)
- 4 slot:slot1=cos/`cos-test`/19871、slot2=lead/`product-lead-test`/19872、slot3=lead/`ops-lead-test`/19873、slot4=lead/`finance-lead-test`/19874。
- `mirrorChannel`=`test-core-mirror`;`roundtableChannel`=`test-leads-roundtable`(`hostSlot:1,memberSlots:[2]`);`alertChannel`=`test-flywheel-alerts`。
- 真实 id 先例(可引用):slot-2=`1493080993173737583`;529 QA guild=`1485787271192907816`;`#test-core-mirror`=`1504277055406211142`(FLY-944 §8)。

### 2.3 "真 Discord N-to-N" = 单 Bridge + ≥2 真 Lead
- 定义:`test-deploy.sh:138-140`("single Bridge … N-to-N routing topology");`engineering/doc/FLY-1189-qa-prc-nton-e2e/exploration.md:49`("N-to-N 拓扑 = 单 Bridge 多 Lead,不是多个 slot Bridge")。
- 两类语境:①路由拓扑(N 卡死 runner × N owner-Lead,`--extra-lead`);②lead-to-lead 真 @(多 Lead 共享频道互相真 `@`,FLY-944)。

### 2.4 触发真 runner / 组织多方交互的 driver
- `scripts/inject-linear-issue.sh <slot> <issue-id> [--role main|qa]`(`:25`)——注入 Linear run request → `/api/runs/start` → 真 Runner spawn 在 slot 的 sandbox clone(`:1-8`);**默认拒 mirror/roundtable slot**(`:41-70`)。
- `scripts/qa-fly-60-driver.sh`——Hard-Gate E2E driver,复用 `test-deploy.sh`/`test-teardown.sh`/`inject-linear-issue.sh`/`test-auto-approve.sh`(`:5-7`)。
- N-to-N 专用:`scripts/qa-fly-1189-nton-driver.sh`、`qa-fly-1189-room-smoke.sh`(`:67,92-94` 示范 `test-deploy.sh ${SLOT} --extra-lead ${EXTRA_SLOT}:${EXTRA_LABEL}`)、`qa-fly-1189-preflight.sh`、`scripts/lib/qa-fly-1189-assert.sh`。
- FLY-529 镜像:`scripts/qa-fly-529-roundtable-smoke.sh`、`qa-fly-529-alert-smoke.sh`、`scripts/lib/qa-fly-529-fire-bridge-alert.mjs`。
- 模块驱动真 Discord 模板(不起 Bridge,真编译 fn + 真 bot token + 真 thread POST/GET):`scripts/qa-fly-907-real-discord-e2e.mjs`(Annie 点名范例)、`qa-fly-1255/892/921/939/1048-real-discord-*.mjs`;lead-to-lead 真 @ 驱动 `engineering/doc/FLY-944-shared-channel-mention-gating/qa-529-nton-discord-driver.sh`。

### 2.5 Claude-in-Chrome 扮 founder
- **无自动 approve/ship 脚本**——founder-side 是**人工 gated**步骤(`scripts/qa-fly-60-driver.sh:18-21`:manual step gated behind `prompt_manual_step`,QA agent 用 Chrome MCP 驱动 Discord 交互后 `--evidence-only` 附截图)。
- QA agent 规矩:`.flywheel/agents/engineering/qa-executor.md:19`("Browser surfaces → Claude-in-Chrome");`packages/qa-framework/README.md:119`。
- 落盘证据 recipe:`doc/qa/qa-context.md:95-131`(claude-in-chrome `gif_creator` → `export download:true`,唯一原生落本地盘出口;founder 在她登录态 Chrome 全程实时看)。
- 前置健康检查:`chrome-repair` skill("as preflight before founder-path QA")。
- 叙事先例:FLY-944 §8(Claude-in-Chrome 只读截图 BEFORE→AFTER→VERDICT,Annie 登录态)。

## 3. 复用的先例措辞(定"语气+术语"基准)

| # | 出处 | 原文要点(复用) |
|---|------|----------------|
| 1 | `memory/feedback_qa_default_real_discord_e2e.md:3` | "所有独立 QA 默认必须跑真 Discord E2E(529 QA 房真机复现),不是可选项;判断不需要跑必须先问 Annie" |
| 2 | `.flywheel/agents/engineering/qa-executor.md:19` | 现有 "Real-machine E2E for user-facing flows … Claude-in-Chrome"(要升级挂靠的那条) |
| 3 | `lead-rules-base/default-enable-policy.md:28-31` | "Verify it really fires … a 529-Room run … 'Enabled' means observed firing, not key present" |
| 4 | `FLY-1189 exploration.md:15` | "必须真 Discord N-to-N E2E 才能放行" |
| 5 | `FLY-1041 qa-report.md:99` | "真 Discord N-to-N 验收 … 模块驱动(真编译 fn + 真 CommDB + 真 Discord thread,零 mock)" |
| 6 | `FLY-944 qa-report.md:91` | "merge 前就在 529 QA 房(隔离测试 guild,零碰生产配置)做真机 N-to-N" |
| 7 | `qa-framework/README.md:260,288,307` | "Roundtable/Alert Mirror (FLY-529) — pre-ship E2E" + "Byte-compat" |

## 4. 判据与豁免(Annie FLY-1461 直令 → 精确落文)

### 4.1 "Discord-capable" 判据(改动碰任一 → 必须跑 529 真 N-to-N)
Discord **发送 / relay / render(thread 标题·badge·置顶 header·状态行)/ founder 交互(approve·ship·gate 问答)/ roundtable / coordination(多 Lead·多 Runner Discord 协调)**。

### 4.2 豁免话术(不默认跳过)
纯 config / 无 Discord 面的单:**不静默省略**,而是在 QA 报告里**明说**"无 N-to-N 面,已 X 验"(X = 该单实际用的验证,如单测/CI/隔离 harness)。这忠实于 Annie 直令,也与先例 #1("例外需先问 Annie")兼容——Annie 已在 FLY-1461 里**预授权**"确无 Discord 面 → 报告里声明豁免"这一窄口径。

### 4.3 反模式(明令禁止)
**绝不**把 live e2e 写成"部署生产后再测 / 卡部署门"。529 房用 `--from-branch <候选分支>` 就能跑,**不需要部署生产**。把 529 N-to-N 说成"要等部署"是对 529 房存在意义的误解。

## 5. 守卫测试(实现期决策输入)
- 先例:`scripts/__tests__/test-pm-executor-contract.sh`(FLY-880 给 product-designer-executor 加的契约守卫,16 断言,接 CI)。
- 现状:**无** qa-executor.md 的内容守卫测试(§grep 未命中)。
- 结论:见 plan.md「范围决策」——本单**可选**加一条轻量 grep 守卫断言(锚定新规矩关键词存在),把"这条硬规矩存在于 runtime 文件"变成 CI 可回归,防未来编辑误删。倾向**加**(low-cost,防回归),但不阻塞主交付。

## 6. 待 plan.md 决策
1. 插入形态:新 `## Discord-capable changes …` 独立小节 vs 单条 bullet(倾向独立小节——规矩含判据+机制+反模式+豁免,一条 bullet 太挤)。
2. 是否加守卫测试(倾向加轻量 grep 断言 + 接 CI)。
3. 是否 cross-link 升级现有 `:19` 那条 "Real-machine E2E" bullet(倾向加一句指针,避免两处规矩打架)。
4. 精确 INSERT TEXT(中英混排,机制引用用相对脚本路径)。
