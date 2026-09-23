# FLY-2776 dev-channels 确认框守卫失效 — 探索

Issue: FLY-2776 (https://linear.app/geoforge3d/issue/FLY-2776/lead-启动确认框守卫失效-claude-code-升级后-dev-channels-确认框文案变了claude-leadsh-的-dev)
日期: 2026-09-22
基于: 无

## 1. 报告的症状

`~/.flywheel/logs/lead-flywheel-cos-lead-startup.log`:

```
2026-09-22T04:18:54 dialog-poller-v2: matched dev-channels dialog, sending '1'
2026-09-22T07:04:01 dialog-poller-v2: DEV_CHANNELS_DIALOG_NOT_SEEN after 90s
2026-09-22T07:04:01 ... match_warning=0 match_local_dev=1 match_channels_hint=0
                        banner_channels=0 prompt_caret=1 lines=15
                        pane_sha256=06309063e61b906c33fee4702776760801d2dee3d65eb35b01f75a79e81b103b
2026-09-22T19:04:07 ... 同一个 pane_sha256(确定性,不是抖动)
```

Aunt Cass 因此在两趟班车之间停了约 17 小时。

## 2. 初始假设:「Claude Code 升级后确认框文案变了」

**这个假设是错的。** 三段文字在当前安装的二进制里都还在,逐字未变。

```
$ ls -la ~/.local/share/claude/versions/
2.1.277  2.1.278  2.1.280   ← 2.1.280 是当前 PATH 上的 claude

对 2.1.277 / 2.1.278 / 2.1.280 三个二进制逐个 grep -aF:
  HIT: WARNING: Loading development channels
  HIT: I am using this for local development
  HIT: Please use --channels to run a list of approved channels.
```

另外两个否证:

* 9-22 04:18Z **matched**、07:02Z **NOT_SEEN**,中间没有版本切换
  (2.1.280 的安装时间是 9-22 09:41 PDT = 16:41Z,在两次事件之后)。
  同一份二进制,一次中一次不中 → 不可能是二进制里的文案变了。
* 二进制相邻字节里 dev-channels 这一段在 2.1.278 和 2.1.280 之间完全一致。

## 3. 真实根因:pane 几何 —— 视口截断 + 自动换行

生产 Lead 的 tmux pane 是 **49 列 × 16 行**:

```
$ tmux -S ~/.flywheel/sock/fw-flywheel-flywheel-co-*.sock \
      list-panes -a -F '#{pane_id} #{pane_width}x#{pane_height}'
%0 49x16
```

在隔离 tmux 里用**当前安装的** claude 2.1.280 真起一次
`--dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox`,
把 pane 做成同样的 49x16,`capture-pane -p` 拿到的**可见**内容是:

```
  --dangerously-load-development-channels is
  for local channel development only. Do not
  use this option to run channels you have
  downloaded off the internet.

  Please use --channels to run a list of
  approved channels.

  Channels: plugin:discord@flywheel-plugins,
  server:flywheel-inbox

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
```

同一次会话把 scrollback 也抓出来(`capture-pane -p -S -40`),标题就在视口上方两行:

```
─────────────────────────────────────────────────
  WARNING: Loading development channels
                       ↑ 被顶出 16 行视口
```

把 pane 放大到 120x40 再跑一次,三段全在、且都不换行 —— 这正是 9-21 及以前
`matched` 的那个形状:

```
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use this option to run
  channels you have downloaded off the internet.

  Please use --channels to run a list of approved channels.

  Channels: plugin:discord@flywheel-plugins, server:flywheel-inbox

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
```

对照守卫要求的三段,49x16 下逐条解释日志里的 classification:

| 守卫要求的字符串 | 49x16 实况 | 日志 |
|---|---|---|
| `WARNING: Loading development channels` | 被顶出 16 行视口(在 scrollback 里) | `match_warning=0` ✓ |
| `Please use --channels to run a list of approved channels.` | 56 字符 > 可用宽度,被折成 `Please use --channels to run a list of` + `approved channels.` 两行 | `match_channels_hint=0` ✓ |
| `I am using this for local development` | 37 字符,option 1 一行放得下 | `match_local_dev=1` ✓ |
| (`❯`) | Select 光标在 option 1 上 | `prompt_caret=1` ✓ |
| (`Channels (experimental)`) | 该 banner 不属于这个框 | `banner_channels=0` ✓ |

五个 flag 全部对上。根因确定:**文案没变,是 49x16 的视口装不下这个框 ——
标题滚出视口、提示句被换行截断,`grep -qF` 的逐行精确匹配因此失败。**

## 4. 为什么偏偏是 9-22 07:02Z 翻车

框的高度取决于 `Channels:` 那一行列了几个频道。Aunt Cass 现在的参数是
`plugin:discord@flywheel-plugins server:flywheel-inbox`,在 49 列下这一行要占
**两行**:

```
  Channels: plugin:discord@flywheel-plugins,
  server:flywheel-inbox
```

只要这一行多占一行,整个框就高一行,标题正好被顶出 16 行视口 —— 于是在
「刚好够」和「刚好不够」之间一次性翻过去,并且之后每次都一样
(两次失败 `pane_sha256` 完全相同,正是确定性的体现)。

## 5. 为什么 19:02Z 有 9 个 Lead 记 NOT_SEEN 但只有 Aunt Cass 真卡住

`_poll_dev_channels_dialog_v2` 对「没弹框」和「弹了框但认不出」用的是同一个
出口 `DEV_CHANNELS_DIALOG_NOT_SEEN`。没配 dev-channels 的 Lead 本来就不弹框,
走的也是这个出口。日志因此无法区分:

* **良性**:本来就没框(`match_*` 全 0)
* **致命**:框在屏幕上、但守卫认不出(`match_local_dev=1`,部分命中)

这就是 issue 第 3 条要的可观测性:部分命中必须是一个**响的**信号。

## 6. 按键是否仍然正确

在隔离 tmux 里对真框单发 `1`(不发 Enter),会话立刻进入 prompt:

```
❯                          ← 确认通过,可收信
⏵⏵ auto mode on (shift+tab to cycle)
```

选项顺序 `1. I am using this for local development` / `2. Exit` 未变。
**单发 `1`、不发 Enter 依然正确,不需要改。**

## 7. 需要注意的一点(不在本单范围内)

49x16 对一个 TUI Lead 来说本身就偏小,它是这次翻车的触发条件。但把 pane 放大
要动 carrier / launchd,本单明确禁止(QA 判据 5),而且守卫本来就应该对任何
几何都成立。这里只修守卫,pane 几何另开单。
