# FLY-3026 parseBool 文本转布尔工具 — 调研
Issue: FLY-3026 (https://linear.app/geoforge3d/issue/FLY-3026/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1-rev3)
日期: 2026-09-28
基于: exploration.md

## 1. 大小写折叠的 Unicode 陷阱（已本机 `node -e` 实测）

- `"K".toLowerCase() === "k"`（开尔文符号 K 会折叠成 ASCII `k`）；`"İ".toLowerCase()` 得到 `"i̇"`（两码位）。
- 本词表只用到字母 `t r u e y s f a l n o` 与数字 `0 1`。已知的"非 ASCII → ASCII"小写折叠只有 `U+212A→k`、`U+0130→i̇`，**都不落在词表字母里**，所以"先 `toLowerCase()` 再精确查表"不会把怪字符误判成合法值。
- 仍然加一道**测试**钉住：全角 `"ＴＲＵＥ"`、开尔文等必须被拒绝（防将来有人扩词表时踩坑）。
- 用 `toLowerCase()` 而**不是** `toLocaleLowerCase()`：后者受运行环境 locale 影响（土耳其语 `I→ı`），会让 `"TRUE"` 在 tr 环境下失败。

## 2. `trim()` 的范围（已实测）

`"  true 　".trim() === "true"` —— 标准 `trim()` 去掉 NBSP 与全角空格。这符合"trimmed"的直觉，决定接受；**不**去掉零宽字符 `​`（`trim` 不认它为空白），因此 `"​true"` 会被拒绝，测试中钉住。

## 3. 同类库的词表对比（为什么不直接用）

| 库/惯例 | 真值 | 假值 | 与本需求差异 |
|---------|------|------|------|
| `yn`（npm） | `y yes true 1 on` | `n no false 0 off` | 多了 `y/n/on/off` |
| YAML 1.1 | `y yes true on`… | `n no false off`… | 更宽，且 1.2 已收窄 |
| 本需求 | `true yes 1` | `false no 0` | **严格白名单** |

结论：自写 ~10 行纯函数，词表严格等于需求。

## 4. 错误信息里回显输入的安全性

错误信息会带上被拒的输入以便排障，但输入可能来自环境变量/配置文件（外部输入）。处理：`JSON.stringify` 转义控制字符与引号，且**截断到 32 个字符**，防止日志注入与超长刷屏。非字符串输入只回显 `typeof`，不回显值（避免把对象/秘密整坨打进日志）。
