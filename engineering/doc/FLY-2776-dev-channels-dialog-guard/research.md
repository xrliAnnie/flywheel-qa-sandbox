# FLY-2776 dev-channels 确认框守卫失效 — 调研

Issue: FLY-2776 (https://linear.app/geoforge3d/issue/FLY-2776/lead-启动确认框守卫失效-claude-code-升级后-dev-channels-确认框文案变了claude-leadsh-的-dev)
日期: 2026-09-22
基于: exploration.md

## 1. 现状代码

`packages/teamlead/scripts/claude-lead.sh`

```bash
_dev_channels_dialog_present() {            # :1629
  local text="$1"
  grep -qF 'WARNING: Loading development channels' <<<"$text" || return 1
  grep -qF 'I am using this for local development' <<<"$text" || return 1
  grep -qF 'Please use --channels to run a list of approved channels.' <<<"$text" || return 1
  return 0
}
```

被三处调用:

1. `_poll_dev_channels_dialog_v2` 主循环 —— 命中就 `send-keys '1'`
2. 同函数 send 之后的 verify 循环 —— 不再命中才算 `confirmed=1`
3. (间接)超时后的 NOT_SEEN classification 逐条重算 `match_*` flag

三个 `grep -qF` 都是**逐行精确子串**匹配。`capture-pane -p` 给的是渲染后的屏幕,
所以:

* 屏幕**软换行**会把一个逻辑句子切成两个物理行 → `-qF` 整句必然失配
* 框比 pane 高时**顶部滚出视口** → 那几行根本不在 `capture-pane -p` 的输出里

## 2. 约束(来自 FLY-1679 的既有测试,必须继续成立)

`scripts/__tests__/fly1679-dev-channels-v2.test.sh` 的 P1–P7 是这次改动的护栏,
其中最硬的是 **P4**:

```bash
read -r -d '' TRANSCRIPT_A_PLUS_B <<'FIXTURE' || true
> Lead 的 claude 以 --dangerously-load-development-channels 启动时,启动即弹确认框
> (WARNING: Loading development channels … ❯ 1. I am using this for local development
> / 2. Exit),无人按键就永远停在框上 = 该 Lead 的 Discord/inbox 全下线.
Let me look at the poller in claude-lead.sh.
FIXTURE
predicate_case "P4 title+option quoted in conversation is not the dialog" \
  "$TRANSCRIPT_A_PLUS_B" absent
```

这段文字里 **同时含有**标题、`❯ 1. I am using this for local development`
和 `2. Exit`。也就是说:

> 只靠「出现了哪些字符串」永远无法把**活着的框**和**转述这个框的对话**分开。
> 这个 issue 自己的讨论文本就是最危险的 false-positive 样本 —— Aunt Cass 正在
> Discord 里讨论它。

代价也要摆清楚:误判去按 `1` 时,send-keys 只是把 `1` 打进输入框(从不发
Enter),不会提交;漏判则是 Lead 停 17 小时。漏判远比误判贵,但 P4 是既有合同,
不允许放松。

## 3. 候选方案

### A. 直接放宽成「三段中两段」

改 `||` 逻辑。**否决**:issue 明确要求「不能退化成只匹配一段」,而且 49x16 下
标题和提示句**同时**失配,放宽到两段照样不中(只剩 `I am using this...` 一段)。
放宽到一段则直接违反要求且必然撞 P3/P4。

### B. 扫 scrollback(`capture-pane -S -N`)

标题确实躺在 scrollback 里(exploration §3 实测),这能救回标题。
**否决为主方案**:`--resume` 冷启会把历史 transcript 重放到 scrollback,而
P4 那种「转述这个框」的文本正是 Aunt Cass 的日常内容。把搜索面扩大到历史正是
FLY-1679 注释里点名要避免的事:

> ...would otherwise leave the poller scanning a restored transcript for its
> whole budget.

### C. 空白归一化 + 行锚定的结构特征(采纳)

分两层,各自独立:

**C1 — 空白归一化解决换行。** 把整块 capture 的所有空白(含换行)压成单个空格,
再 `grep -F` 整句。`Please use --channels to run a list of` + `approved channels.`
被重新拼回 `Please use --channels to run a list of approved channels.`,
宽度无关。

**C2 — 行锚定解决「活框 vs 转述」。** 活着的框里,选项行是**独占一行**的:

```
  ❯ 1. I am using this for local development
```

而 P4 的转述里,同样的字符串出现在**行中**:

```
> (WARNING: Loading development channels … ❯ 1. I am using this for local development
```

所以把 option-1 行做成**行首锚定**的正则(允许行首/行尾的边框字符和空白),
P4 自然落空,而真框(有边框的宽形、无边框的窄形)都命中。

C2 同时是「这个框现在正等着按键」的证据 —— 只有 Select 组件在渲染、光标停在
option 1 上时,才会有这么一行。这比「屏幕上出现过某个句子」强得多。

## 4. 采纳的判定式(两段互相独立的特征)

```
必需 1(结构/行锚定):可见 pane 里存在一行,去掉边框与首尾空白后精确等于
                      `❯ 1. I am using this for local development`
必需 2(语义/空白归一化):归一化后的整屏文本里至少出现下列之一
                      - `WARNING: Loading development channels`
                      - `Please use --channels to run a list of approved channels.`
                      - `--dangerously-load-development-channels is for local channel development only.`
```

两条必须同时成立。对照 issue 的要求:

* 「新旧文案都要认」—— 旧形态(宽 pane,标题+提示句都在)必需 2 由标题满足;
  新形态(49x16)必需 2 由提示句(归一化后)满足。✓
* 「至少两段互相独立的特征文字」—— 必需 1 是选项行,必需 2 是正文句,来自框的
  不同区域,互不蕴含。✓
* 「不能退化成只匹配一段」—— 单独给标题、单独给选项标签都不匹配。✓

### 对既有 P1–P7 的逐条核对

| 用例 | 必需 1 | 必需 2 | 结论 | 期望 |
|---|---|---|---|---|
| P1 REAL_DIALOG(带 `│` 边框) | 去边框后行等 ✓ | 标题 ✓ | present | present ✓ |
| P2 只有标题 | ✗ | ✓ | absent | absent ✓ |
| P3 只有选项标签(无 `❯ 1.`) | ✗ | ✗ | absent | absent ✓ |
| P4 转述(标题+选项都在,但在行中) | ✗(行中,非行首) | ✓ | absent | absent ✓ |
| P5 泛泛提到 development channels | ✗ | ✗ | absent | absent ✓ |
| P6 别的数字确认框 | ✗ | ✗ | absent | absent ✓ |
| P7 Chrome onboarding | ✗ | ✗ | absent | absent ✓ |
| **新** 49x16 真实 capture | ✓ | 提示句(归一化)✓ | present | present ✓ |
| **新** 120x40 真实 capture | ✓ | 标题 ✓ | present | present ✓ |

### 残余风险(明确登记)

pane 窄到连 `  ❯ 1. I am using this for local development`(44 列)都要换行时
(< ~44 列),必需 1 失配 → 不按键。这是 **fail-safe 方向**:宁可不按,也不往
活着的 prompt 里乱打字;并且此时第 3 条的漂移告警会响,不再静默。

## 5. 按键(issue 第 2 条)

实测(exploration §6):选项顺序未变,`1` = local development,`2` = Exit;
对真框单发 `1`、不发 Enter 即确认通过。**按键逻辑不改。**

## 6. 告警通道(issue 第 3 条)

`scripts/lead-alert.sh` 已有 claims.db 去重(`--signature` 覆盖默认的当日日期),
`claude-lead.sh` 里已有直接调用的先例(`model_config`,:2036)。

kind 选择:**复用 `permission_blocked`**,不新增 kind。

* 语义完全吻合,Bridge 侧现成文案(`alert-kind-copy.ts:513`)就是这次要说的话:
  > "Lead is waiting on a permission prompt that cannot be auto-confirmed.
  >  Approve / deny it in the Lead's tmux pane."
* 新增一个 kind 要同时登记 `lead-alert.sh`(注释+allowlist)、`LeadAlertNotifier.ts`、
  `infra-event-router.ts`、`kind-contract.ts`、`alert-kind-copy.ts`(两处 switch)、
  `ticket-owner-map.test.ts`、`fly-2006-retention-registry.mjs`、
  `fly-2006-retention-engine.mjs`、`contact-book.md`、`infra-alerts-spec.md`
  —— 十处登记面,对一个要赶今晚班车的修复是不成比例的风险。

去重签名用 `dev-channels-drift-<pane_sha256 前 16 位>`:同一块屏幕永久只告警一次,
屏幕真的变了(= 真·文案漂移)才会再响。
