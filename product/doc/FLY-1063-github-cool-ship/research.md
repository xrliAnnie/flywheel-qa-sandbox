# FLY-1063 GitHub PR 🆒 → 自动 CI/CD ship — 调研

Issue: FLY-1063 (https://linear.app/geoforge3d/issue/FLY-1063/prd-github-pr-comment-自动-cicd-ship系统-全-repo-通用annie-点名-hl-出-prd)
日期: 2026-07-09
基于: exploration.md（同文件夹）

> 本文档记录**当前系统真实现状**（带 file:line 证据）+ **GitHub 侧机制调研**，供 proposal.md 引用。内部工程文档，可含代码路径。

---

## A. 当前 ship / 审批 / 部署链现状（证据）

### A.1 GitHub 侧的 🆒 已经存在，但只是「机械触发器」

`.github/workflows/ship-on-comment.yml`：

- 触发：`issue_comment` 且 `github.event.comment.body == ':cool:'`，PR 为 open（`ship-on-comment.yml:22-25`）。
- 授权判断：**只看 GitHub collaborator 权限**——commenter 必须是 admin/write，否则拒（`:34-54`）。**不查任何审批账本**。
- 拒 fork PR、draft PR、已 merged（`:62-83`）。
- 跑全套 CI（install/build/typecheck/lint/test，`:113-129`），成功后 squash-merge（sha 绑 `HEAD_SHA`，`:143-151`）+ 删分支。
- **没有任何 deploy 步骤**。

### A.2 谁在发这条 🆒 —— 是 Runner，不是 founder

Runner 提示词（`packages/edge-worker/src/Blueprint.ts:1459-1490` 的 approve_to_ship FINISH 块）：

- 先 `gate approve_to_ship --no-block`（拿 questionId）→ `complete --route needs_review` → 挂起等唤醒。
- 被唤醒后**必须先** `verify-approval --pr-head $(git rev-parse HEAD)`，只有打印 `approved: true` 才能 ship；「唤醒消息本身不携带任何权威」（`Blueprint.ts:1474-1476`）。
- 然后 **`gh pr comment <N> --body ":cool:"`**（Blueprint 提示词把它叫「trigger deploy」，`:1479`）—— 但**机械上该 workflow 只跑 CI + squash-merge，不含任何部署步骤**（见 A.7）；部署是分开的 self-ship 腿。
- 「:cool: deploy workflow 是唯一 merge 路径——Runner 绝不自己 `gh pr merge`」（`:1481`，FLY-248）。

即：**GitHub 上的 :cool: 是 Runner 在 Discord 审批通过之后补发的**。这条 comment 的 GitHub actor 是共享机器身份 **xrliAnnie**（见 A.6）。

### A.3 真正的授权账本 = CommDB gate + verify-approval

- `verify-approval`（`packages/flywheel-comm/src/commands/verify-approval.ts`，FLY-191 Phase 2）是 ship 的本地硬校验，全部 fail-closed：
  1. `--pr-head` 必须是完整 40-hex sha（`:104`, `:187-192`）；
  2. 读 StateStore（`~/.flywheel/teamlead.db`）session 行的 `status / pr_head_sha / review_question_id / codex_skip`（`:222-226`）；
  3. `review_question_id` 必须已绑定，**无「按时间取最新」的兜底**（FLY-1041 关掉的同秒歧义洞，`:250-262`）；
  4. 绑定的 CommDB 行必须是 `type=question` + `checkpoint=approve_to_ship` + `from_agent==execId`（`:266-283`）；
  5. 必须存在一条 response，解析为结构化 JSON 且 `approved===true`（纯文字「approved!」无效，`:284-318`）；
  6. **founder 归属**：写入者必须是 founder 的 Discord id / `bridge` / `bridge-founder-consent`（`:320-351`；`packages/flywheel-comm/src/founder-attribution.ts:28-31` 的 `TRUSTED_BRIDGE_APPROVAL_WRITERS`）。Lead 自批会被 `response_not_founder_attributed` 拒 —— **但这条是有条件的**：归属闸开启（kill-switch `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0` 可关）**且** founder id 能从 `~/.flywheel/.env` 解析出来时才生效；解析不到 founder id 则**跳过**这步（`verify-approval.ts:320-351` 自述）。
  7. session `status==approved_to_ship` 且持久化的 `pr_head_sha === 调用方传入的 --pr-head`（**head-sha 绑定**：`verify-approval` **不自己** `git rev-parse HEAD`，而是比对调用方传入的 `--pr-head` 参数；Runner 恰好传的是 `git rev-parse HEAD`，但验证器本身不算它。旧 head 的批准永不生效，`:353-377`）；
  8. FLY-827 Codex code-review 硬闸：本 head 还需一条 approved/skipped 的 `codex_review_record`（`:379-395`）。

- **FLY-1041 单一可绑 gate**：任一时刻只有一个 `approve_to_ship` gate 可绑（feature flag `ship_gate_retire`，`packages/config/src/feature-flags/registry.ts:1235-1260`；retire 逻辑 `packages/flywheel-comm/src/db.ts:333-360`；sweeper 兜底 `packages/teamlead/src/bridge/gate-poller.ts:349-379`）。

### A.4 审批入口今天已经是「多源汇一账本」—— GitHub-🆒 是自然的第 3 个源

审批信号架构本来就是**可插拔多源**，都经同一个写原语汇入同一账本：

- ✅ reaction 源：`packages/teamlead/src/bridge/approval-signal/reaction-approval-source.ts`——founder 在 ship-gate 通知消息上点 ✅ = 确定性审批，绑 `targetMessageId`，「✅ only —— 🆒 is not used (Annie)」（文件头注释 `:11`；注：这是 **Discord 里的** 🆒 不用，与本 issue 的 **GitHub** 🆒 无关）。
- founder-reply 文字源：`founder-reply` 路径。
- 两者都经**同一个可信写原语** `packages/teamlead/src/bridge/approval-signal/write-gate-response.ts`（守 checkpoint / 当前 question 匹配 / awaiting_review 状态 / 幂等）写进 CommDB。

**结论**：加一个「GitHub founder-🆒 源」= 在 `approval-signal/` 下新增第 3 个 source，检测到 founder 亲发的 GitHub 🆒 → 经同一个 `write-gate-response` 写 founder-attributed `approved:true`。架构上是**自然扩展，不另起炉灶**。这是选项 1 在工程上「便宜」的根本原因。

### A.5 GitHub 侧对账本「无知」；只有事后对账

- `ship-on-comment.yml` 从不读/写 CommDB / StateStore / verify-approval / founder-consent。它唯一的闸是 GitHub 写权限。
- 现有的只是**事后对账**：`packages/teamlead/src/bridge/external-merge-reconcile.ts`（FLY-945 Fix D，对「走了 runner self-ship 之外」的合并做兜底；Path 2 要求 founder-attributed `approved:true` + `headRefOid===绑定的 pr_head_sha`，否则报警不归档）；`merge-ship-gate.ts`（FLY-869 B，合并但无 ship 资格→durable `merge_block` marker）。

### A.6 身份现状 —— 机器 actor 与 founder 个人账号都是 xrliAnnie(ADMIN)

- 机器发 :cool: 用的 GitHub 身份 = **xrliAnnie**（**硬证据**见 §C.1：100% 真实 ship run 的 actor 都是 `xrliAnnie` / `type=User`；repo 也以 xrliAnnie clone，`docs/operations/fleet-provisioning-runbook.md:223` —— 但那只是 clone 命令、单独不足以证明 ship actor，故以 run-actor 实测为准）。
- Annie 本人的 GitHub 账号**也是 xrliAnnie**。
- 且 `xrliAnnie` 是 repo **ADMIN**，能绕 branch protection（FLY-350 M-2，`CLAUDE.md:133`：「actor=xrliAnnie=ADMIN 能绕 branch protection，比预期更宽」；Annie 接受 admin/contract-only 信任级，「非-admin actor 结构保护 = follow-up」）。
- 校验工具 `packages/teamlead/scripts/verify-merge-actor-denied.sh`：解析 gh 实际认证的 actor，若 mergeable/未保护/**actor 是 admin** 则 exit 1（fail-closed）。

→ **这正是选项 1 的前置**：workflow 只能看到「一条 :cool: 来自 xrliAnnie」，分不出「Annie 亲拍」还是「bot 机械按」。

### A.7 部署 —— 与 merge 分开的第二条腿，且只服务 flywheel 自己

- merge 腿 = `ship-on-comment.yml`（GitHub Actions，`ubuntu-latest`）。**无 deploy**（`doc/engineer/research/archive/FLY-20-auto-restart-cd.md:10-13` 明确：「:cool: → CI → squash merge → 删分支 → 成功 comment；无任何本地重启逻辑」）。
- deploy 腿 = 本机 launchd self-ship 更新器：Runner merge 后跑 `scripts/self-ship-restart.sh --target-sha <squash sha>`（`scripts/self-ship-restart.sh:1-22`）→ 往 `~/.flywheel/self-ship-pending.d` 塞 durable marker → launchd `com.flywheel.updater`（`QueueDirectories` 监听）→ `scripts/update-flywheel.sh` pull origin/main + `scripts/restart-services.sh` 重启 Bridge+Leads + 推进 `~/.flywheel/deployed-sha`（`restart-services.sh:27`）。
- **这套 deploy 链只服务 flywheel repo 本机（self-hosting）**。没有基于 GitHub runner 的 deploy，也没有 self-hosted GitHub Actions runner。

### A.8 founder-consent Bridge 硬闸（FLY-175）覆盖面

- `FounderConsentEvaluator`（`packages/teamlead/src/bridge/founder-consent/evaluator.ts`）拦 reserved 端点（`reserved-endpoints.ts:12-23`：approve/close/terminate/reject/defer/shelve/retry/approve_to_ship_gate），双挂 `/api/actions/*` + `/actions/*`。
- 三模式 off/audit_only/enforce，**默认 off**（`middleware.ts:8-11`, `config.ts:106-117`）。
- **GitHub 上的 :cool: 是这个 evaluator 之外的平行路径**——ship-on-comment.yml 不经 Bridge。选项 1 的「GitHub-🆒 写账本」正好把这条平行路径拉回统一账本。

### A.9 全 repo 分发现状

- `.github/workflows/` 只有 `ci.yml` + `ship-on-comment.yml`，**零 `workflow_call` / composite action / org `.github` 模板**。
- `scripts/setup-new-project.sh` **不**装 ship-on-comment.yml 进新 repo——今天它只存在于有人手工拷贝的地方（flywheel、GeoForge3D 的变体 "Deploy on :cool Comment"，见 `~/.claude/commands/ship-pr.md:165-174`）。
- 唯一现成的跨 repo 分发机制 = **flywheel-skills**（canonical `xrliAnnie/flywheel-skills`，launchd skills-sync job，无需重启 Bridge —— 见 CLAUDE.md 里程碑表 FLY-510 条目，具体行号会随表增补漂移）。是「把文件铺到所有 repo」的现成先例。
- 注意别混：`product/doc/FLY-1020-workflow-templates/` 讲的是 Flywheel 内部 DAG/agent.md pipeline 模板，**不是** GitHub workflow。

---

## B. GitHub 侧机制调研（做「全 repo 通用 + 身份可辨」需要的原生能力）

### B.1 Reusable workflow（`workflow_call`）—— 推荐的通用形态

- 中央 repo（如 flywheel 或专门的 `xrliAnnie/.github` / `flywheel-ci`）放一份 `on: workflow_call` 的核心 workflow，封装「身份校验 → CI → merge → 记账」。
- 每个 repo 放一个**瘦 caller**（约 5-10 行），`uses: xrliAnnie/<central>/.github/workflows/cool-ship.yml@main`，`secrets: inherit`，并把 repo 专属的 deploy 作为后续 job 挂在 caller 里。
- 升级只改中央一份；各 repo caller 基本不动。deploy 腿天然 per-repo override。
- 分发瘦 caller：可复用 flywheel-skills 式 sync，或 `setup-new-project.sh` 增一步写入 caller。

### B.2 判定「谁发的 comment」

- workflow 里 `github.event.comment.user.login` = commenter 的 GitHub login，可靠。
- 只要**机械 :cool: 用的账号 ≠ Annie 个人账号**，workflow 就能一眼分清「人拍的」vs「机器按的」。
- 今天两者都是 xrliAnnie → 撞车（A.6）。故 B.3。

### B.3 身份分离的两种做法（选项 1 前置）

| 做法 | 机械 :cool: 用什么身份 | founder 亲拍用什么身份 | 判别式 |
|------|------------------------|------------------------|--------|
| **专用机器账号** | 新建一个 `flywheel-bot`（或类似）GitHub 账号，Runner 用它的 fine-grained PAT 发机械 :cool: | Annie 保留 xrliAnnie 作纯个人审批身份 | login 字符串白名单（`type` 仍是 `"User"`） |
| **GitHub App** | 装一个 App，Runner 经 installation token 发机械 :cool:，作者显示为 `<slug>[bot]` | Annie = xrliAnnie 个人 | **结构性**：`user.type=="Bot"`（本仓 `linear[bot]` 实测证实） |

两种都能让「founder 亲发的 🆒」在 workflow 里唯一可辨，但**硬度不同**。四个维度的完整取舍、实测证据、以及两条路都绕不开的一个安全硬伤，见 **§C（身份分离深挖）**——那是 HL 点名要给 eng 拆单用的。

### B.4 把 GitHub 🆒 记进账本（选项 1 的「记账」环）

选项 1 落地时，GitHub-🆒 源需要一条从「GitHub 检测到 founder 🆒」到「CommDB 写 founder-attributed approved」的可信通路。两种接法（实现级，供参考，非本提案 verdict）：

- **Bridge 侧监听**：Bridge 已有 GitHub 事件能力，可在 approval-signal 里加一个 GitHub-🆒 poller/webhook 源，检测到 founder 亲发 🆒（作者=Annie 个人账号、绑当前 PR head）→ 经 `write-gate-response` 写账本 → 现有 self-ship 流照跑。**复用现有多源架构（A.4），最干净**。
- **workflow 侧回写**：workflow 检测到 founder 🆒 后回调一个受 token 保护的 Bridge 端点写账本。多一条网络边界，安全面更大。

倾向前者（Bridge 侧多源），与 A.4 的既有架构一致。

### B.5 与 Codex 硬闸 / founder-only-authority 的关系

- verify-approval 的 Codex code-review 硬闸（A.3 第 8 条）与审批入口正交——无论 🆒 从 Discord 还是 GitHub 来，本 head 都仍需过 Codex review 记录。**选项 1 不削弱这条**。
- founder-only-authority 合同（`packages/teamlead/lead-rules-base/founder-only-authority.md`）约束的是 **Lead** 不得自行 merge/关 runner。选项 1 让 founder 亲发 GitHub 🆒 = 一次真 founder 授权，正是合同想要的「founder 拍板」，不冲突。

---

## C. 身份分离深挖（选项 A 的 P0 前置）—— bot 账号 vs GitHub App

> HL 要求：若 Annie 选 A，这条前置必须写清两条路的具体取舍，因为它直接决定 eng 怎么拆单。
> 下面每条事实都**实测过或查过官方文档**，不凭记忆。

### C.1 实测证据（本仓真实数据，2026-07-09）

| 事实 | 证据 |
|------|------|
| **今天 100% 的真实 ship run 由 `xrliAnnie` / `type: "User"` 触发** | `gh api .../workflows/254044724/runs`：所有 conclusion≠skipped 的 run，`actor=xrliAnnie`、`triggering_actor.type=User`。**没有任何信号能区分「Annie 亲拍」与「bot 机械按」** |
| GitHub App 发的 comment 作者是**结构性可辨**的 | 本仓 PR #524/#526/#512 的 linear comment：`user.login="linear[bot]"`、`user.type="Bot"`（对比 `xrliAnnie` 是 `type="User"`） |
| Runner 当前 gh 认证身份 = Annie 本人账号 | `gh api user` → `{"login":"xrliAnnie","type":"User"}` |
| 仓库是**个人账号**下的 private repo，不是 org | `gh api repos/xrliAnnie/flywheel` → `owner_type="User"`, `private=true` |

**推论**：`user.type=="Bot"` 是一个**结构性判别式**，比「按 login 字符串白名单」更硬。

### C.2 两条关键 GitHub 机制（查官方文档确认）

1. **用 workflow 自带的 `GITHUB_TOKEN` 发的 comment 不会再触发新的 workflow run**（`workflow_dispatch`/`repository_dispatch` 除外）——这是官方的防递归设计。而 **PAT 或 GitHub App installation token 发的 comment 会触发**。
   → 机械 `:cool:` 必须来自 PAT 或 App token，**不能**用 workflow 的 GITHUB_TOKEN。这条限制两条路都绕不开。
2. **私有 repo 的 reusable workflow 可以跨 repo 复用**（2022-12 GA）：在该 repo 的 Settings → Actions → General → Access 选 *"Accessible from repositories owned by `<user>`"*。
   → 个人账号（非 org）**也能**做「中央一份 + 瘦 caller」。但**没有 org 级 `.github` 模板仓、没有 org audit log**，这两条能力不存在。

### C.3 取舍对照（HL 点名的四个维度）

| 维度 | **专用 bot 机器账号**（如 `flywheel-bot`） | **GitHub App**（如 `Flywheel Ship Bot`） |
|------|---------------------------------------------|------------------------------------------|
| **安装成本** | 建一个 GitHub 账号（需独立邮箱 + 2FA）→ 邀请为各 repo collaborator(write)。个人账号 Free 版**私有仓 collaborator 无限、$0**。Runner 把 gh token 换成 bot 的 fine-grained PAT 即可 | 建 App（挂个人账号）+ 生成 private key + 逐 repo 安装。Runner 在**本机**要自己把 private key 换成 installation token（JWT → token，1h 过期、需刷新）——比 PAT 多一层机械 |
| **能不能代表 bot 发 comment** | 能。就是个普通用户 PAT。作者显示 `flywheel-bot`、但 **`type` 仍是 `"User"`** | 能（需 `issues: write`）。作者显示 `<slug>[bot]`、**`type="Bot"`** |
| **founder 可辨性（本题核心）** | 只能靠 **login 字符串白名单**（`login=="xrliAnnie"`）。可用，但是软判别 | **结构性判别**：`user.type=="Bot"` 一票否决机器身份，再叠 login 白名单双保险。更硬 |
| **审计可见性** | 长期 PAT（fine-grained 可限 repo + 设过期）。个人账号无 org audit log | 权限粒度细、token 短命（1h）。安全姿态更好。个人账号**同样无 org audit log** |
| **对 xrliAnnie 的影响** | 相同：她的账号不再被机器占用，她的 🆒 才有意义。**最小改动 = 只把 `:cool:` 那条 comment 换成 bot 身份**（`git push` / `gh pr create` 可暂留 xrliAnnie，后续再迁） | 同左 |

### C.4 一条两条路都必须改的硬伤（重要）

今天 `ship-on-comment.yml` 的授权判断是「commenter 有 **admin/write** 权限」（`:34-54`）。

在**选项 A** 下这是**审批伪造面**：任何有 write 的 collaborator（含未来的 bot、其他 agent）发一个 🆒 就等于替 Annie 批了。

→ 选项 A 落地时，审批路径的判断必须从「有 write 权限」收紧成 **「commenter 恰为 founder 本人」**，即：

```
comment.user.login == '<founder-login>'  &&  comment.user.type == 'User'
```

这不是可选优化，是选项 A 的**安全底线**。（选项 B 下 GitHub 🆒 不承载授权，此条降级为「防非-founder 误触」的普通鉴权。）

### C.5 遗留的子设计（选项 A 定了之后才需要答，不在本提案 verdict 内）

选了 A 之后，「Discord 批准」那条路仍然需要一个合并触发器。三种子形态，各有取舍，留到正式 PRD：

- **A-i**：workflow 同时接受「founder 亲发 🆒」(= 授权+执行) 和「bot 发 :cool:」(= 仅执行，授权早已在账本里由 Discord 建立)。改动最小，但 workflow 无法自己核账本，安全性仍靠「bot 只在 verify-approval 通过后才发」这条契约。
- **A-ii**：Discord 路不再经 comment，改由 Bridge 在 verify-approval 通过后直接调合并 API。账目最干净，但与 FLY-248「Runner 绝不自 merge / :cool: 是唯一 merge 路径」的现有契约冲突，需一并修订。
- **A-iii**：只认 founder 亲发 🆒 为唯一合并触发器，Discord 批准仅作预备状态。最简单也最严格，但 Annie 失去「在 Discord 一句 ship 就走完」的便利。

**推荐倾向 A-i**（改动最小、复用现有账本与硬闸），但这条要 Annie 拍完 A/B 之后在正式 PRD 里定。

### C.6 引用来源

- GitHub Docs — Trigger a workflow（GITHUB_TOKEN 防递归规则）：https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- GitHub Changelog — 私有仓共享 actions / reusable workflows GA：https://github.blog/changelog/2022-12-13-github-actions-sharing-actions-and-reusable-workflows-from-private-repositories-is-now-ga/
- GitHub Docs — Reuse workflows（Access 设置）：https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub Docs — GitHub 计划（个人账号私有仓无限 collaborator）：https://docs.github.com/get-started/learning-about-github/githubs-products
- 本仓实测：`gh api repos/xrliAnnie/flywheel/actions/workflows/254044724/runs`、`.../issues/524/comments`、`gh api user`

---

## D. 给 proposal 的关键结论

1. 🆒 workflow **已存在**（flywheel），本题不是从零造，而是「升级 GitHub 为一等审批面 + 定 source-of-truth + 全 repo 复用」。
2. source-of-truth 分叉（选项 1 vs 2）是 founder 决策，账本作唯一真源两者都成立。
3. 选项 1 工程上「便宜」——审批多源架构已存在（A.4），GitHub-🆒 是自然第 3 源。
4. 选项 1 的真前置 = **GitHub 身份分离**（A.6/B.3/C），不解决做不了。实测：今天 100% 真实 ship run 的 actor 都是 `xrliAnnie`/`type=User`，零区分度（C.1）。
5. 通用形态 = reusable workflow（B.1）；deploy 是分开的第二条腿、per-repo（A.7）。个人账号（非 org）**也支持**私有仓跨 repo 复用，但没有 org 模板仓 / org audit log（C.2）。
6. **新发现的安全硬伤**：今天 workflow 的授权闸是「commenter 有 admin/write」。选项 1 下这是**审批伪造面**（任何 write collaborator 都能替 Annie 批）。必须收紧成「commenter 恰为 founder 本人」——这是选项 1 的安全底线，不是可选优化（C.4）。
7. 身份分离两条路里，**GitHub App 给的是结构性判别式**（`user.type=="Bot"`，本仓 `linear[bot]` 实测证实），bot 机器账号只能靠 login 白名单；代价是本机要多一层 installation-token 机械（C.3）。
8. 一条两条路都绕不开的机制约束：**workflow 自带的 `GITHUB_TOKEN` 发的 comment 不会再触发 workflow**（官方防递归），所以机械 :cool: 必须来自 PAT 或 App token（C.2）。
