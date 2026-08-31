# FLY-2121 workflow 命名统一(Option 2 v2 两层注册表)— 实施计划

Issue: FLY-2121 (https://linear.app/geoforge3d/issue/FLY-2121/命名-workflow-shapenoderole-三处-design-命名互撞-后端改名-稳定-id-与展示名分离)
日期: 2026-08-28
基于: research.md + Lead 定稿设计简报(lead-instruction 1965c21b,founder 已拍;hosted 版 https://fw-reports-a53de2.vercel.app/r/ac58ecf439c06a3bf6e1094bb4d3264d/)

> **版本说明**:v2.6。v1(DB 原位重写)被定稿简报推翻;v2 按简报重写;v2.1 吸收 Codex R1(decoder 分家、语义 rework 解析器、registry 所有权、config 合同、删除机制、启动/回滚);v2.2 吸收 Codex R2(BUILTIN 归 B 类+双 census、Bundled/Resolved 对象、ResolvedAgentConfig+producer sweep、cleanup+seed 同事务、回滚双窗口);v2.3 吸收 Codex R3(§1.3 BUILTIN 矛盾行修正、bundled full-file 与 project overlay 双 schema 双 loader + flywheel self-host 投影规则);v2.4 吸收 code review R1 与 Lead 裁定:普通 founder-owned/customized 数据不得阻断 Bridge 启动,旧 loader 保留到逐项目激活完成;v2.5 吸收 code review R2:被保护但仍引用退役 role 的模板必须显式标记不可执行,启动告警并在创建 run 前 typed fail-closed,不得引入 alias;v2.6 吸收 code review R3:repair-mode 可读但严格 validator 拒绝的 founder manifest 只隔离该模板,不得阻断 Bridge 启动。反馈存档 /tmp/codex-rescue-design-feedback-flywheel-FLY-2121-plan-v2-round{1,2,3}.md。与简报差异在 §8(founder ⑦ 授权)。

## 0. 一句话

建 `.flywheel/agents/registry.yaml` 单一注册表(nodes=GraphNode 层 / graphs=Graph 层),名字一处定义、处处引用、loader 校验;`design`→`eng_design`(显示「设计(工程)」)、`produce(designer)`→`product_design`、产品设计流 graph=`product_design_flow`;派工菜单收编(菜单项=Graph 名,transport 字段名不动);零改史迁移(模板版本+1 只管新 run,历史 run 保旧名);删 11 个零使用模板与三胞胎文件。

## 1. 目标形态

### 1.1 registry.yaml(单一事实源)

```yaml
# .flywheel/agents/registry.yaml
nodes:                              # ── GraphNode 层 ──
  eng_design:
    file: nodes/eng_design.md       # loader 强制 name == 文件名(不含 .md)
    label: 设计(工程)
    type: design                    # 行为类(引擎 capabilities;词表不变,pin 进 manifest/snapshot)
    department: engineering
  implement:
    { file: nodes/implement.md, label: 实现, type: implement, department: engineering }
  qa:
    { file: nodes/qa.md, label: QA 验证, type: qa, department: engineering }
  pm:
    { file: nodes/pm.md, label: 产品需求, type: generic,
      department: engineering, departments: [engineering, product] }   # FLY-901 双注册显式化
  product_design:
    { file: nodes/product_design.md, label: 产品设计, type: generic, department: engineering }
  proto:
    { file: nodes/proto.md, label: 原型, type: generic, department: engineering }
  general:
    { file: nodes/general.md, label: 通用执行, type: generic }         # 无 department = top-level catch-all(现语义保留)
  engineer:                         # label 路由专用(不进任何 graph)
    { file: nodes/engineer.md, label: 工程师, department: engineering }
  product_designer:
    { file: nodes/product_designer.md, label: UX 设计,
      department: engineering, departments: [engineering, product] }

structural:                         # 结构节点(引擎内置,无说明书)的展示名,一并注册避免无来源
  founder_gate: { label: 创始人门 }
  land: { label: 合入 }

graphs:                             # ── Graph 层 ──
  code:
    templateId: tpl_code            # 稳定存储键显式进注册表(graph→template 的 SSOT,loader 校验唯一)
    label: 工程开发
    nodes: [eng_design, implement, qa, founder_gate, land]
    policies: { eng_design: {...}, implement: {...}, qa: {...} }   # 原 shapes yaml 的 models 段,键=注册名
    edges: [...]
    loops: [...]
  simple_code:
    { templateId: tpl_simple_code, label: 轻量开发, nodes: [implement, qa, founder_gate, land], ... }
  prd:
    { templateId: tpl_prd, label: 产品需求, founderReview: true, nodes: [pm, founder_gate, land], ... }
  product_design_flow:              # = 现 tpl_design;graph 名与 node 名刻意不同名
    { templateId: tpl_design, label: 产品设计, founderReview: true, nodes: [product_design, founder_gate, land], ... }
  prototype:
    { templateId: tpl_prototype, label: 原型验证, founderReview: true, nodes: [proto, founder_gate, land], ... }
  generic:
    { templateId: tpl_generic_menu, label: 通用, nodes: [general, founder_gate, land], ... }
```

> 上例是 **bundled full-file**(flywheel 仓)的形态;managed project 的 overlay 文件是另一个 schema,最小示例见 §1.2。

**Bundled full-file 校验(`loadBundledRegistry`,违背即拒载)**:
1. node name == `basename(file, ".md")`;
2. graph 的 nodes 引用未注册名(nodes ∪ structural 之外)→ 拒载;
3. nodes / structural / graphs 三个名字集合全局互斥;
4. 进 graph 的节点必有 type;policies/edges/loops 引用限于该 graph 的 nodes 列表;templateId 全局唯一非空;
5. 现 parseMenuShape 的拓扑校验按 graph 保留;
6. 每个 node/graph/structural 条目 label 非空。
(文件存在性/路径安全在 per-project 实现绑定阶段校验,见 §1.2 —— bundled 校验不触盘 managed root。)

### 1.2 registry 所有权:双 schema、双 loader、self-host 合成规则(Codex R1-3 + R2-2 + R3-2)

**两个显式解析入口(两种文件、两套校验,不复用同一 exact-key 规则)**:

- **`loadBundledRegistry(full-file)`**:读 flywheel 仓的 registry.yaml(与今日 MENU_SOURCE_DIRECTORY 同机制),执行 §1.1 六条校验。产出 `BundledRegistry`:graphs 层、structural 层、graph 节点语义合同(name/type/label);compile(模板种子)只消费这一视图。
- **`loadProjectRegistryOverlay(node-only-file)`**:读 managed project 的 `.flywheel/agents/registry.yaml`。对 bundled 已定义的名字**只许** `file` / `department(s)`(实现键,出现 `type`/`label` 拒载);对 bundled 之外的名字(project-local,label 路由专用)要求**完整 local 合同**(file+label+department(s),永不进 global graph);文件中出现 `graphs:`/`structural:` 段无条件拒载。overlay 最小示例:

```yaml
# managed project 的 .flywheel/agents/registry.yaml(node-only overlay)
nodes:
  general: { file: nodes/general.md }                    # bundled 名:只有实现键
  life_helper:                                           # project-local:完整合同(file+label+department(s) 全必填)
    { file: nodes/life_helper.md, label: 生活助理, department: life }
```

- **merge → `ResolvedProjectRegistry(project)`**:bundled 语义合同 + overlay 实现绑定;此阶段校验实现文件存在、路径安全、name==filename;缺失 → NODE_NOT_REGISTERED fail-loud。start/selection/snapshot agent 解析消费本对象及其稳定摘要。
- **Flywheel self-host 唯一规则(最小方案)**:project=flywheel **不写 overlay 文件** —— 其实现绑定直接从 `BundledRegistry.nodes` 投影(file/department(s) 即 bundled 条目所写),文件存在性相对 managed projectRoot 校验。source mode(bundle root == projectRoot)与 packaged mode(bundle root ≠ managed checkout)因此同规则;不存在 full file 被 overlay schema 拒载的路径,也无静默忽略字段的例外。
- **测试**:source mode / packaged mode 各一条;阴性:full-file 误放 managed 项目位、overlay 对 bundled 名写 type/label、overlay 带 graphs 段、project-local 缺 file/label/department(s) 任一必填键(表驱动一条覆盖)。「无 department = top-level catch-all」仅是 bundled `general` 的既有合同,project-local 不适用。
- **preflight(逐 adopted graph)**:全部可执行节点的实现绑定存在;缺失 fail-loud。
- **cross-repo 激活栅栏(Lead 2026-08-28 operator 裁定)**:personal-assistant 的 registry.yaml + config `node:` companion 转换由 Lead 在激活阶段以 operator 身份执行,不在本 worktree 授权内。本 PR 交付 schema、迁移命令、迁移回执和两入口可验证 preflight;只有目标项目 registry 已存在且 bundled/project 两入口都通过校验,启动链才允许切到新 loader 并删除该项目的旧读取路径。缺失或校验失败必须 fail-loud 拒绝激活,旧 loader 原样保留,不得半切换。`package-onboard.sh` payload 分列 bundled registry(graphs+语义,仅 flywheel 仓)与 managed-project registry(nodes 实现绑定,各项目仓),`.allow` 与 `flywheel-cli doctor` 同步。激活前置清单明确列 personal-assistant operator 动作与回执核验。
- **种子导入结果逐个检查**:`importWorkflowMenuSeeds()` 现丢弃返回值(refused 静默);改为逐个断言 imported/updated/unchanged,`refused`/revision/hash 不符 → fail-loud(与 cleanup 同事务,见 §2.B.3)。

### 1.3 收编与消亡

| 现有物 | 去向 |
| -- | -- |
| `menus/shapes/*.yaml` | 内容并入 registry.yaml graphs,目录删除 |
| `.flywheel/menus/ic-roster.yaml` | 死(nodes 层替代);`resolveMenuAgentFile(role)` → `resolveNodeAgentFile(nodeName)` |
| `.flywheel/menus/adoption.yaml` | 保留,值改 graph 名(`design`→`product_design_flow`) |
| `WORKFLOW_MENU_BINDINGS`(手写词表) | 死;graph→templateId 的 SSOT = registry graphs 的 templateId 字段;Gemini schema / default-DAG reconcile 等消费者改从 registry 派生,不再镜像词表 |
| `taskCategory` / `task_category` **字段名** | **保留**(transport/storage 字段,`/api/runs/start`、Gemini tool schema、QA 脚本、插件消费者都在发;改名触发 FLY-1914 全消费者 sweep,不值)。合法值 = registry graph 名,不再有独立词表(Codex R1-6 裁定) |
| manifest node 的 `role` 字段 | 新 revision 不再写;旧 manifest 解析永久保留(§4 A 类) |
| `.flywheel/config.yaml` agents | 见 §1.5 |
| `BUILTIN_NODE_AGENT` 一行话常量 | 新 run 禁用(注册节点必有 md);属 §4 **B 类**执行回落:ship 前 census(b)=0 则本 PR 直接删常量,否则打 `FLY-2121-legacy` 随双 census 归零删(与 §4 单一规范,无 A 类表述) |
| `designer-executor.bare.md` / `.matt.md` | 删除 |
| 现 `*-executor.md` | `git mv` 入 `.flywheel/agents/nodes/<注册名>.md`;eng_design.md 与 implement.md 由 engineer-executor.md 派生拆分 |

### 1.4 展示名(label)

- `/menus` 与 DAG 视图返回并展示 label;DAG 节点 name 与 title 后缀(现拼 `binding.task_category` 裸词)全部改 label;gate/land 用 structural 层 label;validator(含 gate/land 分支)接受并保留 label。
- 历史旧名显示解析**按 (template_id, node_id) 二元组**,不按裸 node_id(`produce` 在 tpl_design/tpl_prd/tpl_prototype 各指不同工作 —— Codex R1-1 抓出的错):
  `LEGACY_NODE_LABELS = { "tpl_code/design": 设计(工程), "tpl_design/produce": 产品设计, "tpl_prd/produce": 产品需求, "tpl_prototype/produce": 原型, "tpl_generic_menu/execute": 通用执行 }`;旧 manifest 有 `role` 时可用 role 佐证。解析顺序 `label ?? LEGACY_NODE_LABELS[templateId+"/"+id] ?? id`。founder 自建模板无 label 回落 id(声明边界)。
- node type `design` 的 badge `🎨设计` → `🎨设计(工程)`。

### 1.5 config agents 合同:AuthoringSource 与 ResolvedAgentConfig 分离(Codex R1-4 + R2-3)

- **`AgentConfigSource`(authoring,.flywheel/config.yaml)**:单条配置严格二选一——已激活项目仅含 `node: <注册名>` + match/domain/default;未激活项目继续读取 legacy `agent_file` + department(s),直到 operator 迁移回执成功。禁止同一条同时出现 `node`/`agent_file`,也禁止 registry 项目回退旧格式;这不是 workflow 名字双写层,而是 §1.3 的逐项目原子激活边界。
- **`ResolvedAgentConfig`(运行时,ConfigLoader × ResolvedProjectRegistry 产出,不可变)**:`nodeName` + 安全解析后的 `agentFile`/`agentFileRoot` + department/departments + match/domain。**文件路径不从运行时消失** —— Blueprint(Blueprint.ts:2561-2623)、management topology source link(management-topology-source.ts:137-149)、shipped generic/QA fallback(AgentDispatcher.ts:156-187)全部改为消费本类型;shipped-generic/shipped-QA 定义为 bundled resolved nodes(显式字段,不留手写旧 AgentConfig)。
- **department 显式化**:home/dual-register 从 registry 字段读取;ConfigLoader 路径推导(ConfigLoader.ts:621-655)与 `AgentDispatcher.registeredDepts()` 的 `parsedDept`(AgentDispatcher.ts:130-142)退役;`general` 无 department = top-level catch-all,现语义逐条断言保留(FLY-901 双注册、QA fallback、multi-dept 测试同步)。
- **边界**:`WorkflowManifestNode.agent_file` 是 founder/custom 模板与历史 manifest 的合法字段,**保留**,Phase C 文本守卫显式豁免。
- **producer sweep(FLY-1914,Phase A 内完成)**:`scripts/setup-new-project.sh:207-214`(仍生成 agent_file)、`packages/flywheel-cli` init template(templates/config.yaml.tmpl:25-37)、doctor parser(doctor.ts:54-163)、`migrate-agents-path` 命令 —— 全部改为生成/验证 registry+`node:`,或显式退役该命令;onboarding 文档与全部受管项目 config 同步。sweep 证据(三 root:插件 fork 源、本机插件缓存、主仓 scripts/packages)附 PR body。
- 映射:engineer→engineer、qa→qa、product-designer→product_designer、pm→pm、prototype→proto、designer→product_design、general→general;config 键与 match.labels 一律不动。

## 2. 分阶段实施(TDD)

### Phase A — registry loader + 编译链切换(纯代码/配置,不碰 DB)

1. **RED**:bundled 六条校验各一红 + overlay schema 三条阴性(§1.2);self-host source/packaged mode 两条;ConfigLoader/AgentDispatcher department 显式化测试;menu/DAG label 测试;守卫(Phase C)先红。
2. **GREEN**:`agent-registry.ts`(载入+校验+单实例传递);compileWorkflowMenuSeed 改 registry 驱动(node id=注册名、label/type 进 manifest、不写 role、land/gate label);`/menus` 与 DAG 视图接 label(含 title);dispatch 合法值 = graph 名(字段名不动);ConfigLoader `node:` + department 字段;registry.yaml + nodes/*.md 落盘(`git mv` 保历史);shapes/ic-roster 删除;package-onboard + doctor 更新;`scripts/test-deploy.sh:1882` role 断言、`scripts/lib/qa-generalized-e2e-lib.mjs:466` 字面量同步。

### Phase B — 运行时兼容 + 语义 rework 解析器 + 启动迁移

1. **语义 rework 目标解析器(Codex R1-2,从 checklist 升为规范设计)**:founder/classifier 的 `design|implement|qa`(含中文 设计/实现/测试,workflow-rework-hint.ts:60-72)是**语义目标不是 node id**。新增单一解析函数:读目标 run 的 pinned snapshot,按 `type === "design"` 唯一解析出实际 node id(旧 run 得 `design`,新 run 得 `eng_design`),invalidation route 从该 snapshot 拓扑生成。统一接管:hint 前缀解析、classifier 输出、已持久化 founder feedback/source receipt 重放、Bridge 重启、early carryover、gate kickback、route revision(StateStore.ts:28474-28514 / 38594-38596 / 40370-40502 / 40631-40670 全部走解析器,**不散落改双名字面量**)。测试矩阵:旧/新 snapshot × restart/replay × 中英文目标词。
2. **兼容面分两类(Codex R1-1,替代 v2 §4)**——见 §4。
3. **启动序(Codex R1-6 + R2-4;code review R1/R2/R3 修订)**:FLY-2121 迁移是 `startBridge` 在通用 schema migration(`StateStore.create()`)与 registry preflight **之后显式调用**的独立 operation,不塞进 `migrate()`。序:(i)**纯读 preflight**:registry 载入+全部校验+种子编译,并对当前 template rows 做只读 seed-import 预演(owner/hash/预期 revision);(ii)建 verified teamlead.db 备份点(沿用 crash-runbook 机制),备份至 ready 之间不接受新派工;(iii)**单个 batch transaction**:绑定换词 + 可安全删除的旧模板 + 可安全导入的六个种子 + skip 审计 + 逐个结果/hash/revision 断言;(iv)binding reconcile;(v)ready。founder-owned/customized seed 与 founder-owned、未 retired、仍被引用的 cleanup 模板原样保留,写 append-only `workflow_catalog_migration_audit` 并逐行告警;重跑不重复写审计。若 preserved template 的 published manifest 仍引用 authoritative registry 不认识的旧 role,审计必须附 `dispatchStatus=unrunnable`、稳定诊断码与 role 集合,启动输出显式错误;若 manifest 是 repair mode 可存储但当前严格 validator 拒绝的状态,preflight 捕获 parse/validation 失败并写 `manifestStatus=unreadable`,继续 Bridge ready。两类风险的后续 materialization 都在创建 run 前以 typed error fail-closed,HTTP 返回稳定 409,要求 operator 修复并用当前 node 重新发布;审计诊断只读最新行,修复后的新行必须使旧风险失效。不得用 alias、自动重写或放宽新 run validator 来伪装兼容。category 冲突、DB 读取/结构错误、hash/digest/事务后置条件破坏等真正完整性错误仍整体回滚并阻止 Bridge ready。
4. **清理细则(Codex R1-5;在 §2.B.3 的 batch transaction 内执行)**,位置在 workflow ledger 全部建表之后:
   - 绑定换词:按**全部 project 行**处理 `task_category='design'` → `'product_design_flow'`;预检 `(project,'product_design_flow')` 冲突 → 整体 fail-loud;完成后断言旧键归零。
   - 11 模板删除(白名单硬编码):逐个分类。满足{system-owned、已 retired、0 workflow_run 引用、0 category binding 引用}才进入删除集合;owner-protected、未 retired、仍有引用者进入 preserve+audit+warn 集合。删除集合在同一事务内 DROP 相关表的 no-delete trigger(workflow_template_revision/_publication;audit 表 trigger 不动、audit 行不删)→ 置 `current_published_revision = NULL` 解循环 FK → 按 publication→revision→template 顺序删 → 重建 trigger → `PRAGMA foreign_key_check` → 断言目标行归零+trigger 存在。真正结构断言失败才整体回滚 + Bridge 不 ready。
5. **workkind-cutover 旧 restore 显式退役**:换词后旧 receipt 与现 bindings 必然 `BINDING_TARGET_DRIFT`(workkind-cutover.ts:571-575, 688-695)——这是预期 fail-closed,写测试固化该诊断路径,文档声明 FLY-1436 restore 自此不可用(不造 superseding receipt,不加 runtime alias)。
6. 测试 fixture:(a)旧 revision 在飞 code run 全生命周期(founder 中文「设计」kickback → 解析器命中旧 node id)、(b)新 run 全流程、(c)绑定换词幂等+冲突 fail-loud、(d)模板删除白名单+owner-protected/未 retired/有引用者原样保留并审计告警+trigger 恢复、(e)census=0 后历史完成 run 仍可 parse/render(常驻回归,A 类 decoder 永续性的守卫)。

### Phase C — 守卫 + 阴性对照 + 收场哨

1. 结构守卫:registry 六条校验;名字集合精确;无裸 `design`/`designer`/`produce` 注册名;label 全非空;shapes 目录与 ic-roster 不存在;registry-backed source 禁止 `agent_file`,legacy-only source 禁止 `node`,二者不可同条共存。
2. 文本 sweep(`rg -n --fixed-strings`):旧标识 token 扫 packages/scripts,allowlist 显式:`FLY-2121-legacy`(B 类)与 `FLY-2121-history`(A 类)标记行、守卫自身、designer-labels.ts 族、engineering/doc/。
3. 阴性对照:loader 注入 fixture(未注册引用 / name≠file / 重名跨层 / 裸 design)各断言红;文本守卫注入一处 shapes 外的旧字面量断言红。
4. 收场哨 `scripts/fly2121-legacy-census.sh`:双计数(§4)——(a)非终态 run 旧 node id;(b)非终态 engine run 中无 pinned agent 的可执行 resolved node(schema v1 全纳入)。双归零 = **仅 B 类**标记的删除开工条件(收尾另立 issue)。

### Phase D — 收尾

全仓门(`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`,警惕 teamlead 缺席假绿)→ codex-code-review 至 approved → PR(base main,末 commit:milestones/FLY-2121.md + doc `git mv` 归档)→ 通知 HL label 字段可消费。

## 3. 旧名 → 新名(身份)

| 层 | 旧 | 新 |
| -- | -- | -- |
| code 第一节点 | design(id+role) | eng_design |
| 产品设计节点 | produce(role=designer) | product_design |
| 产品设计流(菜单项) | design(category 值) | product_design_flow |
| prd 节点 | produce(role=pm) | pm |
| prototype 节点 | produce(role=proto) | proto |
| 通用节点 | execute(role=generic) | general |
| graph→templateId | 手写 WORKFLOW_MENU_BINDINGS | registry graphs.templateId(§1.1) |

## 4. 兼容面:A 类(永久历史 decoder)与 B 类(可收场)分家(Codex R1-1)

**A 类 —— 永久保留(标记 `FLY-2121-history`,不参与收场;历史完成/失败 run 永远存在,查看/审计/重解析路径永远要能读)**:
1. snapshot 解析器对旧 `task_category`(design)的放行(workflow-run-snapshot.ts:577-585);
2. 旧 manifest `role` 字段解析(:615-630 链路);
3. `LEGACY_NODE_LABELS`(按 template_id/node_id 二元组,§1.4)。

**B 类 —— 可收场(标记 `FLY-2121-legacy`,census 归零后删)**:
1. StateStore 对旧 node id 的**执行**分支(经 §2.B.1 解析器收口后,余下真正只服务未终局旧 run 的分支);
2. **`BUILTIN_NODE_AGENT`**(Codex R2-1 更正:它是执行期 fallback —— `workflowNodeAgentContent()`(:305-309)的消费者是 actions.ts / runs-route.ts / workflow-engine-dispatcher.ts 的执行分发路径;历史完成 run 的 parse/render 不需要它;schema-v1 snapshot 的 resolved node 不携带 agent(:313-355),所以 active v1 run 在 implement/qa 也依赖它——与旧 node id 无关);
3. 其余确证只被活跃旧 run 触达的 fallback。

**census 定义(随 R2-1 重定)**:收场哨数两项 ——(a)非终态 run 中旧 node id 计数;(b)非终态 engine run 中「当前/后续可执行 resolved node 无 pinned agent」的 snapshot 计数(schema v1 全部纳入)。两项都归零才是 B 类删除开工条件。**若上线前 census(b) 已为 0,本 PR 直接删 `BUILTIN_NODE_AGENT` 常量**(founder 终态);否则留 B 类标记随收场删。

常驻回归测试:模拟 census=0 后 A 类路径对历史 run 的 parse/render 仍通过(§2.B.6.e);该测试**不得调用** `workflowNodeAgentContent()`(避免为 B 类制造人为永久依赖)。

## 5. 部署与回滚(operational contract,Codex R2-5 修订为双窗口)

- FLY-1959:merge 不部署;随班车重启生效。启动序见 §2.B.3。
- **窗口一(ready 前,或经硬门确证零新 snapshot)**:可回滚代码 —— 历史与在飞旧 run 未被改写;绑定反向 = 单条 UPDATE(product_design_flow→design)**且**须先让旧种子导入成功、current revision 指回旧代码可解析的版本(只反绑定不回 revision,旧 binary 仍读到新 manifest);或直接从 verified backup 恢复(注意:恢复会丢弃备份点之后的全部合法写入,只适用于零新写入窗口)。被删的 11 个模板不因代码回滚复生(零 run 零绑定,复生仅需 re-seed/备份)。
- **窗口二(ready 后已产生任一新 snapshot)**:**禁止**直接回滚到不认识新 manifest(label/无 role/eng_design/product_design_flow)的旧 binary —— 旧 validator 对 node keys 精确校验且不识 label(workflow-template.ts:918-940),旧 live category 校验会拒 product_design_flow snapshot(workflow-run-snapshot.ts:577-585);新的活跃与历史 run 会双双不可读。此窗口只能 roll forward,或部署保留 v2.2 解码/兼容层的 forward-compatible 回滚 build。
- **硬门**:两窗口的判别不靠操作员记时间,靠 DB census —— `SELECT COUNT(*) FROM workflow_run WHERE created_at > <ready 时刻> AND snapshot 含新标识`(实现为脚本);>0 即窗口二。写进回滚 runbook。

## 6. 验收对照

| 验收 | 落点 |
| -- | -- |
| 名字各自说出自己是什么(Lead 裁定 CDE 同名原则) | §3;eng_design / product_design / product_design_flow 互异 |
| 旧名删净 + 守卫红 | Phase C;语义按简报⑤修订:新路零旧名;A 类 decoder 永续(历史可读性优先),B 类有收场判据 —— A/B 分家见 §4 |
| 历史 run/event 仍可读、无空名/id 泄漏 | 零改史 + A 类 decoder + (template_id,node_id) 显示映射 + 常驻回归 |
| 前端零硬编码名字 | label 进 /menus + DAG(含 title);HL 侧消费 |

## 7. 实现期核对清单

- [ ] `workflow_run.task_category` 读者 sweep(旧行 design,比对处走 A 类放行或透传)
- [ ] engineer-executor.md 拆分保留 pipeline preamble 等 runtime 契约段
- [ ] selection digest TOCTOU 跨重启窗(绑定换词只影响新 selection)
- [ ] Gemini tool schema / 插件消费者的 category 合法值更新(值变词表、字段名不变;FLY-1914 三 root sweep 附 PR body)
- [ ] management topology / QA fallback / multi-dept 测试随 §1.5 同步
- [ ] 激活前由 operator 完成 personal-assistant registry+config 转换,核验迁移回执与 bundled/project 两入口 preflight;缺失即 fail-loud 且旧 loader 原样保留
- [x] 上线前跑一次 census(b):2026-08-29 对活体生产库只读复核为 `unpinnedAgentRuns=0`(完整输出与解释见 `design-correction.md`「QA2 F4」),按 founder 终态在本 PR 删除 `BUILTIN_NODE_AGENT`;census(a)=20,因此其余旧 node id 执行分支仍保留

## 8. 与定稿简报的差异标注(founder ⑦;含 Codex R1 结论)

1. **templateId 不换新键,且显式进 registry graphs**(§1.1):「版本+1」字面执行;tpl_* 降级为无人念的内部键;Codex 有条件成立判定的条件(graph→templateId 进 SSOT + 种子结果被启动链校验)已在 §1.1/§1.2 落实。
2. **prd/prototype 的 produce 一并改名 pm/proto**:全局唯一性的必然;历史 produce 显示按 (template_id,node_id) 区分(Codex 补强)。
3. **nodes 层带 type**:行为类保词表、pin 进 manifest/snapshot。
4. **「旧名删干净」语义修订 + A/B 分家**:永久历史 decoder(A)与可收场执行兼容(B)分类管理;守卫对标记外全仓零容忍。Codex「不成立(按现稿)」的病根即 v2 未分家,v2.1 已改。
5. **config `node:` 引用 + department 显式化**:合同定稿于 §1.5,不再留实现期自由收敛。
6. **taskCategory 字段名保留**(新增,Codex R1-6):词表消失指合法值收编为 graph 名;wire/storage 字段改名需 FLY-1914 全消费者 sweep,收益为零,不做。
7. **global bundled + per-project overlay 双 schema**(新增,Codex R2-2/R3-2):founder 示例画的是单一 registry.yaml;落地拆为 bundled full-file(graphs+语义,flywheel 仓权威)与 managed-project node-only overlay(实现绑定),flywheel self-host 不写 overlay、从 bundled 投影。理由:graph 定义必须全局唯一(同 templateId 种子不能被各项目互踩),而执行者文件天然 per-project;单文件双语义只能靠猜 mode,双 schema 双 loader 让写错的文件在启动时被拒而不是被猜。
8. **节点身份不加项目前缀 + cross-repo 由 operator 激活**(Lead 2026-08-28 裁定):身份键是 `(project,nodeName)`,记忆按 `(project,identity)` 分桶,project overlay 承载项目特化;显示名可带项目。本 PR 不改 personal-assistant 外仓,改为交付 schema/迁移命令/回执/preflight,目标 registry 未通过两入口校验时拒绝激活并保留旧 loader。完整反馈留痕见 `design-correction.md`。
