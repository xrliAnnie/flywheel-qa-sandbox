# FLY-2001 惰性后缀白名单补齐 — 探索
Issue: FLY-2001 (https://linear.app/geoforge3d/issue/FLY-2001/ci省钱-classify-惰性后缀白名单补齐纯数据媒体后缀不触发全量fly-1987-p0-族founder-立单一行改动可回滚)
日期: 2026-08-23
基于: 无

## 1. 问题与结果边界

`scripts/ci-classify.sh` 只在 PR 的整个 merge-base diff 同时满足 doc 前缀白名单与后缀
白名单时输出 `no_code=true`。FLY-1987 的盘点证明，惰性证据文件缺少若干纯文本、结构化
数据、音频、视频与字幕后缀；其中 PR #874 只因一个 `.txt` 文件未命中，纯文档分支仍跑了
全量 CI。

本单新增且仅新增以下 13 个后缀：

```text
.txt .csv .log .out .jsonl .wav .mp3 .m4a .ogg .mp4 .webm .vtt .srt
```

同时必须保持这些边界：

- `doc/`、`product/doc/`、`engineering/doc/`、`content/doc/` 四个前缀不变；
- symlink、gitlink、白名单外路径/后缀和不确定输入继续 fail-closed；
- `.json`、`.tsv`、`.yaml` 与可执行类型继续跑全量；
- 已被 CI 消费的 doc 文件不能因与新后缀组成 mixed diff 而绕过其守卫；
- 不承诺节省金额。FLY-1987 的现行窗口中 P0 样本为 0，收益只有窗口外的偶发样本。

## 2. 权威输入与设计评审纠偏

后缀全集来自 `engineering/doc/FLY-1987-actions-cost-audit/data/derive-lib.mjs` 的
`SUFFIX_P0_ADDS`，并与同目录 `plan.md` 的 P0 清单逐项一致。

FLY-1987 plan 写过“P-1 = FLY-1996 必须先落地”。Lead 对问题
`3d9b3d70-61f0-4a6e-84db-30650803c9db` 的 2026-08-23 回复说明：founder 已取消
FLY-1996，该前置句是过期残句；FLY-2001 不等待或重启该 feature。

设计评审 R1 随后推翻了初稿的一个错误前提：逐项证明 13 个**新后缀**没有 CI consumer，
并不足以证明整体 diff 安全。classifier 是全 diff 合取判定；例如“已白名单且被 CI 消费的
`.md` + 新增 `.txt`”在改动前由 `.txt` 迫使全量，改动后会同时命中白名单，从而让旧的
`.md` 守卫也被跳过。

R1 核实了三条当前被 skippable CI lane 消费的 doc 路径；R2 的 full-path inventory 又找到
两条，本单复核补出 reviewer 漏掉的第六条。R3 随后证明 full-path literal sweep 仍看不见
“目录基址 + 相对文件名”的 composed path，并从 FLY-1278 的 gated consumer 中核实了 8 个
`.md` artifact。Lead 通过问题 `819a8544-6dab-4320-b214-7134ab6bea98`、
`727334ef-ddfa-425e-97f3-75a7929c2aa5` 与 `6ed3dee2-1c2d-43e8-a8dc-08c2d569ba76`
裁定前 14 条；R4 再从 segment-joined path 核实 FLY-1135 三条。Lead 通过
`2deffcad-bf92-4147-b9ce-43e47904a6e0` 选择 exact-17 方案：每条提供 RED 测试与 Git-index
liveness，两组 composed consumers 另做 consumer/fence parity。不采用目录 prefix（会误围未证实
惰性文件）或 generic discovery guard（是另一个机制范围）。

## 3. 方案选择

采用“精确后缀扩展 + 精确路径围栏”：

1. 对 13 个后缀用 `git ls-files` 盘点 tracked 文件并做 consumer sweep；
2. 向现有 `allowed_suffixes` 追加 13 项；
3. 新增且仅新增 17 条 `known_ci_consumed_doc_paths`，任一命中都输出 `no_code=false`；
4. 在 always-on `ci-structure.test.sh` 精确钉死前缀、后缀和 17 条围栏集合，验证路径仍在
   Git index，并保持 FLY-1278 八项、FLY-1135 三项的 consumer/fence parity；
5. behavioral suite 覆盖逐后缀阳性、目录外阴性、白名单外后缀阴性、17 条围栏和 mixed diff。

不采用以下替代：

- “doc 前缀下一律惰性”：doc 中确有 CI 输入与可执行文件；
- 按 MIME 或内容嗅探：会引入新的解析边界，回滚与审查成本不成比例；
- 只补 `.txt`：违背 FLY-1987 的权威清单和逐后缀验收；
- 完整实现 FLY-1996：founder 已取消；本单只修补会被自身后缀扩展放大的 17 条 sweep-verified 路径；
- 目录 prefix guard：会把未被 consumer 读取的同目录文件也拉回全量，违反 no-speculative-additions；
- generic always-on discovery guard：是新的 CI 治理机制，证据需要时另立单；
- 把所有 doc-consuming guards 搬进 quick-gate：改动 CI job 图，超出本单边界。

## 4. 可证伪验收

1. 13 个新增后缀分别在 `engineering/doc/` 下形成只改一个普通文件的提交，全部输出
   `no_code=true`。
2. 同一批后缀分别放在前缀白名单外，全部输出 `no_code=false`。
3. `.json`、`.tsv`、`.yaml` 即使位于 doc 前缀内也输出 `no_code=false`。
4. 17 条已核实 CI consumer 路径分别单改时输出 `no_code=false`；其中任一路径与新 `.txt`
   组成 mixed diff 时仍输出 `no_code=false`。
5. 用 PR #874 的 9 个真实路径形成一个提交；唯一新类型 `.txt` 不再阻止快车道。
6. 既有 code-only、mixed、rename、symlink、gitlink、错误 SHA、无共同祖先与多 merge-base
   阴性测试继续通过。
7. always-on structure test 精确断言 production 前缀、后缀与 non-inert 路径集合。

## 5. 会过期的结论

| 结论 | 截止时间 | 失效条件 | 重核方法 |
|---|---|---|---|
| 新增后缀全集为 13 项 | 2026-08-23 | FLY-1987 台账被新裁定取代 | 比对 `SUFFIX_P0_ADDS` 与 FLY-1987 plan P0 清单 |
| FLY-1996 已取消、17 条围栏仅属本单正确性范围 | 2026-08-23 | founder 或 Lead 发出新裁定 | 查询四个 CommDB 问题 ID 与本单 inbox |
| 17 条路径是三模态 inventory 证实并获授权的精确排除 | 2026-08-23 | CI consumer 或治理裁定变化 | 重跑 research.md 三种 sweep；新增项按 Lead standing authorization 处理 |
| 13 类文件的 CI consumer sweep 干净 | 2026-08-23 | CI workflow、脚本调用图或 doc 证据文件变化 | 重跑 research.md 中 tracked inventory、literal-path 与动态模式 sweep |
