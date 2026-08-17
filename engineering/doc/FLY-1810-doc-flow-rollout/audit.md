# FLY-1810 doc_flow 铺完再删 — Phase 1 审计与交付记录

Issue: FLY-1810 (https://linear.app/studio/issue/FLY-1810)
日期: 2026-08-16
基于: 无（doc tier = none；本文件是跨仓交付的落地记录，不是过程文档）

## 结论先行

Annie 的裁决是 **「铺完然后删」**，顺序不能反。本 lap 只交 **Phase 1（铺）**：

| 项目 | 铺前 | 动作 | 结果 |
|------|------|------|------|
| flywheel | ON (`engineering`) | 无 | 早已开 |
| joycon-typeless | ON (`product`) | 无 | 早已开 |
| tidal-echo | ON (`content`) | 无 | 早已开 |
| geoforge3d | OFF | 开（项目级；已 scaffold `product` / `operations`） | [GeoForge3D#281](https://github.com/xrliAnnie/GeoForge3D/pull/281) |
| growth | OFF | 开（项目级；已 scaffold `reflection` / `xuanxue`） | [growth#24](https://github.com/xrliAnnie/growth/pull/24) |
| personal-assistant | OFF | **not applicable** | 见 §3 |

**Phase 2（删 flag）不在本 lap**：Annie 要求中间有观察期（三个项目各跑一两单，确认过程文档
确实产出、没把流程卡住），一个 session 里做不到。Tadashi 已确认观察期按日历走，到期后在同一张
单上重派。

## 1. 机制事实（核实过，不是转述）

- **谁读这个 flag**：`packages/teamlead/src/bridge/run-infra.ts` 在项目 setup 循环里，
  按 `project.projectRoot + "/.flywheel/config.yaml"` 读一次，塞进 `createRunBlueprint`。
  `packages/edge-worker/src/Blueprint.ts` 在 `docFlowConfig?.enabled === true` 且非 QA runner
  时，把 DOC-FLOW 块 unshift 到 spawn prompt 最前。
- **什么时候读**：**Bridge boot 时**读一次，闭包持有。**不是 call_time。**
  ⇒ 配置落地后**必须重启 Bridge**，Runner 侧才生效（FLY-205 ship 窗教训，CLAUDE.md 已记）。
  顺带：`packages/config/src/feature-flags/registry.ts` 里 `doc_flow` 那行写的
  `timing: "call_time"` 与实况不符（已交 Tadashi 归档到尾款单，本单不动）。
- **第二个读点**：`packages/teamlead/lead-rules-base/doc-flow-rules.md` 让 dept Lead 自己
  读 `$FLYWHEEL_PROJECT_DIR/.flywheel/config.yaml` 判断是否适用。这一侧是 Lead 运行时现读 ——
  配置**先 pull 到 `$FLYWHEEL_PROJECT_DIR`** 之后，Lead 下一次 spawn 自查就能看到，
  **不用重启 Lead**（但 merge 本身不够，pull 那一步省不掉）。registry 只登记了 Blueprint 一个读点。
- **`default_department` 不是 flag 的一部分**：它是 `enabled: true` 时的**必填**伴生配置
  （`ConfigLoader` 强校验 `^[a-z0-9-]+$`）。它在 **`owningDept` 解析不出唯一具体字符串时**生效 ——
  即 `undefined`（没有任何 spawning Lead 的标签命中）**或** `"multiple"`（命中 2 个以上）。
  见 `resolveDocFlowDepartment()`（`Blueprint.ts:100`）：只有非 `"multiple"` 的字符串才胜出。
  `owningDept` 来自 `DepartmentRegistry`，`classifyIssue()` **只把 `canSpawnRunners` 的 Lead 纳入匹配**。
  正常 `/api/runs/start` 在 dept-scope enforcement 开启时通常会先拒掉多部门标签的 issue
  （`runs-route.ts:1567`），但 retry / legacy / enforcement-off 路径仍可能走到这个 fallback。
- **doc_flow 是 project-wide，不是部门 allowlist**：`resolveDocFlowDepartment()` 不校验
  「这个部门有没有被 scaffold」。今天 geoforge3d 只会产出 `product` / `operations`，
  growth 只会产出 `reflection` / `xuanxue`，是因为**当前 registry 里能 spawn 的 Lead 只有这些**；
  将来 registry 新增一个能 spawn 的 Lead，就会直接生成对应的 `<dept>/doc/`，不会报错也不会拦。

## 2. `sub` 口径对齐（issue 点名要求的那条）

`/Users/xiaorongli/Dev/sub/.flywheel/config.yaml` 里 `doc_flow.enabled: true`，看起来像
「第七个项目」。核实结果：**它不是项目，那份配置从来没被读过。**

- `~/.flywheel/projects.json` 里 `sub` 只出现在 **tidal-echo** 条目的 `memoryAllowedUsers`；
  `sub-lead` 是 **tidal-echo 项目**的一个 Lead，`projectRoot = ~/Dev/tidal-echo`。
- `run-infra.ts` 只遍历 `projects.json` 的项目、只按 `projectRoot` 读 config。
  `~/Dev/sub/.flywheel/config.yaml` 不在任何 `projectRoot` 上。
- 时间线对得上：`~/Dev/sub` 最后一次 commit 是 `c6cbad1 chore(FLY-722): migrate #sub-core ->
  #sub delivery channel (org merge)`，再往前第三条是 `f14eb39 chore: Tidal Echo pre-merge
  cleanup`。sub 已并入 tidal-echo。

⇒ **不存在盲区，flag 登记表的六个项目口径是对的。** `~/Dev/sub` 那份是 org-merge 后的遗留
死配置，清理与否不影响本单（已交 Tadashi 归档到尾款单）。

## 3. personal-assistant = not applicable

不是「懒得铺」，是**结构性开不了、也观察不了**：

1. `~/Dev/personal-assistant` **不是 git repo**（没有 `.git`）⇒ 没有可提 PR 的载体。
2. 它**没有 `.flywheel/` 目录**，更没有 `config.yaml`。
3. 它唯一的 Lead `belle-lead` 是 `canSpawnRunners: false` 的陪伴型 Lead
   ⇒ **永远不会开 Runner** ⇒ doc_flow 开或关都是零行为，Annie 要求的「跑一两单观察」
   在它身上做不到。

按 Tadashi 裁决：**如实标 not-applicable，不为了凑六分之六去造一个永远不会被读的文件。**
Tadashi 会在 thread 给 Annie 留异议窗。

## 4. 两条落地风险（必须在 merge 前处理，不是我能单方面解决的）

### 4.1 两个仓的 main 工作区都有未提交的 `config.yaml` 改动

GeoForge3D 和 growth 的 `main` 工作区里，`.flywheel/config.yaml` 都有**未提交**的本地改动：
各自新增了一个 `roles:` 块（runner model/effort/backend）+ 一批 prettier 重排。

- 这意味着 **Bridge 下次启动会读到的 canonical 工作区文件与 git 不同**。
  ⚠️ 注意边界：**当前正在运行的 Bridge 的内存快照我没有核实** —— 它持有的是它自己 boot 那一刻
  磁盘上的内容，我无法从「现在磁盘是脏的」反推「运行中的进程正在跑脏配置」。
- 冲突不是推测，是实测（Codex review 复核）：把两个 PR 的 config patch 分别对各自 main 工作区跑
  `git apply --check`，**两个都 exit 1**：
  - GeoForge3D：`patch failed: .flywheel/config.yaml:106`（main 落后 8 个 commit）
  - growth：`patch failed: .flywheel/config.yaml:68`（main 落后 6 个 commit）
- 好消息：两份脏配置各自都能通过真实 `ConfigLoader`；把现有 `roles:` 与本 PR 的 `doc_flow`
  在内存里合并后也能通过。所以这是**合并顺序问题，不是内容冲突**。

**operator 处理顺序（merge 之后、Bridge 重启之前）**：
1. 先把两个仓 main 工作区里那份未提交的 `roles:` 改动**单独存起来或独立提交** —— 不能粗暴丢弃。
   （GeoForge3D main 还有若干无关的 untracked 文件，别一把 `git add -A` 带进去。）
2. 更新 main。
3. 手工把 `roles:` 与 `doc_flow` 两个块合并到 `config.yaml`。
4. **再跑一次 `ConfigLoader.load()` 复验**——这一步是硬门：配置加载失败会让**整个项目**掉出
   Bridge runtime。
5. 才重启 Bridge。

两个 PR 描述里都写了警告。这份未提交工作不是我的，我没碰。

### 4.2 生效要重启 Bridge

merge 只是把配置写进 git。要让 Runner 真的拿到 DOC-FLOW 块，还要：
**`git pull` 到 Bridge 实际读的那份 checkout → 重启 Bridge**。
Lead 侧不用重启，但**也要等 pull** —— 它读的是 `$FLYWHEEL_PROJECT_DIR` 里的文件，
merge 到远端本身不改本机磁盘。

## 5. geoforge3d 的约定冲突（已就地处理）

`setup-doc-flow.sh` 的约定模板正常落在 `<dept>/doc/README.md`，但 geoforge3d 两个部门的
README 都已被无关文档占用（`product/doc/README.md` 是 GCP service-account 说明，
`operations/doc/README.md` 是本部门旧版约定），脚本的幂等检查**静默跳过**了写入。

处理：模板改落同目录的 `DOC-FLOW.md`，**不覆盖既有内容**。
准确说法：**去掉各自那段 FLY-1810 说明后，正文与脚本模板逐字一致**（Codex 实测两个文件
`TEMPLATE_BODY_MATCH=yes`）；整个文件不是逐字相同 —— 每份多一段说明为什么它叫 `DOC-FLOW.md`
以及旧目录不动。
另外 `product/doc/` 下已有 `backend/` `frontend/` `qa/` 等旧版分层 + 状态子目录结构，
与 doc-flow 的「一 issue 一文件夹、无状态子目录」不同 —— **旧目录原样不动**，
新规则只约束新建的 issue 文件夹。两份 `DOC-FLOW.md` 里都写了这句。

## 6. Phase 2（删 flag）交接清单

观察期过后要删的面。**先做 §6.0 的设计裁决，再动代码** —— 光删 `enabled:` 不等于删掉「关」这一态。

### 6.0 必须先裁的设计问题：absent / ENOENT 怎么办

这是 Codex review 抓出来的真洞。删掉 `enabled` 字段**不能自动证明「不再有关闭态」**，因为还有两条
隐式的 OFF 路径：

1. `packages/config/src/types.ts:632` 里 `doc_flow?: DocFlowConfig` 是**可选**的 ——
   项目 config 里整块不写，`docFlowConfig` 就是 `undefined`，Blueprint 照样不注入。
2. `packages/teamlead/src/bridge/run-infra.ts:968` 对 `config.yaml` **ENOENT 是容忍的**
   （catch 掉，项目零配置照跑）。

⇒ 不裁这一条，Phase 2 做完之后会**留下一个未登记的隐式 kill-switch**（删掉 doc_flow 块 = 关掉），
等于 flag 没真死，只是换了个不写在 registry 里的关法。

**建议裁法**（需 Tadashi / Annie 拍）：

1. **有 `config.yaml` 的项目** —— `doc_flow.default_department` **无条件必填、缺失即 fail-closed**
   （`ConfigLoader` throw）。
2. **整个 `config.yaml` 都不存在的项目** —— ENOENT 容忍**只对「确实没有任何 `canSpawnRunners`
   Lead」的注册项目**成立；**任何有能 spawn 的 Lead 的项目，缺 config 必须 fail-closed。**

第 2 条的收窄是 Codex R2 抓出来的：`run-infra.ts:991-998` 现在对**任何**项目的 ENOENT
都无条件吞掉，不检查它有没有 spawning Lead。如果只写「没 config 就容忍」，那**删掉整个
`config.yaml`** 依旧是一个未登记的静默关法 —— 洞只是从「删块」挪到了「删文件」。
不能拿「personal-assistant 现在不开 Runner」这个**当下事实**去推出一条**永久规则**。

选另一种裁法也行，但**必须显式裁**，不能默认。

**clause 2 的可实现性已核过（Codex R3），不需要新 plumbing**：ENOENT 的 catch 就在
`run-infra.ts:909` 的 `for (const project of projects)` 循环里，而 `ProjectEntry` 本身带
`leads`（`ProjectConfig.ts:253-258`），`setupRunInfrastructure` 收到的就是已验证的
`ProjectEntry[]`（`run-infra.ts:854-860`）。所以在 catch 现场就能判断这个项目有没有 spawning Lead：

```ts
const hasSpawningLead = project.leads.some((lead) => lead.canSpawnRunners !== false);
```

用 `!== false` 而不是 `=== true`，与 `department-registry.ts:55-67` 的 effective 语义一致
（缺省视为 true），也防住未经 normalization 的测试 fixture。有 spawning Lead 就重新抛 ENOENT，
没有就维持现状。改动只在这个 catch 的条件上，不用把 registry 数据新传进来。

⚠️ **这条裁决今天不能实施** —— Codex R2 用真 registry + 真 `ConfigLoader` 逐项目跑过：
`geoforge3d` 和 `growth` **现在都有 `config.yaml` 但没有 `doc_flow` 块**，
今天就把「无条件必填」落地会让这两个项目**直接 throw、掉出 Bridge runtime**。
这正是 Annie 那条「先铺后删」顺序的机制层理由 —— 铺开必须先合入生效，Phase 2 才做得。

### 6.1 生产代码面

| 文件 | 要做的事 |
|------|---------|
| `packages/config/src/feature-flags/registry.ts` | 删 `doc_flow` 那行（顺便：它现在的 `timing: "call_time"` 是错的，真实 readSite 是 `run-infra` / bridge boot —— 删之前先在交接里注明，别把错信息一起埋了） |
| `packages/config/src/ConfigLoader.ts` | 删 `doc_flow.enabled` 的存在性/类型校验；`default_department` 按 §6.0 裁决改成必填 |
| `packages/config/src/types.ts` | `DocFlowConfig.enabled` 去掉；`doc_flow?:` 的可选性按 §6.0 裁决处理 |
| `packages/edge-worker/src/Blueprint.ts` | 去掉 `enabled === true` 判断，改为无条件注入（QA runner 仍跳过） |
| `packages/teamlead/src/bridge/run-infra.ts` / `scripts/lib/setup.ts` | 传参不变；ENOENT 分支按 §6.0 裁决 |

**⚠️ 明确保留，不要一起删**：`docTier`（full / plan_only / none）整条 transport +
persistence 链路 —— schema、StateStore 列、retry、workflow dispatcher。三档机制在 flag 删掉之后
**继续存在**，删的只是「开/关」这个条件，不是档位本身。

### 6.2 规则 / 文档 / 模板面

| 文件 | 要做的事 |
|------|---------|
| `packages/teamlead/lead-rules-base/doc-flow-rules.md` | 删开头的「适用条件」自查块 |
| `packages/teamlead/lead-rules-base/default-enable-policy.md` | 例子里去掉 `doc_flow.enabled: true` |
| `packages/teamlead/lead-rules-base/README.md:53` | 同步措辞 |
| `packages/teamlead/scripts/claude-lead.sh:2508` | 那段注释里的旧自查语义 |
| `scripts/setup-doc-flow.sh` / `scripts/setup-new-project.sh` | 生成的配置块去掉 `enabled:`，只留 `default_department`（否则模板会持续再生产已死的字段） |
| `doc/engineer/onboarding/tidal-echo/config.yaml:49` | onboarding 示例同步 |
| 各项目 `.flywheel/config.yaml` | **五份**同步去掉 `enabled:` —— 有 config 的五个注册项目；personal-assistant 根本没有这个文件，不参与（见 §3） |

### 6.3 测试面（**会红，或者更糟：会 vacuous-green**）

标题这句是 Codex R2 改的 —— 我原来写「会红，必须一起改」，**不成立**：下面至少三个
shell 断言在 Phase 2 之后会**保持绿色**，**各自缺的负断言不是同一条**：
其中两个 config 脚本测试（`test-setup-new-project.sh` / `test-setup-doc-flow.sh`）
只正向查 `doc_flow:` 存在，从不反向断言 `enabled:` 已消失；
Lead 侧那个（`test-fly205-doc-flow-lead.sh`）假绿的原因不同 —— 它只检查 bundle 位置和 env，
根本不看规则文件里的 enablement 自查块在不在。
那种绿是假绿，会把「模板还在再生产已死字段」盖过去。

| 文件 | Phase 2 后的行为 | 要做的事 |
|------|-----------------|---------|
| `packages/config/src/__tests__/ConfigLoader.test.ts:1232` | 🔴 真会红 | 整个 `doc_flow validation` describe 块重写 |
| `packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts:247` | 🔴 真会红 | OFF sentinel（断言 disabled/absent → 字节兼容 prompt）—— 这条测试的**前提**就是要被删掉的那一态 |
| `packages/teamlead/src/__tests__/feature-flag-render.test.ts:149` | 🔴 真会红 | flag 渲染断言 |
| `packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts:60` | 🔴 真会红 | enablement 断言 |
| `scripts/__tests__/test-setup-doc-flow.sh:65-66, 88-96` | ⚠️ **假绿** | 只查 `doc_flow:` 存在，不查 `enabled:` 消失；fixture 里还留着 `enabled: false`。**要加反向断言** |
| `scripts/__tests__/test-setup-new-project.sh:55-60` | ⚠️ **假绿**（且我原清单**整个漏了**） | 同上；而生成器 `setup-new-project.sh:216-219` 现在仍写 `enabled: true`。**要加反向断言** |
| `packages/teamlead/scripts/test-fly205-doc-flow-lead.sh` | ⚠️ **假绿** | 只验 bundle 选择 / env，不验规则文件里的 enablement 自查是否已删。要补断言 |
| `engineering/doc/FLY-1260-harness-prompt-audit/harness/inventory.mjs:239` | ⚠️ 静默 | 手工 harness 仍传 `{enabled:true,...}`；`.mjs` 不吃 TypeScript 红灯。**要么迁移，要么明确冻结为历史快照、声明不属于验证面** |

Codex R2 另外核过：其余搜索命中的 Blueprint QA / skill-framework / founder-UX 测试只是用
`undefined // docFlowConfig` 占构造器位置，或只提 `docTier` transport，**不编码 flag 开关语义**，
Phase 2 不该动它们。

### 6.4 退役机制

`doc_flow` **没有 `envVar`**（`source: "project_config"`），所以 `RETIRED_FLAGS` 那套
tombstone 机制对它**不适用** —— 退役方式是删 registry 行 + 删「关」这条代码路径 + 按 §6.0
把隐式 OFF 路径一起收口。

## 7. 观察钟（Phase 2 的前置硬门）

Tadashi 指令 `[lead-instruction 1810-scope]`：本 lap 只铺 + **建立观察门与起钟条件**，不删任何东西。
措辞注意：**钟本身还没开始走**（起点见下），这一节交付的是判据和退出条件，不是「已经在观察了」。

### 钟什么时候开始走

**不是 PR 开出来的时刻。** doc_flow 是 Bridge boot 时读的，所以真正的起点是：

> 两个跨仓 PR 合入 → `git pull` 到 Bridge 实际读的那份 checkout → **Bridge 重启完成**

在那之前 Runner 侧零行为变化，观察无从谈起。

| 里程碑 | 时间 | 状态 |
|--------|------|------|
| 两个跨仓 PR 开出 | 2026-08-16 | ✅ 已完成 |
| PR 合入（founder-gated） | 待定 | ⏳ |
| Bridge 重启，配置生效 | 待定 | ⏳ **← 观察钟从这里开始走** |
| geoforge3d 跑满观察单量 | 待定 | ⏳ |
| growth 跑满观察单量 | 待定 | ⏳ |

接手 Phase 2 的人**必须先把上面三个「待定」填成实际日期**，否则没有证据证明观察期真的走过。

### 观察判据（Annie 原话：「确认过程文档确实产出、没有把流程卡住」）

对 **geoforge3d 和 growth 各自**，各观察 **1–2 个真实 issue 跑完**，逐条核：

| # | 判据 | 怎么算通过 | 怎么算不通过 |
|---|------|-----------|-------------|
| 1 | Runner 真的收到 DOC-FLOW 块 | 该 issue 的 spawn prompt 里能看到 `DOC-FLOW (project doc conventions...)` 开头那段 | 没有 ⇒ 配置没生效（多半是 Bridge 没重启，或 checkout 不是 Bridge 读的那份） |
| 2 | 文档真的产出了 | 合入的 PR 里有 `<dept>/doc/<ISSUE>-<slug>/` 目录，且按 Lead 判的档位齐全（full=三份 / plan_only=plan.md / none=零份且 Lead 在频道发过知会） | 目录不存在，或档位是 full/plan_only 却没有对应文件 |
| 3 | 落对部门目录 | `owningDept` 解析出**唯一具体字符串**时，目录部门段等于它；`owningDept` 为 `undefined` **或** `"multiple"`（2 个以上 spawning Lead 的标签同时命中）时，等于 `default_department` | 两种情形都不符 ⇒ 部门解析判断有误，需回头核。⚠️ 注意：多部门标签的 issue 落到 `default_department` 是**正确行为**，不要判成失败（Codex R2 抓出我这条原来写成「有标签用 owningDept / 无标签用 default」，会把正确的 `"multiple"` fallback 误判为不通过） |
| 4 | 抬头格式对 | 每份文档开头是「标题 + Issue 行 + 日期 + 基于」四行 | 缺行 / 带了版本号前缀或 Status 行 |
| 5 | **没把流程卡住** | 该 issue 从 dispatch 到 PR 的时长、gate 通过情况，与该项目铺开**之前**的同类 issue 相比没有明显变差；没有出现因文档要求导致的 stall / blocked / 反复返工 | 出现新的 stall，或 Runner 卡在写文档上 |
| 6 | Lead 侧知会义务履行 | 判 `plan_only` / `none` 档时，Lead 在部门频道发了知会消息（含 issue 号、档位、一句话理由、「有异议回这条」） | 没发 ⇒ Lead 侧规则没生效 |

判据 5 需要**铺开前的基线**才能比 —— 接手的人在填「Bridge 重启完成」那行时，
顺手记下两个项目各自最近几单的 dispatch→PR 时长，作为 before 基线。

### 退出条件

- **全部通过** ⇒ 报 founder，拿到点头后开 Phase 2（删 flag，按 §6 的面）。
- **任一条不通过** ⇒ **不进 Phase 2**。先修，或者把「为什么这个项目不该开」写清楚交给 Annie 重新裁
  —— 因为那会推翻「这不是刻意分布、只是 rollout 没做完」这个前提。
- **personal-assistant 不参与观察**（§3：结构性零行为，没有可观察的对象）。

## 8. 交付物

- GeoForge3D PR #281 — https://github.com/xrliAnnie/GeoForge3D/pull/281
- growth PR #24 — https://github.com/xrliAnnie/growth/pull/24
- 本仓 PR（审计记录 + progress ledger）

两个跨仓 PR 的 ship 审批各归各仓，merge 协调归 Tadashi。
