# FLY-722 合并 Sub → Tidal Echo — 探索

Issue: FLY-722 (https://linear.app/geoforge3d/issue/FLY-722/org-合并-sub-tidal-echo取消-sub-coresub-变-ariel-平级内容-lead归-triton)
日期: 2026-07-03
基于: 无

---

## 1. 目标（Annie 拍板，Tadashi 转达）

把独立 project **`sub`** 并进 **`tidal-echo`**。理由:Tidal Echo + Sub 都主要做视频/音乐内容业务,放同一 project 下让视频处理 knowledge 更好 share。

**org-first only** —— 本 issue 只做**组织层**合并;**物理 repo 合并(`/Dev/sub` codebase 搬进 tidal-echo)是单独 issue、延后**。

Annie 拍死的三条路由(照做,不猜):

1. **Sub issue → 改挂 `Tidal-Echo` 标签**,走 Triton 现有 front-door triage 流程。**不**给 Sub 单独 dept label。
2. **Asha = Triton 手下的 `sub-lead`,平行 Ariel**。内容管线**不并进** Ariel —— Asha 保留自己的内容管线,只是归属换到 Triton 之下。
3. **Sub 的 Linear issue 搬进 Tidal Echo Team**。

## 2. 当前结构(实测,非猜测)

### 2.1 `sub` 是独立 project

`~/.flywheel/projects.json` 里 `sub` 是一个独立 project entry:

- `projectName: "sub"`,`projectRoot: /Users/xiaorongli/Dev/sub`,`projectRepo: xrliAnnie/sub`
- 单一 lead:`sub-lead`(Asha),`department: content`,`canSpawnRunners: true`,`match.labels: ["Sub"]`,bot = `ASHA_BOT_TOKEN`
- `chatChannel: 1511267947551653918`(= **#sub**)
- `generalChannel: 1511889248003952641`(= **#sub-core**,project core room)
- `alertChannel: 1511267947551653918`(自身 = #sub)

### 2.2 `tidal-echo` 是 2 层 project(CoS + 内容 lead)

- CoS = **Triton**(`tidal-echo-cos-lead`,`canSpawnRunners: false`,`match.labels: ["Tidal-Echo-Triage"]`,`generalChannel/chatChannel = 1517041708855197908`)
- 内容 lead = **Ariel**(`tidal-echo-content-lead`,`canSpawnRunners: true`,`department: content`,`match.labels: ["Tidal-Echo"]`,`chatChannel = 1517041986358611998`)
- `projectRoot: /Users/xiaorongli/Dev/tidal-echo`,repo `xrliAnnie/tidal-echo`

合并后目标:Asha 变成 tidal-echo 下**与 Ariel 平级的第三个 lead**,同归 Triton。

### 2.3 Linear 归属

- Sub:team **"Personal"**(key 前缀 `LEARN-`)/ project **"Sub"** / label **`Sub`**。在跑的活:LEARN-141/142/143 等。
- tidal-echo:team **"Tidal Echo"**(key 前缀 `TIDE-`)。

### 2.4 Sub 的自治 cron(**关键,Asha 明确要保**)

**共 6 条 launchd cron**(不止 2 条 —— Codex R1 抓漏,详见 research §4b),都在 `/Dev/sub/content/scripts/` 下:

- 2 条 nightly:`com.flywheel.sub-create-nightly`(LEARN-122,1am `/sub-create`)+ `com.flywheel.sub-daily-loop`(LEARN-23/80,3:07am Suno daily-loop)。
- 4 条 growth-loop(LEARN-150,Annie 2026-07-01 全激活):`growth-learn`(4:30am)/ `growth-improve`(5am,**真建 Sub-scoped Linear issue + spawn Asha runner**)/ `growth-report`(5pm,发 #sub-core)/ `growth-retro`(Sun)。

**它们不走 front-door triage**:直接 `POST /api/runs/start` 带死参数 `projectName:"sub"` + `leadId:"sub-lead"` + 固定 cron-trigger issue UUID(LEARN-123 / LEARN-80 / growth 生成 issue),产出交付到 `#sub-core`(将被砍)。

这是 Asha 的**自治产出路径**,与 front-door(new/ad-hoc 活)是**两条独立的路**。

## 3. 涉及的每一面(变更清单)

| 面 | 现状 | 合并后 | 谁执行 |
|---|---|---|---|
| Discord `#sub-core`(core room) | sub project 的 generalChannel | **砍掉** | 🔴 Annie(Manage-Channels) |
| Discord `#sub`(内容 room) | sub-lead 的 chatChannel | 移进 tidal-echo section(channel id 不变) | 🔴 Annie(Manage-Channels) |
| Linear:Sub 的 issue | Personal team / Sub project / label `Sub` | 搬进 Tidal Echo team + 改 label `Tidal-Echo`(UUID 不变、key 变 TIDE-NN) | Runner(Linear API,founder 授权) |
| Linear:new Sub 活路由 | label `Sub` → sub-lead | label `Tidal-Echo` → Triton front-door | 配置 |
| `~/.flywheel/projects.json` | `sub` 独立 entry | 见 §4 岔口 | Runner(founder-gated live edit) |
| manifest / launchd lead | `sub-sub-lead` | 见 §4 岔口 | Runner(founder-gated) |
| 6 条 Sub cron(2 nightly + 4 growth-loop) | REPORT_CHANNEL / report channel=#sub-core、projectName=sub | 见 §4 岔口 + research §4b | Runner(founder-gated) |
| Sub codebase `/Dev/sub` | 独立 repo(2.5G) | **不动**(延后到单独 issue) | — |

## 4. 核心岔口(**已 surface 给 Tadashi,等拍板**)

**这是 Tadashi 明确提醒「别猜、有真岔口 surface 给我」的那个点(FLY-127 教训)。**

6 条 cron 都死写 `projectName:"sub"`,而 runner 要跑的 pipeline 代码(`suno-daily-loop.py`、sub-create brief、runlog、growth-*)**只存在于 `/Dev/sub`**。代码级已核实(`run-infra.ts`):`projectName → projectRoot`,且 **`LeadConfig` 没有 per-lead `projectRoot` 覆盖字段** —— 一个 ProjectEntry 里所有 lead 共享同一个 `projectRoot`。因此:

- 若**删掉 `sub` ProjectEntry**(把 sub-lead 塞进 tidal-echo)→ `projectName:"sub"` 不再解析 → cron run-start 失败 → **自治死**。
- 若 cron 改成 `projectName:"tidal-echo"` → runner 跑在 `/Dev/tidal-echo`(没有 pipeline 代码)→ **自治死**。
- 多条 cron(2 nightly + growth-report)把产出交付到 `#sub-core`,合并会**砍掉它**。

所以「Sub 不再是独立 project(删 entry)」与「org-first only(代码留 /Dev/sub)」在**当前 schema 下互相冲突**。

### 方案 A(推荐)—— 只在 org 层合并,保留 runtime binding

- **org 层合并**:Discord(砍 #sub-core、移 #sub 进 tidal-echo)+ Linear(Sub issue 搬 TIDE team、改 label `Tidal-Echo`)+ front-door(new Sub 活走 Triton)。
- **projects.json 保留一个 runtime `sub` ProjectEntry**(`projectRoot=/Dev/sub`),自治 cron **逻辑不动**;改动 = **迁走所有 #sub-core 消费者**(2 nightly 的 `REPORT_CHANNEL` + growth 的 report channel/policy,详见 research §4b)到 `1511267947551653918`(#sub,活、只是在 Discord 里换了父 category,id 不变)。`projectName` 仍 = `sub`。
- 「彻底删掉 sub entry」自然落到**延后的物理 repo 合并 issue**里。
- 语义:projects.json 的 `sub` entry 降格成一个**纯 runtime/codebase 绑定**,不再是 org 前门。这与「org-first only、physical repo merge 分开」**完全一致**。

### 方案 B(更重,与 org-first-only 相悖)

- 给 `LeadConfig` 加 `projectRoot`/`subdir` 覆盖字段,并穿到 `run-infra`/dispatcher/manifest → sub-lead 可以住在 tidal-echo entry 里、同时 runner 跑 `/Dev/sub`。
- 这是一次 **orchestrator schema 改动**,自带 design + code + review,超出「org-first only」的范围。

**Runner 建议 A。** 已把两方案 + 证据发 Tadashi(question `c4deeb6c`),等确认后定稿 plan.md。

## 5. 仍需 Annie/Triton 输入的开放项(plan 里会给建议)

1. **new Sub 活落到 Ariel 还是 Asha?** Annie 定:Sub 活改挂 `Tidal-Echo` label 走 Triton front-door。但 `Tidal-Echo` label 现在 match 的是 Ariel。若要 Triton 能把 content 活分给 Asha,需要明确分派机制(Triton 手动指派,还是给 Asha 一个可路由的 department/label)。**倾向:Triton 手动分派**(Asha 保留 `canSpawnRunners`,不给她抢 label,避免双 lead 抢同一 label 的 FLY-127 类事故)。
2. **Sub 在跑的 LEARN-141/142/143 过渡**:搬 team 会改 key(LEARN→TIDE)。在跑的 runner/thread 是否需要跟随?**倾向:先搬未开工的、在跑的做完再搬**,或 batch 搬 + 通知。
3. **Asha 的 alert 落点**:现在 `alertChannel = #sub`。合并后维持 #sub 还是走 tidal-echo core?**倾向:维持 #sub(id 不变)**。

## 6. 性质与流程

- **设计先行 + founder-gated cutover**:镜像 `doc/engineer/onboarding/tidal-echo/CUTOVER.md`。所有 live 动作(改 live projects.json、kill/relabel Asha launchd、Discord 重构、Linear 批量搬)都是**不可逆**,须 Annie 在场批准(FLY-175)。
- **Manage-Channels** 我没权限 → 到那步 surface 给 Tadashi 喊 Annie。
- **plan-first**:先给 Tadashi 过目 plan,再落地。本 runner 交付 = 设计文档 + founder-gated cutover 手册,**不**执行 live cutover。
