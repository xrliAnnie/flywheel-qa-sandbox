# FLY-1827 Voice 线评估 — 计划与续接指引

Issue: FLY-1827 (https://linear.app/geoforge3d/issue/FLY-1827)
日期: 2026-08-17
基于: `exploration.md` · `research.md` · `audit.md`(同文件夹)

> **本文件的分工**:这份写「**做了什么、现在停在哪、下一步是什么、别人怎么接**」。
> **判据(Annie 定的)**:如果这一单被搁置三个月,另一个人只读这个文件夹,**能不能接着做下去**。
> 本文件按这条写 —— §4「三个月后接手」是它存在的理由。

---

## 1. 这一单是什么 / 不是什么

**是**:一次 Voice 线的历史打捞 + 时效核查,产出是 Annie 下周那场 Voice 方向对话的**弹药**。

**不是**:
- 不是方向建议 —— **红线:不许给方向结论**,explainer 的结论区三版全部留空
- 不是 PRD —— 不设计方案
- 不改生产代码 —— 只读 + 写文档

**交付形态**:一份 founder-facing explainer HTML,经 `founder_review` 逐版收敛。

---

## 2. 文件夹地图(接手先读这张)

| 文件 | 是什么 | 什么时候读 |
|---|---|---|
| `plan.md`(本文件) | 状态 + 续接指引 | **先读这个** |
| `exploration.md` | 真问题 + 三轮共创轨迹 + 方向性发现 | 想知道「为什么长成这样」 |
| `research.md` | 检索方法 + 来源清单 + **可靠性分级** + 查不到的 | 想复核或继续查 |
| `audit.md` | **证据台账** —— 每条声称的逐条出处;末尾有两个「📌 可直接引用块」 | 要引用具体结论时 |
| `voice-audit.html` | 给 Annie 的 explainer(当前 v3) | 要改稿或看她看到了什么 |
| `progress.md` | 机器可读的进度游标 | 恢复调度用 |

**读序建议**:`plan.md` → `exploration.md` §3(共创轨迹)→ `research.md` §3(可靠性分级)→ 按需查 `audit.md`。

---

## 3. 已执行的步骤

| # | 步骤 | 产出 | 状态 |
|---|---|---|---|
| 1 | onboard + 建文件夹 + progress ledger | — | ✅ |
| 2 | Linear 考古(5 组检索 + 16 单细读) | `audit.md` §① | ✅ |
| 3 | PRD 判定(含「什么算 PRD」的判据) | `audit.md` §② | ✅ |
| 4 | 代码 + 运行时 ground truth | `audit.md` §③ | ✅ |
| 5 | 外部一手时效核查 | `audit.md` §④ | ✅ |
| 6 | explainer **v1** → `founder_review` | commit `445e5865e` | ✅ passed=false(实质反馈) |
| 7 | **v2**:重心翻到 Codex,答她两问,修正她一个前提 | commit `d21de7717` | ✅ passed=false(她答了 topic 块 1) |
| 8 | **v3**:答「新 CoS」+ 报 Discord 盲区 + 结构现状 | commit `d242ab0cb` | ✅ **← 等 verdict** |
| 9 | 补录:更正 FLY-1443 §2.3(E1 vs D3) | commit `4ec61132d` | ✅ |
| 10 | 两个自足「可直接引用块」(给 FLY-1844) | commit `cf366f9fb` | ✅ |
| 11 | 时间戳更正(FLY-1844 证明 v3 未被拒) | commit `8743622bd` | ✅ |
| 12 | transport caveat(E1/D3 未隔离 transport) | commit `836704d04` | ✅ |
| 13 | 文档档位 none→full,补三件套 | 本文件 + `exploration.md` + `research.md` | ✅ |

---

## 4. 🔴 三个月后接手 —— 从这里开始

### 4.1 第一件事:确认这一单还活着

```bash
node ~/Dev/flywheel/packages/flywheel-comm/dist/index.js check 9b24110f-9504-4678-9144-0c4ea219b118
```

- 返回 `not yet` → **仍在等 Annie 的 verdict,什么都别做,别开新一轮**
- 返回 `passed: true` → 走 §4.3
- 返回 `passed: false` + feedback → 走 §4.2

> `9b24110f-9504-4678-9144-0c4ea219b118` 是 v3 那一轮的 questionId。
> **founder_review 是 founder 绑定的,Lead 替答会被系统当场拒绝** —— 只能等她本人。

### 4.2 如果是 passed=false(改稿路径)

1. 读她的 feedback —— **注意她的 verdict 往往不是挑刺,而是给新方向**。
   三轮里两轮都是这样(轮 1 翻转重心到 Codex;轮 2 答了 topic 树第 1 块)。
2. 按反馈改 `voice-audit.html`,**结论区永远留空**。
3. commit → `publish-report --publish-only` → **curl 自测托管页**(200 / `__CSP_NONCE__` 残留 0 / `<script nonce=` 存在)
4. 开**新的** `founder_review`(旧卡不能复用)。
5. 报 Lead(`flywheel-comm ask --report`)。

命令模板见 §5。

### 4.3 如果是 pass(收尾路径)

1. 确认工作树干净,开 PR,base = `main`。
2. `flywheel-comm complete --route needs_review --pr <NUMBER>`。
3. **不要自己 merge、不要请求 ship** —— 本节点无 ship 权。

### 4.4 无论哪条路,先知道这些还没做完

| 悬着的 | 归谁 | 备注 |
|---|---|---|
| **把 Annie 的「新 CoS」原话补进 FLY-1451** | Lead(已做) | 原话在 `audit.md` 第 3 轮段落,那是唯一留档 |
| **代捞 Discord 聊天记录** | Lead / 有读权限的人 | 我没工具;需向 Annie 要时间锚点 |
| **⑤ 那 5 条「issue 与代码不符」转 follow-up issue** | Lead | Annie 要求这类不符转 issue 去 track;等她 verdict 后派 |
| **7/24 后 voice 为什么停** | 只有 Annie 知道 | 无任何记录;值得补一句留档 |
| `/eleven` 清理 | **FLY-1843**(已建) | 范围见 `audit.md`:干净目录 6 源 + 6 测 + 2 e2e,另约 10 处共享接线要拆 |
| Codex 语音总管落地 | **FLY-1844**(已派) | **开工前必读** `audit.md` 的两个「📌 可直接引用块」 |

---

## 5. 命令模板(照抄即可)

```bash
cd ~/Dev/flywheel-FLY-1827

# 1) 发布(runner 必须 --publish-only,不得直投频道)
node ~/Dev/flywheel/packages/flywheel-comm/dist/index.js publish-report \
  --html product/doc/FLY-1827-voice-line-audit/voice-audit.html \
  --project flywheel --publish-only

# 2) 托管页自测(生成期的绿 ≠ 运行期的绿)
U="<上一步返回的 url>"
curl -s -o /tmp/v.html -w '%{http_code}\n' "$U"      # 必须 200
grep -c '__CSP_NONCE__' /tmp/v.html                   # 必须 0
grep -o '<script nonce="[^"]\{6,\}"' /tmp/v.html      # 必须有

# 3) 开新一轮 founder_review
node ~/Dev/flywheel/packages/flywheel-comm/dist/index.js gate founder_review \
  --lead flywheel-product-lead --exec-id <你的 exec-id> --no-block \
  --hosted-url "$U" \
  --artifact product/doc/FLY-1827-voice-line-audit/voice-audit.html \
  "<一句话说明这版改了什么>"

# 4) 报 Lead(唯一有效回报通道;SendMessage 是黑洞)
node ~/Dev/flywheel/packages/flywheel-comm/dist/index.js ask \
  --lead flywheel-product-lead --exec-id <你的 exec-id> --report "..."
```

---

## 6. 接手前必须知道的坑

1. **`founder_review` 只能 Annie 本人答。** Lead 替答会被系统拒绝。等她不是卡住,是正常状态。
2. **不许给方向结论。** 这是 Annie 的红线,explainer 结论区永远留空。
3. **她的 passed=false 常常是给方向,不是挑刺。** 先读内容再判断要不要大改。
4. **建 founder-facing 的 issue 要经 Lead**,runner 不自己建。
5. **发布必须 `--publish-only`**,runner 直投频道会被硬拒。
6. **`gate question` 消息里别用反引号**(zsh 命令替换会炸)。
7. **别把补文档塞进给 Annie 看的页面** —— 过程文档是仓库产物,不是她的决策页内容。
8. **引用 FLY-1443 的结论前,先读 `audit.md` 末尾的两个引用块** ——
   那份报告的 §2.3 有一处错、我又叠加了一处错,两处都已就地标注。
   **承重对照用 FLY-1844 的 P1-vs-P6 / P8-vs-P6,不要用 E1/D3。**
