# Flywheel on-call 册子总规

这套册子的读者是 **Infra bot**。它保存的是能复用、能继续长的处理知识，不是某次告警的处理流水，也不是一本一次写完的大全。

它与旧的 [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md) 分工不同：旧文件是按组件写给人的历史运维手册；这里按告警或病根类别索引，供 Infra bot 从一条告警进入。两者不要互相复制内容。

目录约定：

```text
doc/oncall/
├── README.md
├── contact-book.md
└── runbooks/
    ├── _template.md
    └── <告警或病根类别>.md
```

一个类别一本。类别优先沿用告警 `kind`；同一个 `kind` 已确认有不同病根时，才按病根拆页，并在原类别页放明确入口。不要按某台机器、某次事故或某个 issue 建页。

## 收到告警后怎么用

1. 从告警正文取得类别、发生时间和受影响对象。
2. 在 [contact book](contact-book.md) 按类别找负责人；找不到就找 Tadashi。
3. 打开 `runbooks/<类别>.md`，先按「去哪看 log 还原」找到本次事件的上下文。
4. 只采用页面里已经由真实处置沉淀的动作。证据不足、需要猜或页面尚未写动作时，带着 log 证据找负责人，不自行补判断。
5. 用处置后的 log 确认现象确实停止，再把这次新学到的通用知识回填到页面。

主路径始终是 **看 log 还原**。册子告诉 bot 去哪里取证和如何找到负责人，不把当时某个人的临场判断固化成一串永远正确的机械步骤。

## 新问题怎样入册

出了一类新的真实问题后，按下面的顺序入册：

1. **谁写**：实际处置它的 Infra bot 或 Lead 负责写；转给别人处置的，由最终确认恢复的人写。
2. **写在哪**：从 [`runbooks/_template.md`](runbooks/_template.md) 复制到 `runbooks/<类别>.md`，并在 `contact-book.md` 加一行。
3. **最少写什么**：现象、去哪看 log 还原、做了什么、怎么确认好了、该找谁，五栏缺一不可。
4. **怎么验**：开一个不带本机上下文的 Infra bot 会话，只给它告警文本、本 README 和类别页。它必须能自己说明值从哪里取、去哪里看 log、已有动作是什么、如何确认恢复、卡住时找谁。任何一步需要口头补充或猜测，都不算入册完成。
5. **留下什么记录**：入册的 issue 或 PR 记录类别、真实告警的非敏感标识、页面路径和抽验结果。逐次 log、聊天、查询输出和临时文件不进仓库。

### 机器入口

本册子的机械入口只有三个：落草稿并拒绝本机值、按回执写页、数欠账。它们由
FLY-2386 依 founder 2026-09-06 裁定加入；不加检测、对账、状态机。

- ① 自己解决时用 `alert-ticket resolve --draft <file> --event-id <eventId>`。命令先定位
  工单，再由 `oncall-draft add --book runbook` 校验通用写法并生成 `pending/` 回执；
  Bridge 核验回执与当前工单一致、预绑 draft id 后才会 resolve。
- ③ 册上无此类别时，`alert-ticket handoff --reason no_entry` 会先生成一张
  `owed/` contact-book 回执。查清负责人后，用
  `oncall-draft add --book contact-book --event-id <eventId> --to <leadId> --file <file>`
  补全并移到 `pending/`。
- `oncall-draft list` 数 `owed / pending / landed` 欠账；
  `oncall-draft harvest --repo <worktree>` 按回执写页，并把成功回填的回执移到
  `landed/`。页里的 `<!-- backfill:<eventId> -->` 表示该真实处置已经写入；重跑时不重复
  加段，但仍会完成 pending → landed 的崩溃恢复。

谁运行 harvest，谁负责检查 diff 并开 PR。命令不提交、不推送，也不替代本页的人工
抽验。

## 新告警类别上线闸门

**新告警类别上线前必须在册。** 上线它的变更必须同时满足：

- `contact-book.md` 已有「类别 → 找谁」；
- `runbooks/<类别>.md` 已按模板落位，五栏齐全；
- 一个不带本机上下文的 Infra bot 已按上一节走通并留下验收记录。

本 README 定义闸门；FLY-2076 的值守流程负责执行和追踪。新增告警类别的 PR reviewer
仍按本节人工核验，不能把 FLY-2386 的三个机械入口当成上线检测、机械对账或新状态机。

## 通用写法

- 不写死用户目录、账号、主机名、频道 id、服务地址或凭据。
- 机器特有的值写「从哪取」，例如「从服务启动配置取得 log 位置」「从告警正文取得时间和对象」「从项目名册取得 Lead」。
- log 位置可能因部署而异时，写它的配置来源，不抄当前机器解析后的路径。
- 不预设固定阈值或判断顺序。把当次真实动作和恢复证据写清；遇到不同证据就停下找负责人。
- 机械化只限 FLY-2386 的三个入口：落草稿并拒绝本机值、按回执写页、数欠账；不扩成
  lint、告警检测、对账或册子状态机。
- 不收录逐次告警 payload、整段 log、账号信息或任何凭据。

## 维护规则

- 处置者发现页面不够用，就在同一个 issue 或 follow-up PR 修页面；不要在聊天里形成第二份手册。
- 负责人变化时，只改 contact book；runbook 里的「找谁」指回 contact book，避免两处漂移。
- 同一类别反复出现时，补充真实的 log 来源、动作和恢复证据，不扩写背景教材。
- 老类别找不到页面时，先走 contact book，再按「新问题怎样入册」回填。
