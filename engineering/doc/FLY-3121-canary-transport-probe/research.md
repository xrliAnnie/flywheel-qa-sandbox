# FLY-3121 canary 传输探针 — 调研
Issue: FLY-3121 (https://linear.app/geoforge3d/issue/FLY-3121/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-phase)
日期: 2026-10-01
基于: exploration.md

## 1. 调研问题

exploration.md 选了「文档夹内 bash 辅助脚本 + 测试」方案。本文回答落地前必须确认的 6 个事实问题，全部在本机实测（macOS Darwin 25.6.0，`/bin/bash`，沙箱仓 HEAD `31998a85d`）。

## 2. 事实与证据

### Q1 本地 commit 会不会触发任何副作用？

- `core.hooksPath` 目录里非 `.sample` 的钩子只有 `pre-push`（5 行的 push-guard）。**没有** `pre-commit` / `commit-msg` / `prepare-commit-msg`。
- 仓库没有 `.husky/`、没有 lint-staged。
- `ci.yml` 的触发器只有 `pull_request: branches: [main]` 与 `push: branches: [main]`。

结论：在功能分支上做本地 commit **零副作用**——不跑钩子、不触发 CI。

### Q2 `probe.txt` / `.sh` 会不会被仓库 lint 卡住？

- `biome.json` 的 `files.includes` 是 `**`，但 biome 只处理它认识的语言（JS/TS/JSON/CSS 等），`.txt` 与 `.sh` 不在其列。
- `ci.yml` 里没有 shellcheck 步骤（`grep -n shellcheck .github/workflows/ci.yml` 无输出）。
- 本机有 `shellcheck`，对两段脚本草稿实测**零告警**；作为实现阶段的自检步骤保留，不作为 CI 门。

### Q3 用什么校验 marker 行才安全且可移植？

要挡住的输入：空行、回车符（CRLF）、制表符等控制字符、非 ASCII、超长行、空文件。

实测一条 awk 即可（`LC_ALL=C` 让 `length` 按字节计、字符范围按字节比较）：

```bash
LC_ALL=C awk 'length($0) < 1 || length($0) > 512 || $0 !~ /^[ -~]+$/ { bad = 1; print "REJECT: line " NR } END { exit bad }' <file>
```

| 输入 | 实测退出码 |
|---|---|
| 两行可打印 ASCII（含以 `-` 开头的行） | 0 |
| 含空行 | 1 |
| 含 `\r` | 1 |
| 含 `\t` | 1 |
| UTF-8 中文 | 1 |
| 513 字节 | 1 |
| 512 字节 | 0 |
| 空文件 | 0 ← **awk 自己挡不住**，需另加 `[ -s file ]` |

`[ -~]` 是可打印 ASCII（空格 0x20 到波浪号 0x7E）。选 512 字节上限的依据：canary marker 形如 `FLY2127-CANARY-<uuid> …`，远小于 512；上限只是防止误把大段文本灌进探针文件。

### Q4 幂等追加怎么写才不会被特殊字符骗？

```bash
grep -Fxq -- "$line" "$probe"
```

- `-F` 固定字符串（marker 里的 `.` `*` `[` 不当正则）、`-x` 整行匹配、`-q` 静默、`--` 让以 `-` 开头的 marker 不被当成选项。
- grep 退出码三态：0 = 已存在，1 = 不存在，≥2 = 出错。脚本用 `case` 分开处理，**出错不当作「不存在」放行**。
- 追加用 `printf '%s\n' "$line" >>"$probe"`：`%s` 不解释反斜杠，marker 永远不会被当成格式串或命令。
- 读取用 `while IFS= read -r line || [ -n "$line" ]`：不裁空格、不解释反斜杠、最后一行没换行也能读到。

实测：同一批 marker 跑两次，第一次 `appended=2 skipped=0`，第二次 `appended=0 skipped=2`，文件仍是 2 行。

### Q5 `probe.txt` 末尾没有换行会怎样？

如果有人手工写过 `probe.txt` 且最后一行没换行，`>>` 追加会把新 marker **粘在上一行后面**，破坏「一行一个 marker」。脚本在写之前检查 `[ -s "$probe" ] && [ -n "$(tail -c1 "$probe")" ]`，成立即拒绝（命令替换会吃掉结尾换行，所以结果非空 = 最后一个字节不是换行）。实测通过。

### Q6 回执走哪条通道？TURN 怎么自检？

- **回执**：dispatch 合同规定唯一有效通道是
  `flywheel-comm ask --lead flywheel-test-2 --exec-id $FLYWHEEL_EXEC_ID --report "DONE: [lead-instruction <id>] …"`，
  且必须**完整引用** `[lead-instruction <id>]`（Bridge 巡检用它当消费回执）。stock `SendMessage → team-lead` 是没人读的黑洞，终端打印也不算回执。
- **重投去重**：合同规定同一个 `[lead-instruction <id>]` 出现两次 = 传输层重投，不重做、已报过 DONE 就不再报。这与 Q4 的按行幂等是**两层独立防线**：第一层靠 id，第二层靠文件内容。
- **TURN**：`flywheel-comm turn --exec-id $FLYWHEEL_EXEC_ID` 打印 `yours|not-yours|no-turn`（exit 恒 0）。实测输出：
  `yours phase=design epoch=1 activation=…:eng_design:1 run=1bba7391-… node=eng_design attempt=1`。
  只有第一个词是 `yours` 才能碰共享工作树；`not-yours` 是正常等待态，60–90 秒轮询一次。

## 3. 两段脚本草稿的实测结果

把 plan.md 里的两段脚本原文在临时目录跑过一遍：

1. 只有测试、没有实现：5 条断言 FAIL（`got [127|]`，即脚本不存在），进程 exit 1 —— **RED 成立**。
2. 加上实现：21 条断言全 `ok`，末行 `RESULT: PASS`，exit 0 —— **GREEN 成立**。
3. `shellcheck append-markers.sh append-markers.test.sh`：无输出。

## 4. 被否决的做法

| 做法 | 否决原因 |
|---|---|
| `echo "<marker>" >> probe.txt` 手敲 | 外部输入进命令行；无校验；不幂等（exploration 选项 A） |
| 给 `flywheel-comm` 加子命令 | 属于产品实现，越界（exploration 选项 C） |
| 按 `lead-instruction id` 在 `probe.txt` 里记账去重 | 把传输层标识写进探针文件，改变了「原样追加」的语义；id 去重已由 dispatch 合同在上层覆盖 |
| 允许 UTF-8 marker | 要引入按 locale 的字符类判断，macOS/Linux 行为不一致；canary marker 是 ASCII，遇到非 ASCII 走「拒绝 + 问 Lead」更稳 |
| 校验失败时「跳过坏行、写入好行」 | 部分写入让回执无法一句话说清；整批拒绝才能保证「要么全部按请求落盘，要么一个字节不动」 |
| commit message 带 `[skip ci]` | 本地 commit 本来就不触发 CI（Q1）；万一分支后来被 push 并开 PR，`[skip ci]` 反而会让 PR head 没有 CI 结果 |

## 5. 给 plan.md 的输入

- 两个新文件放文档夹：`append-markers.sh`、`append-markers.test.sh`。
- 仓库根新增 `probe.txt`。
- marker 行来源：指令原文 → 写文件工具落到 scratch 文件 → 脚本。
- 每批 marker 一笔 path-limited commit；`appended=0` 时不提交。
- 回执必经 `ask --report`；无指令时以 TURN 自检输出为回执。
