# FLY-2100 flag_values 范围列 — 独立 QA 验证报告

Issue: FLY-2100 (https://linear.app/geoforge3d/issue/FLY-2100/flaga地基-flag-values-加范围列全项目-项目名逐项目-名册-scope-生效-解析顺序-项目默认-管理台按项目读-db)
日期: 2026-08-28
基于: plan.md（实现方自测记录见同目录 qa.md；本文件是独立 QA，harness 与场景均自建，不复用实现方的）

被测 head: `57f16d7f7571025c8e6d359a7519e47e02d24728`
远端一致性: `git ls-remote origin flywheel-FLY-2100` = `57f16d7f7`（与本地 HEAD 逐字相同，开跑前与出具结论前各核一次）

## 结论

**PASS。** 八项验收全部取得实机证据，包括实现方未能取得的浅色管理台截图。
两处与本单无关的既存限制如实记入「诚实边界」。

---

## 1. 门禁

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm lint` | 0 error / 15 warning | 逐文件比对：15 条全部落在本单 diff 之外（`doc/engineer/research/…`、`scripts/qa-fly-2007-*`、`quota-monitor-runtime.ts` 等）。本单 38 个改动文件零 warning |
| `pnpm -r build` | 通过 | 全 workspace 拓扑构建 |
| `packages/config` 本单测试 | 63/63 通过 | scan / resolve / store-policy |
| `packages/teamlead` 全包 | 9652 用例，本单测试文件全绿 | 见下「外来红归因」 |

### 外来红归因（两轮控制变量）

首轮全仓 `pnpm test:packages:run` 在 `packages/config` 处中断（`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`），
**teamlead / flywheel-comm 根本没跑到**，因此另行补跑。

- `packages/config/src/__tests__/repository-baseline.test.ts` 2 失败 —— 本分支**未触碰**该文件；
  单独复跑 4/4 通过（2.0s / 2.2s，阈值 5s）。并行负载下的超时。
- `packages/teamlead` 首轮 18 文件 / 58 用例失败。定位到 socket 路径 `EINVAL`（runner TMPDIR 89 字符撞
  `sun_path` 104 上限）。改用短 TMPDIR 后降为 9 文件 / 21 用例。再把这 9 个文件单进程串行复跑：
  **8 个全绿**，仅 `fly247-bash-suites.test.ts` 剩 4 个失败。
- 这 9 个文件（claude-profile-cli / createLeadRuntime-preflight / event-route / real-tmux /
  bash-suites / workflow-docs-git / workflow-resume-checkpoint / terminal-thread-archive /
  worktree-quarantine）**均不触及本单代码路径**；本单的 13 个测试文件从未出现在任何一轮失败列表里。

> 注：`git diff main...HEAD` 会额外列出 FLY-2029/2074/2077/2094 等文件 —— 本地 `main` 陈旧所致。
> 对 `origin/main` 的真实 diff 是 **38 个文件、全属本单**（无 `workflow-menu.ts` / `menus/` / `doc/oncall/`）。

---

## 2. 隔离真 Bridge（自建，零触碰生产）

独立 `HOME` + 独立 `projects.json`（名册 = `alpha` / `beta`）+ 独立 `TEAMLEAD_DB_PATH` +
`TEAMLEAD_PORT=19877` + 独立 `FLYWHEEL_DELIVERY_SECRET_PATH`。未调用 `restart-services.sh`。
config 基线故意做成互不相同：`alpha: doc_flow.enabled=true` / `beta: false`。

### 三级解析顺序（项目行 → `*` 行 → config）

| 步骤 | DB 行 | alpha 生效 | beta 生效 | 判定 |
| --- | --- | --- | --- | --- |
| S0 基线 | 无 | **true**(config) | **false**(config) | 双读回落 ✅ |
| S1 `set doc_flow off --project '*'` | `*`=0 | **false** | **false** | `*` 行遮蔽 alpha 的 config `true` ✅ |
| S2 `set doc_flow on --project alpha` | `*`=0, alpha=1 | **true** | **false** | 项目行压 `*` 行 ✅ |
| S3 `clear --project alpha` | `*`=0 | **false** | **false** | 回落 `*` 行 ✅ |
| S4 `clear --project '*'` | 无 | **true** | **false** | 回落各自 config ✅ |

全程走真 CLI → `/api/fleet/flag/stage` → `/api/fleet/flag/apply`，SQLite 直接核对行状态。

changelog 四条均带 scope，两条 clear 的 `to_effective` 为约定哨兵 `inherit` ✅

### 负向（fail-closed）+ 阳性对照

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| `mailbox_queue --project alpha`（bridge_global 拒项目行） | 400 | ✅ `{"error":"mailbox_queue is bridge_global and rejects project rows"}` |
| `doc_flow --project ghost`（未登记项目） | 400 带名册 | ✅ `{"error":"unknown project scope: ghost","allowed":["*","alpha","beta"]}` |
| `checkpoint_enabled --project alpha`（非白名单） | 400 | ✅ `{"error":"checkpoint_enabled is not project-store-managed"}` |
| `clear doc_flow --project beta`（无行） | 409 | ✅ `missing_row` |
| **阳性对照**：`flag_retirement_scan --project '*'`（bridge_global 走 `*`） | 成功 | ✅ `{"ok":true}` —— 证明尺子有效，上面四条拒绝是真的 |
| global store flag `clear` | 行保留、`has_override=0` | ✅ 行仍在，`has_override=0`，`revision` 1→3 |

### ABA CAS（changelog 序号 fence）

这是设计里最微妙的一处，单独构造：

1. 建 alpha 行（`raw=1`），此时 `changeSeq=13`
2. stage 一次 `set off`，服务端捕获 `expectedChangeSeq=13`
3. 带外做 **delete → recreate 同值**：`clear alpha` 然后 `set alpha on`。
   结果 `raw_value` 仍是 `1`、**`revision` 重置回 `1`** —— 朴素的 revision CAS 到这里会被骗过
4. apply 那份 stale stage → **409 `{"error":"stale_change_seq"}`** ✅

---

## 3. 存量库迁移（用生产库的只读副本，不是手搓 fixture）

生产 `~/.flywheel/teamlead.db` 是真正的迁移前库：旧 schema（`flag_name PRIMARY KEY`，无 scope）、
6 行、其中 `skill_framework_mode` 带真实 override `'split'`、7 条 changelog。
用 `sqlite3 "file:$PROD?mode=ro" "VACUUM INTO …"` 取只读副本（原库 mtime 未变），在副本上起 Bridge：

- schema 迁为 `scope TEXT NOT NULL DEFAULT '*'` + `PRIMARY KEY (flag_name, scope)` ✅
- 6 行全部保留并落 `scope='*'`，**含真实 override `split` 逐字节保留** ✅
- 7 条 changelog 保留，全部落 `scope='*'` ✅
- 备份 `teamlead.db.pre-fly2100.bak` 生成 ✅
- **幂等**：停机重启第二次，备份的 inode / mtime / size 三项**逐一相同**，目录下 bak 文件恰好 1 个，
  6 行仍全为 `'*'` ✅（防 crash-loop 无界复制）
- **降级路径**：迁移后的库 + `FLYWHEEL_FLAG_STORE=0` bypass 启动正常，报告页照常渲染，
  scoped 写入 fail-closed 409 ✅

---

## 4. 周扫描 per-(flag, scope) 稳定账本

沙箱里该表初始为空（周扫描未真跑过），因此用**编译产物 + 真 SQLite StateStore** 写驱动
（真 `computeFlagScan` + 真 `commitFlagScan` / `getFlagScanScopeState`，零 mock），跑四个 commit 周期：

| 周期 | doc_flow | alpha | beta |
| --- | --- | --- | --- |
| 1 | a=T, b=F | samples=1 | samples=1 |
| 2 | 不变 | **samples=2，startedAt 不变** | **samples=2，startedAt 不变** |
| 3 | a 翻转为 F | **samples=1，startedAt 换新** | **samples=3，startedAt 不变** |
| 4 | beta 移出名册 | samples=2 | **scope 行被修剪删除** |

周期 2 证明 streak 是从 `getFlagScanScopeState()` 读回后递增、不清零；
周期 3 证明**逐项目独立重置**（A 变值不动 B）；周期 4 证明名册收缩会修剪账本行。

---

## 5. 手机 flag 报告页（Discord 投递的那份产物）+ 浅色截图

真浏览器（Claude-in-Chrome，§4 三连 preflight 通过）打开隔离 Bridge 的
`/api/fleet/flag-report.html?interactive=1`：

- 主题：`body` 背景 `rgb(245,245,247)` / 文字 `rgb(29,29,31)`，全页无 `prefers-color-scheme` 分支
  → **浅色**，符合验收 ✅
- `doc_flow` 卡片（DB: `*`=on、alpha=off）：
  - alpha: `OFF` + `项目行` + **⚠ runtime 仍按 config: ON（C 单切换）**
  - beta: `ON` + `* 行` + **⚠ runtime 仍按 config: OFF（C 单切换）**
  - 分歧黄标逐项目精确命中，config 与 DB 一致的项目**不误报** ✅
- 5 个白名单 flag 有「项目」下拉；`checkpoints.*.enabled`、`skill_framework.split`、
  `xiaohongshu…auto_create` 等非白名单 flag **没有**下拉 ✅
- `data-ffp-state` = `{"*":{"p":1,"v":"off"},"alpha":{"p":1,"v":"on"},"beta":{"p":0}}` —— presence 映射正确 ✅

### 控件状态机（在真页面上驱动 change 事件）

| 动作 | 值下拉选项 / 选中 | 判定 |
| --- | --- | --- |
| scope `*`（有行, on） | on / off / **清除**，`on` 选中 | ✅ |
| 切到 beta（**无行**） | **继承（未设行）** / on / off，`继承` 选中 | ✅ 继承态不拿解析值当基线 |
| beta 选 off | off 选中 | ✅ |
| 切回 `*` | 恢复 on/off/清除，`on` 选中 | ✅ 逐 scope 重置 dirty |

### 命令生成 + 端到端闭环

页面生成（复用 `FleetCmd.flagCommand` 的 `shq` SSOT）：

```
flywheel-comm feature-flags clear --name 'doc_flow' --project '*' --reason 'phone-report'
flywheel-comm feature-flags set --name 'doc_flow' --to 'off' --project 'beta' --reason 'phone-report'
```

`--project '*'` 带单引号 → zsh glob 不会展开 ✅
把这两条**原样**粘回真 CLI 执行：均 exit 0，DB 行与生效值按预期变化 —— 页面 → 粘贴 → Lead 执行的
产品闭环成立 ✅

### CSP nonce（实现方标注的疑点，已排除）

投递后的托管页由 report-registry 在 serve 时铸 nonce。核查发布前的原始 HTML：
**全页仅 1 个 `<script>` 标签、仅 1 个 `__CSP_NONCE__` 占位符，本单新增的控件 JS 就在这个标签里**。
因此本单没有引入「新脚本没 nonce → 发布后被 CSP 拦掉、控件变死」的风险 ✅

---

## 6. 管理台（只读显示面）

`/api/fleet/snapshot` 的 `doc_flow`：

- `*` 行 = on → `global.current = true`；清掉 `*` 行 → 回落 registry 默认 `false` ✅
- `writeCapability.writable = false`，reason 指路
  `flywheel-comm feature-flags set --project (or clear --project)` ✅
- `projectOverrides` 显示 enrich 后的逐项目值 ✅

---

## 7. Discord 面判定与诚实边界（honest boundary）

**判定：本单是 Discord-capable 的 —— 它改的正是经 `flywheel-comm feature-flags report`
→ `publish-report` → Discord 投递的那份 HTML 的渲染。** 因此我按标准规矩去开了 529 房。

**已做**：`scripts/test-deploy.sh 2 --from-branch flywheel-FLY-2100` 成功起房，slot Bridge 的
`/health` 报 `buildSha == artifactBuildSha == 57f16d7f7`（= 我的 HEAD），**确认跑的是本分支代码**。

**未能在 529 房内完成真 Discord 投递，两条结构性阻断，均为既存行为、与本单无关**：

1. 529 slot 以 `FLYWHEEL_PROJECTS` env-pin 启动，而 `plugin.ts` 的
   `if (!process.env.FLYWHEEL_PROJECTS)` 才挂载 fleet console。
   **该门在 `origin/main` 已存在**（已用 `git show origin/main:…` 核对），
   所以 slot 上 `/api/fleet/*` 必然 404 —— flag 报告页在 529 房里根本不对外服务。
2. slot Bridge 未设 `TEAMLEAD_API_TOKEN`，`/api/reports/*` 关闭（`publish failed (503)`）；
   且 `publish-report` 对 runner 直接返回
   `runner has no report delivery authority` —— 投递本就是 Lead 动作，按设计如此。

**风险评估**：本单对 `feature-flags report` 这条路径的改动为**零**（读 diff 确认：同一个
`?interactive=1` URL、同一个 `publishReport` 调用、`--project` 语义按子命令干净分离，
report 的 `--project` 仍默认 `flywheel`）。变的只有那份 HTML 的**页面正文**，
而正文我已在**真浏览器 + 真 Bridge + 真 scoped DB 数据**下逐项验过（第 5 节），
并排除了 CSP nonce 这一条唯一「本地能跑、发布后可能死」的差异。

**未覆盖的那一格**：一条真的 Discord 消息（含缩略图 + 链接）落进频道的目视确认。
需要 Lead 侧执行投递才能补上。风险等级：低（envelope 未改动）。

**其他边界**：
- 我在 sandbox mirror（`xrliAnnie/flywheel-qa-sandbox`）上留下了分支 `flywheel-FLY-2100`
  —— 529 房要求分支先推到该 QA 镜像。未删除：push guard 在 pre-push 阶段就拦截远端删除，
  没有写法能过。留在 QA 镜像上无害。
- 本次未验运行时消费点（Blueprint / scheduler 仍读 config.yaml）—— 计划明确划到 C 单，
  且页面已用黄标向 founder 明示这个分歧窗口。

## 8. 生产隔离证据

- 全程独立 `HOME` / `TEAMLEAD_DB_PATH` / `TEAMLEAD_PORT` / `FLYWHEEL_DELIVERY_SECRET_PATH`；
  未调用 `restart-services.sh`。
- 生产库只做过一次 `mode=ro` 的 `VACUUM INTO` 拷贝，原库当时 mtime 未变。
- 生产 `~/.flywheel/delivery-secret.*` mtime 仍是 7/19，未被触碰 ✅
- 收尾：529 slot 已 teardown，19872 / 19877 / 19878 三个端口均确认释放。
- 生产 Bridge 在我开跑时（20:31）不在监听，约 20:37 由 launchd 自行拉回（uptime 与之吻合）——
  这也是本会话开头两次 `flywheel-comm stage set` 报错的真因，不是假超时。
