# PR #1285 / FLY-2776 — Code Review Round 2

**Status: CHANGES REQUESTED**

审查对象：`main...7d295180cac3fed706b33b73558a7f4bd85ed3c7`。审查期间 HEAD 从 `0265c9d9c` 前进到 `7d295180c`；新增提交只修改 `progress.md`，下述生产代码与测试结论未漂移。工作树中并发出现的未跟踪 `design-feedback-round4.md`，以及报告生成后出现的 `fly1679-dev-channels-v2.test.sh` 未提交修正，均不属于用户指定的 `main...HEAD`，未纳入本 verdict；我未修改或覆盖它们。

已核实用户列出的 round-1 行为修复仍然存在：modal footer + composer 否决、43x16/30x16 第三告警通路与 live-prompt veto、`--strict-delivery` 回执解析、UTC 日桶签名、raw-tty 三态/CI fail-closed、G 层 pane+composer 断言，以及 F3 的真实 anchor mutant。既定根因事实与当前源码/fixture 一致，未发现错误。

## Findings

1. **BLOCKER — P15 在到达 composer 否决前已经失败，因此 round-1 的关键误按保护可以回归而测试仍全绿。** `scripts/__tests__/fly1679-dev-channels-v2.test.sh:286-307,332-333`。P15 的注释说选项行“独占一行”、只有 `⏵⏵` 排除该屏幕，但 fixture 的每一条对话框行实际都以 `>` 开头：`>   ❯ 1...` 不满足生产锚点 `^[[:space:]]*...`，而折行正文中间也插入了另一个 `>`，无法还原成完整 body sentence。实测删除 `_dev_channels_dialog_present` 的 composer 检查后，当前 P15 仍返回 `absent`；同一个 mutant 对无 `>`、仅缩进的整块渲染返回 `present`，而 shipped predicate 正确返回 `absent`。具体失败场景是未来重构误删 `packages/teamlead/scripts/claude-lead.sh:1760-1762` 后，所有现有 P 用例仍可通过，但 Lead 显示一个无 `>` 的 fenced/code-block capture 且 composer 存活时，poller 会把它当活 modal，向真实 prompt 输入 `1`。A2c 只守住 NOT_SEEN 告警的 `match_live_prompt` veto，并不让识别器里的 composer veto 变得 load-bearing。**建议修复：**把 P15 的对话框内容改成终端中真实的无 `>` 独立行（保留 live composer），并像 F3 一样加入 mutation assertion：移除 composer check 后 mutant 必须 `present`、shipped predicate 必须 `absent`；最好再走一次 poller 并断言零 `send-keys`。

2. **NIT — 生产注释仍把三类证据描述成“两类”，并把可选 caret 的行称作 focused row。** `packages/teamlead/scripts/claude-lead.sh:1647-1673`。当前实现实际要求结构行 + modal footer/无 composer + semantic body 三类证据，且 `❯` 在 `:1728` 明确可选；高层说明却说 “TWO mutually independent features” 且称其为 “FOCUSED OPTION ROW”。具体风险是后续维护者按这段总览“简化”掉 modal 条件，重新打开本轮正在防的误按窗口。**建议修复：**把总览同步为三类必需证据，并将 focused row 改为 line-anchored option row；保留下面关于 caret 可选的准确说明。

## Verification

- 完整阅读 `CLAUDE.md`、`exploration.md`、`plan.md`、`code-review-round1.md`、`design-feedback-round1.md`、`design-feedback-round2.md`，并核对 `main...HEAD`、调用点、`lead-alert.sh` strict-delivery 合同与当前 Bridge kind 生命周期。
- `git diff --check main...HEAD`：通过。
- `bash -n packages/teamlead/scripts/claude-lead.sh scripts/__tests__/fly1679-dev-channels-v2.test.sh scripts/__tests__/fly2776-dev-channels-geometry.test.sh scripts/lead-alert.sh`：通过。
- `env -u LANG -u LC_ALL bash scripts/__tests__/fly2776-dev-channels-geometry.test.sh`：20 passed / 0 failed；本沙箱明确拒绝 raw tty，因此 F1/F2 与 G/M 按合同显式 SKIP，H1/H2/H3 全部通过。没有把 SKIP 当作真实 Claude 验收。
- `fly1679-dev-channels-v2.test.sh` 分别在 locale unset、`LC_ALL=C`、`LC_ALL=en_US.UTF-8` 下运行：三次均 49 passed / 0 failed；三次 real-tmux E 层均因同一 raw-tty capability denial 显式 SKIP。
- composer mutant 探针：`shipped_current_p15=absent`、`mutant_current_p15=absent`、`shipped_unprefixed_block=absent`、`mutant_unprefixed_block=present`，确认 P15 对 composer 条件是 vacuous pass。
- `fly1680-v1-extinction.test.sh`：7 passed / 0 failed。
- `discord-plugin-cutover.test.sh`：23 passed / 0 failed。
- `ci-shell-suite-enumeration.test.sh`：通过（342 个 shell suites 全部分类；289 CI / 54 manual-only）。
- `pnpm lint`：退出 0；仅报告仓库既有 warning/info，无本 PR 相关错误。
- 最终只读检查：当前 HEAD `7d295180c`；未修改任何 repo 文件。真实 Claude G1/G2 未在本轮重跑，因为本机 raw-tty 传输前提未建立；该限制与测试输出明确记录一致。

CHANGES REQUESTED
