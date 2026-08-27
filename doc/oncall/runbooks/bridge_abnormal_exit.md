# `bridge_abnormal_exit`

## 现象

告警说明 Bridge 非正常退出；它也可能已经被服务管理器重新拉起。先把告警里的发生时间和 Bridge 身份当作本次事件的定位键。

## 去哪看 log 还原

从 Bridge 的服务启动配置取得 stdout/stderr log 位置，围绕告警时间查看退出前后的记录。若告警正文给了额外的错误摘要，用它缩小范围；不要假设当前机器的 log 路径。

## 做了什么

先从 log 确认当时实际发生了什么。若服务管理器已经拉起 Bridge，只记录这个事实；页面不要求 bot 再重启。原因仍不清楚时，把相关时间段和错误摘要交给 contact book 对应负责人。

## 怎么确认好了

由 contact book 对应负责人选择与事故相称的观察范围；在后续 Bridge log 中看到正常服务记录，且同一现象没有继续出现，才记为恢复。

## 该找谁

按 [`../contact-book.md`](../contact-book.md) 的 `bridge_abnormal_exit` 行找负责人；需要重启或部署决定时也先由该负责人协调，不从本页自行执行。
