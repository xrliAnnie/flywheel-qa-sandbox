# FLY-546 耳机模式 — QA 报告(独立验证 · Opus）

Issue: FLY-546
日期: 2026-07-07
基于: plan.md、exploration.md、research.md、branch 已提交实现 + PR #496

> 三段式流水线 QA 阶段（Design → Implement → **QA**），同分支验证。QA 不重写功能，
> 独立核对实现 vs 计划/PRD §17 契约、跑测试、真机行使可行使的真实行为、补测覆盖缺口。

## 结论:**PASS**(交付范围 = PR-1「per-agent 声线 + 离屏 FIFO 语音环 · 桌面干跑面」)

本 PR 的交付范围 = **M-A(per-agent 声线)+ M-B1(voice-core 纯逻辑)+ M-B2(daemon)+
M-B3(Bridge voice 面)+ 桌面干跑**。**M-B4(FLY-545 VC 适配 + 戴耳机离屏真机 E2E)按
plan 明确 defer**(依赖 545,checkbox 未勾;PR 标题即「desk dry-run face」)。北极星验收
(Annie 戴耳机一段真实工作流全程语音推进)需 545 VC 管线,不在本 PR——这是 Annie ④ + Lead
编排的既定分期,不是 QA 缺陷。故本报告对**已交付范围**判 PASS。

---

## 1. 测试(全绿)

| 包 / 套件 | 结果 |
|-----------|------|
| flywheel-voice-core（全套） | **163 passed**（含 headphone-turn-machine 33、worked-example 1、tap-filter 9、phrases 10、queue 8、voice-directory 4、edge-tts 12） |
| flywheel-voice-headphone（全套） | **54 passed**（config 11、state-file 5、bridge-client 7、recovery 7、null-audio-io 8、daemon-core 16） |
| teamlead voice（voice-approval-source + voice-routes） | **31 passed**（5 + 26；含 QA 新增 3） |
| **voice 合计** | **248 passed** |
| lint（biome，全部改动文件 + QA 新增测试） | **clean** |

### 全 teamlead 套件的失败 = 环境性,已排除对 FLY-546 的牵连
全 `flywheel-teamlead` 套件在本机（重载:多 Lead + 多 runner + FLY-545/546 并存 worktree,
日志可见 `[sync-bin] replaced stale symlink → flywheel-FLY-545`）跑出若干失败,**全部是
`Test timed out`(5s/15s)**,且无一在 voice 文件。最能牵连 FLY-546 的是 `plugin.ts`
(挂载 voice-routes)——故把所有会启动 Bridge/plugin 的失败文件
(`bridge.test`、`runs-route-registration`、`post-merge`、`createLeadRuntime-preflight`)
**隔离重跑 → 32/32 全过**,其中 `bridge.test` 的
「startBridge starts and closes cleanly」「/api/* requires apiToken when configured」
正是走 voice 挂载路径。→ **voice 挂载无辜,全套失败纯属重载超时。**

## 2. 实现 vs 契约 逐文件核对(代码审读)

- **turn-machine.ts(§17 回合 FSM,最高风险)**:状态×事件×动作表与 plan B1-3.1 / PRD §17
  逐条一致。c 档安全语义全部落实且**已被测**:silence≠同意(绝不写批准)、kill-switch 关时
  批准态**不可达**、APPROVE_INTENT 在 normal 条不触发批准、**离场瞬间作废批准尝试**(旧
  readback 重连后永不能再「确认」写批准)、收据先行硬门、sending 中不被 STOP_WORD/presence
  撕裂、persist/restore round-trip。
- **worked-example.test.ts**:PRD §17 三条消息(skip → 要回代发 → mid-turn 入队 → c 档语音
  批准全链 → 芝麻关门+确认退出)**逐字**重放,`io.log` 与 PRD 例文完全对齐——真契约测试。
- **voice-routes.ts(founder 批准写入,安全边界)**:guard ladder 与 plan B3-2.4 一致——
  ⓪ apiToken 未配 503(body use 之前）→ ① kill-switch 403(路由恒注册,非 404)→
  ② FOUNDER_AUTO_APPROVE=0 403 → ⑤ 收据先行 400 → 缺字段 400 → ③ binding 三者互证 409 →
  ④ canonical founder 403 → ⑥ evaluateVoiceSource 仅 approve 才
  `writeGateResponseAndRunPostWrite`,reject/unclear 200 written:false → ⑦ 每次(含拒绝)
  写 audit。plugin.ts 挂载在 `tokenAuthMiddleware` 之内、恒注册、CommDB 走 realpath 收敛的
  共享路径。
- **voice-approval-source.ts**:严于 text 源——**无 Tier-3 分类器**,非精确 CONFIRM/DENY
  即 unclear;founderUserId≠canonical 即 null。CONFIRM/DENY 词表与 phrases.ts 逐字一致。
- **tap-filter.ts**:①-⑦ 真值表落实(自回声/ founder 自己 exclude;识别身份@founder 兜底
  include;roundtable 开关;scope 内未识别 bot 仅在 hasGateBinding 时按持久绑定 include)。
- **queue.ts / recovery.ts / state-file.ts / daemon-core.ts**:messageId 去重 survive
  shift+restore;三个 crash-point 幂等账本(绝不重发代发/收据/批准);原子 tmp+fsync+rename
  0600 + 损坏隔离 fail-loud;startup buffer 关掉 boot cursor race(Codex R2/R3)、drain 中
  buffer 保持 active(Codex R3);离线 backfill 全局 snowflake 序。
- **reverse-compat 哨兵**:A1(edge-tts 旧 string voice argv 逐字不变)、A3(ProjectConfig
  无 voice 字段加载深等)均在位。

## 3. 真实行为行使(可行使部分)

- **真 edge-tts 合成(经编译后的生产 `EdgeTts` 引擎,非 mock、非测试脚本)**:三个 per-agent
  VoiceSpec 全部产出合法 MP3(帧头 `fff364`);prosody 变体(rate -10% / pitch -2Hz)音频
  **更长**(50544 vs 45648 bytes)= rate/pitch 真达 edge-tts 且改变输出;畸形 rate
  `validateVoiceSpec` fail-fast。→ **M-A per-agent 声线走生产代码路真通。**
- **A4 audition kit 真实产物**:`~/fly546-audition/` 8 声线 × 3 变体 = 24 个真 mp3 + index.md
  (slow 变体字节更大、bright 同底裸 = prosody 生效的旁证)。
- **Bridge voice 路由 = 真 express + 真 HTTP 集成测**(非 mock express):整条 guard ladder
  端到端行使。

## 4. QA 补测(强化 founder 批准安全边界,+3)

`voice-routes.test.ts` 原 23 测漏掉 guard ladder 的三条分支,QA 补齐(均 PASS):
1. **questionId 交叉校验不符 → 409**(原仅测 prHeadSha 不符;questionId 是批准绑定的另一半)
2. **收据在但核心字段缺 → 400 missing_required_fields**(输入校验边界)
3. **全 guard 过但 CommDB 打不开 → 503 commdb_unavailable + audit error + 零写入**
   (founder 权限写入绝不在半开 db 上进行)

## 5. 已知边界 / 非缺陷说明

- **crash + 瞬时批准失败的极窄窗口**:`runApproval` 在 submitApproval 返回后无条件记
  `approvalAttemptId`(即便 res.ok=false)。若恰在 persist(546 行)与 narrate(547 行)之间
  crash,recovery 会抑制该 ship_gate 条重入队。**这是刻意的安全方向取舍(宁可不重写 founder
  权限,也不冒重复写)**,且底层 gate 消息 + PR 原封不动(屏幕 text/reaction 路径仍在)、
  **绝无错误 ship**——非缺陷,Codex R1 MEDIUM-3 已审。
- **M-B4 未交付 = 设计分期**,见结论段。真机 VC E2E 留给 B4-2(依赖 545)。

## 6. 提交物(QA 阶段追加到本分支)

- `packages/teamlead/src/__tests__/voice-routes.test.ts` — +3 guard-ladder 安全测
- 本 `qa-report.md` + `progress.md`(phase=qa）
