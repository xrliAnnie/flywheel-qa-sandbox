# FLY-1704 —— designer 节点到底有没有设计 skill？（Annie 直接问的）

Issue: FLY-1704
日期: 2026-08-12
问题原话: 「did use any design skills? do we have any design skills in the designer 节点?」

---

## 一句话

**声明了，但调不到。** designer executor 的 frontmatter 里写着 `frontend-design`，
但它不在这台机器的 ambient skill 列表里，**Skill 工具直接返回 `Unknown skill: frontend-design`**。

## ① 调得到吗 —— 调不到

实测（不是看配置推断）：

```
Skill(frontend-design)
→ Unknown skill: frontend-design
```

旁证：

- 我这个 session 的可用 skill 列表里**没有** `frontend-design`（也没有任何别的 design skill）
- `~/.claude/skills/` 下**一个** frontend/design 相关的都没有
- 文件确实存在于插件缓存，但**没有被装成 ambient skill**：
  - `~/.claude/plugins/cache/claude-plugins-official/frontend-design/{4d8c0bde0e99,99dc284733df}/skills/frontend-design/SKILL.md`
  - `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design`

这跟 executor 文档自己写的一致：**「skill availability is machine-ambient (NOT `skills:` above)」**
—— frontmatter 那一行是**文档性**的，不构成可用性。

## ② 里面有没有真的设计手艺 —— 有方针，没有参数

SKILL.md 一共 **41 行**，两节：`Design Thinking` / `Frontend Aesthetics Guidelines`。

**有用的（真的是设计判断，不是流程）**：

| 它说的 | 为什么对我们有用 |
|---|---|
| 别用 Inter / Roboto / Arial / 系统字体；**有个性的显示字 + 精致正文字配对** | 直接可执行，且正是「AI 味」的头号来源 |
| **「主色 + 尖锐强调色」胜过「平均分布的怯懦调色板」** | 🔴 **正好诊断了我前几轮的病** —— 我做的是 9 个角色色平均用力，结果每个都不突出 |
| 明令避开 AI 味套路，尤其**白底紫渐变** | 具体、可检查 |
| 空间构成要敢于不对称 / 重叠 / 破格 | 方向性 |

**没有的**：行高、字号阶、间距刻度、对比度数值 —— **一条具体排版参数都没有**。

**还有一处错配**：它开宗明义是 *"Implement real working code"*，面向的是**写代码**，
不是出概念图；而且它反复要求 "BOLD / extreme / maximalist"，
跟 Annie 这轮要的「清新（轻、通透）」方向其实是**相反的**。所以它不能照单全收。

## ③ 这轮出图有没有用上它 —— 分两半说

- **六版 vibe（`vibe-*.jpeg`）：没有。** 那批在收到这个问题之前就出完了。
- **六版清新（`fresh-*`）：用了它的内容，但不是「用了这个 skill」。**
  skill 调不到，我是**读了磁盘上的 SKILL.md**，把上面表格里那三条方针写进了 prompt。
  这两件事措辞上不能混：**我读了文件，不是加载了 skill。**

## 这是个真问题，不是我这一单的意外

我们有 designer 节点、role 文件里也**声明**了设计 skill，但**运行时拿不到** ——
也就是说，这个节点目前的「设计知识」全部来自模型本身，没有任何团队沉淀的设计手艺被喂进去。

修法不在这一单里，交给 Lead / infra 判：
- 要么把 `frontend-design` 装成 ambient skill（跟 flywheel-skills 的分发同一条路）
- 要么承认它不适用（它面向写代码、且推「bold」与我们多数场景相反），写一个我们自己的
- 无论哪条，**executor frontmatter 里「声明了但拿不到」的这种写法都会继续骗人** ——
  下一个 runner 同样会以为自己有这个能力。
