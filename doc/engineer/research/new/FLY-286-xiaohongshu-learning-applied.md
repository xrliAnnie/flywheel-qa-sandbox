# Research: 小红书学习系统首次生产应用 + 事后 HTML review 改造 — FLY-286

**Issue**: FLY-286
**Date**: 2026-06-16
**Source**: `doc/engineer/exploration/new/FLY-286-xiaohongshu-learning-applied.md`
**前置审计**: FLY-222 plan/runbook、现有 SKILL.md、`xiaohongshu-state.ts`、`xiaohongshu-scheduler.ts`、FLY-203 reports 基建(`reports-route.ts`/`report-registry.ts`)、founder-html-delivery skill

---

## 1. 现有基建深度审计（可复用面）

### 1.1 state helper（`packages/flywheel-comm/src/xiaohongshu-state.ts`）— 几乎全可复用
导出能力：`acquireLease/renewLease/releaseLease`(CAS + owner-fence)、`computeNewNoteIds`(全窗口差集)、`markProcessed/recordPending/dropPending`、`recordOperationIntent/markOperationDone/findOperation`(operation-id 幂等：`collection+noteId+kind+candidateId`)、`computeNextDueAt/isDue`、`markBootstrapped`。
→ **去掉 prune gate 后这些仍然需要**：lease(单 Runner/收藏夹)、processed 差集(增量)、operation 幂等(自动建 issue 不重复)、next-due(weekly)、bootstrap(首次不洪峰)。**owner-fencing 仍是并发正确性的基石。**
→ 需扩展：`OperationKind` 现为 `"issue" | "memory"`，新模型要加 `"analysis"`(持久化每条分析结果)；state 里加 raw-store 引用 / analysis 结果指针 / 本轮 report token。

### 1.2 scheduler（`packages/teamlead/src/xiaohongshu-scheduler.ts` + `scripts/`）— 复用，少改
`planLearningRuns`(枚举 enabled collection → due 判定) + `executeLearningPlan`(createTriggerIssue find-or-create + startRun) + entry(`scripts/xiaohongshu-scheduler.ts`) + `tick.sh`(FLY-176 lockdir) + plist(DRAFT,02:30 nightly)。
→ **基本不动**：仍是"每收藏夹一条固定 trigger issue + weekly due + spawn 一个 Runner"。需做的是**安装**(plist→launchd)+ trigger body 里带新参数(若 config 扩展)。两个 claude 收藏夹 = 两条 trigger issue,各自 due。

### 1.3 config（`packages/config/src/{types,ConfigLoader}.ts`）— 扩展
现 `XiaohongshuLearningConfig.collections[]` 已含 `collection_id/label/lead_id/department_label/target_linear_project/cadence/max_fetch/video_opt_in` —— **per-collection mapping 雏形已在**(正是 General/Specific 的 Specific 层)。
→ 可能新增字段：`review_channel`(web-local / web-public / discord / sheet，见 §4)、`first_run_cap`(首次洪峰上限，见 §6)。default-off + tuple 校验 + reverse-compat sentinel 保持。

### 1.4 抓取 / 视频 / 图片 — 全复用
MCP 握手(`/mcp` JSON-RPC,serial,长超时,retry-after-idle)、`get_collection_content`(无 cursor,≤200,total>200 告警)、`get_feed_detail`(title/desc/comments/imageList)、图片 `sips`→`Read`(vision)、视频 `yt-dlp`+cookie→`gemini -m gemini-2.5-pro -p "@file.mp4"`(凭据卫生 0600/umask/trap、xsec_token ~15min 即用即下、并发 4-6)。**这些是 QA 验过的核心能力，原样保留。**

### 1.5 FLY-203 reports 基建（`reports-route.ts` / `report-registry.ts`）— 复用读、回写要新建
`POST /api/reports/publish`(stage→Vercel deploy→commit，返 `https://fw-reports-xxxx.vercel.app/r/<token>/`) + `POST /api/reports/deliver`(Discord 一条:截图+链接)。`flywheel-comm publish-report` CLI 封装。retention 100/10MB/7天。
→ **复用作"只读交付"**：日终 summary + per-post review 页可经此托管 + Discord 投递(Annie 手机可看)。
→ **🔴 回写不能复用**：托管页 CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:` → **JS/form/跨域 connect 全禁**，页面纯静态只读。评论提交(option A)必须另设回写宿主(见 §4)。

---

## 2. 新控制流设计（替换 prune gate）

```
1. lease(收藏夹级，复用) → 2. fetch 收藏夹全窗口(复用) → 3. diff 出新增 + bootstrap 首次只 baseline(复用)
4. 逐条串行抓 raw(text/image/video)→ 存 raw(临时) + 持久化每条 analysis intent
5. bounded 并行(4-6)：video download+Gemini / image vision / text 蒸馏 → 每条产出 {summary, judged_useful, draft?}
6. 逐条 judge：useful → 自动 create_issue(Linear MCP, operation-id marker 幂等, 建前查重) ; not useful → 记 no-action
7. 持久化全部 analysis 结果(结构化 JSON) + 生成 review HTML(每条: 讲了啥 / action / 评论位) + 日终 summary
8. 经 review-channel adapter 交付给 Annie(只读托管 + 可回写通道，见 §4)
9. (异步/下一 tick) 收到 Annie 评论 → 按评论回写：关掉不该建的 issue / 补建漏的 / 把她的判断沉淀进 project memory(学标准)
10. mark-processed(复用) + set-next-due(复用) + release-lease + complete --route no_code(复用)
```

**与现有的关键差异**：
- 步骤 6 **自动建 issue**(无事前 gate)。安全不再靠"未 FINAL 不建"——靠 ① operation-id marker + 建前查 Linear(不重复) ② Annie 事后能一键关掉(可逆) ③ 自动建的 issue 进的是 **Flywheel backlog**(她本来就会 triage)。
- 步骤 9 是**新的人在回路**：从"事前授权"变"事后纠正 + 学习"。
- 视频分析从"逐条串行"变"**bounded 并行**"(她的明确要求,省时)。

---

## 3. 幂等 / 安全（去掉 gate 后如何不失控）

- **不重复建**：复用 operation-id(`collection:noteId:issue:candidateId`) + issue description 写 immutable marker + 建前查 Linear(crash-safe，现有机制)。
- **可逆**：自动建的 issue 都带 provenance(来自哪条 note / collection / run) + marker；Annie 评论"不该建"→ Runner `close/cancel` 该 issue(Linear MCP)。
- **首次洪峰**(§6)：bootstrap 首次只 baseline 不建 → 避免 124 条一次性建一堆。增量后每周新增量小。
- **学标准**：Annie 的"这条不对/漏了"评论 → 写入 project memory(`[XHS-MEMORY-WRITE]` 经 Lead，path B，复用) 作为"她的判断标准"，下轮分析时 `/api/memory/search` 取来参考。v1 = 软学习(参考)，非硬规则引擎。

---

## 4. 🔴 回写宿主（核心待定 — keyed on Annie 的设备答复）

约束(已查实)：① Vercel 托管页 CSP 禁交互；② Annie 常在手机 Discord 上 review。把 review-channel 做成 **General 引擎的可插拔 adapter**(这正是 General/Specific 抽象正解)，候选实现：

| adapter | 交互 | 设备 | 新基建 | 安全 |
|---------|------|------|--------|------|
| **web-local**(Bridge localhost 服务交互页 + same-origin POST 评论) | ✅ 真评论框+提交 | 仅本机(她在电脑前) | Bridge 新路由(relaxed CSP) + 评论 store | 本地不公开,低 |
| **web-public**(公网交互页 + 写后端) | ✅ | 任意(含手机) | 公网写 endpoint + token + CSP 放松 + founder-consent 面 | 公网写面,高,需评审 |
| **discord**(只读 Vercel 页手机看 + 她在 thread 逐条回 / reaction) | ⚠️ 半结构化 | 手机✓ | 解析 thread 评论 | 复用现有,低 |
| **sheet**(Google Sheet 每条一行+评论列,gws 回读) | ✅ 结构化 | 手机✓(Sheets App) | gws 读写 | 复用 gog,低 |

**待 Annie 答"手机 vs 电脑前 review"**：
- 电脑前 → **web-local**(最贴她选的 A,无公网暴露)。
- 手机为主 → **sheet** 或 **discord**(web-public 成本/风险大,非首选)；Vercel 只读页仍发给她手机扫一眼。

**General 抽象**：引擎只依赖 `ReviewChannel` 接口(`deliver(report) → channelRef` / `collectFeedback(channelRef) → comments[]`)；具体 adapter 由 config `review_channel` 选。→ 以后别项目换渠道 = 换 adapter 配置，引擎不动。

---

## 5. General / Specific 抽象边界

- **Specific(config 一行 mapping)**：`collection_id` + `target_linear_project` + `cadence` + `lead_id`/`department_label` + `video_opt_in` + `review_channel`。
- **General(通用引擎)**：fetch / raw-store / 逐条分析(bounded 并行) / judge / 自动建 issue(幂等) / analysis 持久化 / HTML 生成 / review-channel adapter / 评论回写 / 从评论学习 / summary / state 机。
- **接缝**：引擎吃一个 `LearningRunSpec`(= Specific config 解析后) + 注入的 `ReviewChannel` adapter；其余全通用。新项目接入 = config 加一行 collection mapping(+ 选 adapter)。**FLY-295 收口此层**(General 在 286 同步抽)。

---

## 6. 首次全量洪峰

两个 claude 收藏夹 ~124 条。若首次全分析+自动建，可能一次建几十个 issue → 淹没 Annie 的 backlog + review 页。
- **复用 bootstrap**：首次只 baseline(`markBootstrapped`)、不分析不建 —— 但这跟 Annie"先扫全部 raw 存下来 + 逐条分析"愿景冲突(她要首次就分析存量)。
- **方案(plan 定)**：首次**分批**——baseline 全窗口，但分多个 weekly tick / 或一次 run 内分批(每批 N 条,建 issue 设 `first_run_cap`),让 review 页可消化;或首次只产 analysis + summary、**不自动建 issue**(全部留 review 页让她勾要建的),之后增量才自动建。→ **这条要确认 Annie 偏好**(首次就自动建 vs 首次只分析待她勾) —— 列入 plan 的 open question(可与设备问题合并问)。

---

## 7. PR 切分 / 跨仓

1. **flywheel 基建 PR**：config 扩展(review_channel/first_run_cap) + state helper 扩展(analysis kind / raw 引用) + analysis 持久存储 + **review-channel adapter 接口 + 选定 adapter 实现**(回写后端) + General 引擎接口。
2. **flyview-skills skill PR**：新控制流 SKILL.md(替换 prune-gate 段为 auto-analyze→judge→auto-create→review-adapter→writeback→learn)。
3. **flywheel scheduler PR**：plist 安装 + bootstrap 文档(+ trigger body 新参数)。
4. config 落 flywheel `.flywheel/config.yaml`(claude + claude-多机) → 真机 pilot(CoS 带 Annie)。

> 上线纪律(复用 FLY-205/222 教训):改 types.ts 后须 build;config 进内存须 Bridge 重启一次;skill 靠下轮 sync + 新 Runner spawn 生效;plist 验过才装 launchd。

---

## 8. Open（plan + codex-design-review 定）

1. 🔴 review-channel adapter 选型(待 Annie 设备答复,§4)。
2. 首次:自动建 vs 只分析待勾(§6,可合并问 Annie)。
3. analysis 持久存储格式/位置(state helper 扩展 vs 新 store)。
4. 评论→close/create 回写的触发(同 run 内等 vs 下一 tick 异步消费)——倾向**异步**(她 review 可能隔天;Runner 不 hang),即一条 trigger 的 run 产 report 就 `no_code` 完成，回写在**下一 tick 或一个专门的 feedback-consume run** 做。
5. 从评论学标准:v1 软学习(memory 参考)边界。
6. General 引擎落在哪个包(flywheel-comm 复用 vs teamlead vs 新模块)。
