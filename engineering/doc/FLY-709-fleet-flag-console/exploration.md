# FLY-709 统一 fleet 控制台 — 探索

Issue: FLY-709 (https://linear.app/geoforge3d/issue/FLY-709/dashboard-统一-fleet-控制台-per-项目模型effort-所有-feature-flag-状态-founder-直接)
日期: 2026-06-30
基于: 无

---

## 1. 目标（Annie 原话）

> 『你既然给所有东西都做了 feature flag、是不是该搞个 dashboard？到时要控制开/关、我起码能看到状态、或者自己去控制开关。』
> 『现在这些 enablement 配置都放在哪里？散落不同地方很难找 —— 起码把所有 feature flag 放在同一个文件里、管理才方便。』

拆成两件事（一个 issue，fold 了 FLY-711 + FLY-247）：

- **① 中央 feature-flag 注册表**（地基）—— 所有 flag 一个单一真相源，好找、好审、好管。
- **② 控制面板 dashboard**（读注册表渲染）—— 看得到状态 + founder 能直接 toggle + 生效路径清楚；合并 FLY-247 的 per-项目模型/effort dashboard。

两个动词：**可见**（看状态）+ **可控**（直接开关）。

---

## 2. 现状（onboard 审计结论）

### 2.1 flag 确实散落在三类「住所」，且生效路径各不相同

| 住所 | 例子 | 读取时机 | toggle = 改什么 + 生效路径 |
|------|------|----------|---------------------------|
| **A. 部署 env**（`~/.flywheel/.env`，boot 时被 `flywheel-bridge-wrapper.sh` `source`） | `FLYWHEEL_AUTO_QA`、`FLYWHEEL_REMOTE_REPORTS`、`FLYWHEEL_FLEET_CONSOLE`、`DECISION_MODE`… | 绝大多数 **boot 时读一次** | 改 `.env` → **需要重启 Bridge**（少数如 `FLYWHEEL_MISROUTE_PATROL` 每 poll 读=热生效） |
| **B. 项目 config**（`<project>/.flywheel/config.yaml`，git 版本管理） | `qa.auto`、`doc_flow.enabled`、`ponytail.enabled`、`founder_ux_gate.mode`… | **每次 run 起始读**（canonical root） | 改 `config.yaml` → 对**新 run 热生效**、但是 git-committed 仓库文件（改=编辑+提交） |
| **C. Fleet 拓扑**（`~/.flywheel/projects.json`） | per-Lead `model` / `effort` / `backend`（**FLY-247 已建**） | Bridge hot-overlay + 引擎重启单个 Lead | FLY-247 事务引擎（flock + 日志 + CAS + launchd 重启单 Lead）已经能改 |

**关键结论**：feature flag（住所 A/B）和 FLY-247 的 per-Lead 模型（住所 C）**不是同一个写入目标**。FLY-247 的 `flywheel-fleet.sh apply` 引擎只改 `projects.json`。flag toggle 要写 `.env` 或 `config.yaml`，是不同的写路径 + 不同的生效路径。这是本 issue 最大的一处「看起来一样、其实不一样」。

### 2.2 flag 数量与分类（约 30+ 个）

按 FLY-707 `default-enable-policy.md` 已经定的两条 idiom + 三档 category：

- **idiom**：`!== "0"` = 默认 ON 的 kill-switch（逃生口）；`=== "1"`/`=== "true"` = 默认 OFF 的 opt-in。**极性无法从名字推断**，注册表必须显式记。
- **category**：
  - `feature`（普通功能，默认 ON，可 toggle）—— 如 `FLYWHEEL_PANE_IDLE_SUPPRESS`、`doc_flow`、`qa.auto`、`ponytail`（例外：默认 OFF + Annie-exception）。
  - `kill_switch`（紧急总开关，默认 ON，`=0` 关）—— 如 `FLYWHEEL_AUTO_QA`、`FLYWHEEL_REMOTE_REPORTS`、`FLYWHEEL_FLEET_CONSOLE`。
  - `governance_gate`（治理门，**硬豁免**，`default-enable-policy.md` §33-49 明令不可 blind-enable）—— 如 `DECISION_MODE`/founder_consent、`founder_ux_gate`、founder-only-authority、`FLYWHEEL_COMM_BYPASS_BRIDGE`。

完整清单见 `research.md`。

### 2.3 已有的两种 hosted HTML 模型（决定 dashboard 形态）

| 模型 | 位置 | 能不能 live toggle？ | 谁能看 |
|------|------|--------------------|--------|
| **FLY-247 Fleet Console** | Bridge `GET /`（loopback + same-origin + confirmToken） | **能**（模型/effort 已经能改） | **只有本机**（localhost，founder 在机器前） |
| **publish-report（FLY-203）** | Vercel 128-bit token URL，静态快照 | **不能**（远程页被 `default-src 'none'` CSP 锁死，无法回调 Bridge `/api/*`） | **任何设备**（Annie 手机可开），但只读 |

**这是 dashboard 设计的硬约束**：带 toggle 的交互面板**必须**是 localhost 的 Fleet Console；远程手机页**只能**是只读快照。两者不能混。

---

## 3. 三处核心设计张力（要 Annie/Lead 拍板的地方）

- **张力 1 — 注册表格式**：YAML（founder 可手改、但要 loader+校验）vs TS（类型安全、代码直读、但改要 deploy）。
- **张力 2 — toggle 的生效路径**：大多数 env flag 改了要**重启 Bridge**，而重启是 founder-gated Tier-3（高 blast radius、要 Annie 在场）。一个「点一下 .env 就改了但不重启不生效」的 web 按钮是 footgun。
- **张力 3 — 可见 vs 可控 的范围**：可见（看状态）低风险、高价值、无歧义；可控（真 toggle）涉及安全面（governance gate 绝不能 web-toggle）+ 重启门 + git 提交，风险高。

---

## 4. 注册表设计（① 地基）

### 4.1 推荐格式：**TS 声明式注册表 + resolver**（不是纯 YAML）

理由：
- flag 的**声明**（name/category/default/description/生效路径/读取位置）是**代码级元数据**，天然属于 TS（类型安全、和读取点同仓、CI 可校验「注册表列了但代码没读 / 代码读了但没登记」）。
- flag 的**当前生效值**不是注册表里的静态字段 —— 它由现有的 env→config→default 解析链算出。注册表提供一个**统一 resolver**：`resolveFlag(name)` → `{ effective, source, needsRestart }`，内部对每个 flag 沿用**和现在逐字一致**的解析逻辑（byte-compat 的核心）。
- 「founder 手改一个文件」的诉求 —— 由 dashboard toggle 满足（写 `.env`/`config.yaml`），**不需要** founder 直接手改注册表。注册表是「有哪些 flag、各是什么语义」的目录，不是「当前值」的存储。

> 备选（YAML 注册表）会把「声明」和「值」耦进一个可手改文件，反而丢了类型安全 + CI 校验，且和现有 env/config 双真相源打架。**倾向 TS，design review 复核。**

### 4.2 注册表条目 schema（草案）

```ts
interface FeatureFlagSpec {
  name: string;              // 稳定 key，如 "auto_qa"
  category: "feature" | "kill_switch" | "governance_gate";
  source: "env" | "project_config" | "code_default";
  envVar?: string;           // 住所 A：如 "FLYWHEEL_AUTO_QA"
  configKey?: string;        // 住所 B：如 "qa.auto"
  polarity: "default_on" | "opt_in";   // !== "0"  vs  === "1"
  default: boolean;
  description: string;       // 控什么
  effect: "hot" | "restart_bridge" | "per_run" | "gated_action";  // 生效路径
  toggleable: "direct" | "conversational" | "readonly";  // dashboard 能怎么改
}
```

### 4.3 迁移策略（byte-compat）

- **第一批住户** = 现有全部 flag（清单见 research.md），逐条登记，`polarity`/`default`/`effect` 按审计到的**当前行为**填 —— 不改任何行为。
- 「代码统一从注册表读」是**目标**，但把 ~30 个读取点一次性全换成 `registry.isEnabled(...)` 风险高（每个都要证 byte-identical）。**建议**：注册表先做**目录 + resolver + 校验**，读取点迁移**分批/增量**（本 PR 迁移少数 + 立一个 pattern + CI 挡「登记漏 / 代码漏」），不强求一 PR 全迁。← **scope 决策点，要 Lead 确认。**
- `ponytail` 标 `default: off` + Annie-exception，其余按 default-enable 政策默认 ON。

---

## 5. Dashboard 两条路（② 展示/控制）

Annie 给了两条路，让她选：

- **A. Discord-skill / 对话式**：Annie 说『看 feature flags』→ Lead 渲染当前状态；说『关掉 X』→ Lead 改注册表/config/.env + 部署（含重启）+ 回报。**优点**：重启/提交这些 founder-gated 动作天然由 Lead+founder-gate 流程兜住，无新安全面。**缺点**：不是「一眼看全 + 自己点」。
- **B. Hosted HTML dashboard**：带 toggle UI 的页，点一下真改后端 flag。**优点**：直观、self-serve、复用 FLY-247 Fleet Console 现成基建（loopback + confirmToken + audit）。**缺点**：只能 localhost（远程只读）；重启型 flag 的 toggle 有 footgun；governance gate 必须锁死只读。

### 5.1 我的推荐：**Hybrid（可见走 B、可控按 flag 分流）**

结合张力 1-3 + 两个 hosting 模型的硬约束，最 boring/正确的形态：

1. **可见（核心、无歧义、先做）**：在 **FLY-247 Fleet Console（localhost `GET /`）加一个 Feature Flags 区**，读注册表渲染全部 flag：当前 on/off + category + 说明 + **生效路径**（hot / 需重启 / 需提交 / gated）。→ 直接满足『我起码能看到状态』。（可选：再给一个 publish-report 只读快照发 Annie 手机。）
2. **可控（按 flag 分流，安全优先）**：
   - `feature`/`kill_switch` 里**热生效**的 flag → Fleet Console **直接 toggle**（复用 stage→confirmToken→apply）。
   - **需重启 Bridge** 的 env flag → 面板写 `.env`，但**明确标注「需重启生效」**，重启**走现有 founder-gated 重启流程**（不由 web 点击静默触发）；或 v1 先不给这类 web-toggle，改由**对话式（A）**让 Lead 执行。
   - `governance_gate` → **永远只读**（web 不可 toggle，符合 `default-enable-policy.md` 硬豁免）。

即：**B 做可见 + 安全子集的可控；A 兜重启型/config 型/治理型的可控。** A/B 不是二选一，而是「可见用 B、可控按风险分流」。

### 5.2 分档 / scope（match process weight to risk）

- **Phase 1（清晰赢）**：注册表 + resolver + 校验 + Fleet Console 只读 Feature Flags 区。低风险、直接答『看得到状态』。
- **Phase 2（安全子集可控）**：热生效 flag 的直接 toggle（复用 FLY-247 事务/审计/confirmToken 面）。
- **Phase 3（重启型/config 型）**：写 `.env`/`config.yaml` + 明确生效路径 + 重启走 founder gate（或对话式）。governance gate 全程只读。

一 PR 还是分 PR，看 Lead/Annie 对 scope 的偏好。倾向：Phase 1+2 一个 PR（都在 Fleet Console 面里、共享基建），Phase 3 视复杂度可拆。

---

## 6. 待决策问题（brainstorm gate 带给 Lead / Annie）

1. **A/B/Hybrid**：确认「可见走 hosted Fleet Console 区、可控按 flag 分流（热→直接 toggle / 重启型→gated 或对话式 / 治理门→只读）」这个 hybrid 方向？还是 Annie 明确要纯 A 或纯 B？
2. **注册表格式**：TS 声明式注册表 + resolver（推荐）vs YAML？（偏技术，Lead+Codex 可拍。）
3. **迁移范围**：注册表先做目录+resolver+校验、读取点增量迁移 —— 还是本 PR 就把全部 ~30 读取点迁完（风险/工作量大）？
4. **远程手机可见**：除了 localhost Fleet Console，要不要也给一个 publish-report 只读快照（Annie 手机能开）？
5. **scope/phasing**：Phase 1+2 一个 PR、Phase 3 可拆 —— 可接受？

---

## 7. 非目标（scope discipline）

- 不改 FLY-247 已有的 per-Lead model/effort toggle 行为（只在同一个面里新增 Feature Flags 区）。
- 不动 governance gate 的任何默认值 / 语义（只读展示）。
- 不做 flag 的历史/审计可视化（FLY-247 已有 `fleet_admin_audit`，toggle 复用即可，不新建报表）。
