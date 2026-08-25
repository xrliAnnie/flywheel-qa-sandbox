帮我画一张中文的架构图，讲清楚「超长的 Linear issue description 是怎么安全送进 tmux runner 的」，把修复前和修复后放在同一张图里对比：

- 修复前：把任务说明全文直接塞进 tmux 的启动命令，命令超过大约 16KB 就会报 command too long，runner 根本起不来；
- 修复后：全文先写进一个只有本机能读的临时文件，启动命令里只放文件路径，新窗口里的小脚本再把原文读回来，最后 Claude 收到的任务原文和修复前逐字一致。

图存成一个自包含的 HTML 文件（不要外链、不要脚本、不要动画），路径是：

engineering/doc/FLY-2022-diagram-design-install/qa-evidence-2/generated-natural.html

不要写这个项目目录以外的任何文件。画完自己检查一遍有没有文字重叠、连线错位、文字截断，有问题就改掉，然后简短说一下结果。
