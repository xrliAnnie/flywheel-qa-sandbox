请画一张可直接交付给 Annie 的中文架构图，主题是「超长 Linear issue description 如何安全进入 tmux runner」。用同一张图清楚对比两条路径：

- 旧路径：把任务说明全文直接塞进 tmux / shell 启动命令，约 16 KiB 后触发 `command too long`，任务没有进入 runner；
- 新路径：先把原文写入仅本机可读的临时文件，启动命令只携带 3–5 KiB 的文件路径与窗口脚本，窗口内再读回原文，最终 Claude 收到的任务说明逐字一致。

要求：

1. 中文正文，自包含静态 HTML + inline SVG/CSS，无外链字体、无 script、无动画；
2. 1080×1080 正方形 architecture/data-flow diagram，浅色默认风格，暖白底、黑灰线条、橙色只用于 1–2 个焦点；
3. 旧路弱化但可读，新路是视觉主线；正交圆角连接、足够留白、≤9 个主要节点；
4. SVG 必须有 `role="img"`、`aria-labelledby`，且 `<title>` / `<desc>` 是 SVG 的前两个子元素；
5. 中文字体 fallback 至少包含 `PingFang SC`, `Hiragino Sans GB`, `Noto Sans CJK SC`, `Microsoft YaHei`, sans-serif；
6. 不询问品牌或配色：项目根已有默认配置；
7. 不修改项目里的任何技能、默认配置或任何项目外/用户级文件；
8. 只写 `engineering/doc/FLY-2022-diagram-design-install/evidence/natural-generated.html`，完成后检查它的可访问性、连线、文字重叠与截断并修正错误。

不要只解释做法；完成文件后简短报告结果。
