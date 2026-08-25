帮我画一张中文架构图，讲清楚 Flywheel 里一个 Linear issue 是怎么变成一个已合库的 PR 的。

主要环节：Linear issue 建单 → CoS 分诊打部门标签 → 部门 Lead 接单 → Lead 起一个 tmux Runner → Runner 依次走 onboard、设计、实现、独立 QA → 开 PR → founder 在 Discord 上点批准 → 合库。其中独立 QA 判 FAIL 时会打回到「实现」那一步重来，这条返工线要在图里画出来。

请生成一个自包含的静态 HTML 文件（inline SVG + inline CSS，不要外链、不要 script、不要动画），中文正文，正方形画幅，写到：

engineering/doc/FLY-2022-diagram-design-install/qa-evidence/qa-independent-generated.html

不要写这个项目目录以外的任何文件。画完以后自己检查一遍有没有文字重叠、连线错位、文字截断或无障碍属性缺失，有问题就改掉，然后简短报告结果。
