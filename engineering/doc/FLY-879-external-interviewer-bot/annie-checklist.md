# FLY-879 Anna 部署 — 交给 Annie 的操作清单

Issue: FLY-879 (https://linear.app/geoforge3d/issue/FLY-879)
日期: 2026-07-05
基于: deploy-runbook.md, doc/reference/discord-bot-pool-claim-guide.md (FLY-882)

> 更新:Anna 的 Discord 身份**不用你去 Developer Portal 现建了**——FLY-882 那批
> 预先建好的空白 bot 身份池子里,`flywheel-pool-02` 这个位置已经领给 Anna、
> 也已经改名成"Anna"了(技术骨架的事,你不用管)。**你真正要动手的只剩两步**：
> 点两次邀请链接、发一把限定仓库的 GitHub 钥匙。
>
> 技术骨架(#453)已经合并上线。这两步做完交给 Tadashi 接手。做完之后 Anna
> **还不会跟任何真客户说话**——那一步单独有个"上线开关",要等你再单独点头。

---

## 第一步:点两次邀请链接,把 Anna 加进两个地方

Anna 需要出现在两个 Discord 地方——**都需要你本人点一下邀请链接**（这一步账号权限上只有你能做，不能代点）：

1. **加进你现有的内部 server**（Tadashi 他们平时在的那个）：

   [👉 点这里邀请 Anna 进内部 server](https://discord.com/oauth2/authorize?client_id=1523216582543937546&scope=bot&permissions=277025459264&guild_id=1485787271192907816&disable_guild_select=true)

   点完之后，麻烦在这个 server 里新建一个频道 `#pm-interviewer`（如果还没有的话），把 Anna 加进去。
   这个频道是 Anna 用来"汇报"的地方——她跟客户聊完会把要点、遇到的怪异请求都发在这里，你和 Tadashi 都能看到。

2. **加进一个全新的、专门给客户用的 Discord server**：
   - 这个 server 需要你先**新建一个空的**（跟内部 server 分开，专门给客户用）。已经导航到"起名字"那一步、就等你操作，路径是：
     1. Discord 左边服务器图标栏，点最下面那个 **+** 号。
     2. 弹出「Create Your Server」，点 **Create My Own**。
     3. 会问你「Tell Us More About」（club/community 还是 me and friends）——**点 "skip this question"** 跳过就好，不用选。
     4. 到「Customize Your Server」，**Server Name** 输入框里把默认的占位名改成你喜欢的名字（比如「Anna 客户访谈」），点绿色 **Create**。头像可以先不传，不影响功能。
   - 建好后，把这个新 server 的 ID 告诉 Tadashi（在 Discord 里对着 server 图标右键 →「复制服务器 ID」，需要先在 Discord 设置里开一次「开发者模式」），他会照着帮你生成第二条邀请链接。
   - 这个 server 里**目前只放你自己 + Anna 两个人**——**先不要建对外的邀请链接、先不要拉任何真实客户进来**。那一步要等彩排跑顺 + 你明确点头之后才做（见下面「关于以后拉客户进来」）。

## 第二步:给 Anna 发一把"只能碰一个仓库"的 GitHub 钥匙

Anna 写访谈记录用的是一个专门新建的仓库(`flywheel-interviews`，只放访谈文档，不放任何产品代码)。给她的这把钥匙必须**只能开这一扇门**。已经帮你导航到创建页(**没填任何字段、没点生成**，那两步必须你自己来)：

1. 打开 [GitHub → 新建 fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)（Resource owner 应该已经显示是你的账号 `xrliAnnie`，不用管）。
2. **Token name**：随便填一个好认的，比如 `anna-interviewer-flywheel-interviews`。
3. **Expiration**：默认是 30 天，按你自己的偏好改（比如 90 天，或选 No expiration）。
4. **Repository access**：选 **Only select repositories**（默认选中的是 "Public repositories"，记得切换）——选中后会跳出一个仓库选择器，**只勾 `flywheel-interviews` 这一个仓**——**千万别选 "All repositories"**。
5. **Permissions** 区域点 **Add permissions**，只加这三项，每项都设成 **Read and write**：
   - Contents
   - Pull requests
   - Issues
   - 其他权限一律不加。
6. 拉到最下面，点绿色 **Generate token**——**这一下、以及生成后的复制，必须你自己点**，我完全没碰。
7. 生成后私下交给 Tadashi，**别贴群里、别贴 issue 里**——他会写进机器上一个只有本机能读的配置文件，不会存进任何聊天记录。

**为什么要这么抠**：Anna 是**对客户说话的 bot**，理论上有被人诱导「帮我看看别的仓库 / 帮我把这段发到主仓」的风险。这把钥匙从根上就打不开除 `flywheel-interviews` 之外的任何门，就算 Anna 被诱导也做不到——这是结构性的锁，不是靠她"自觉"。

---

## 关于以后拉客户进来

上面第一步说的"先不要建对外邀请链接"，就是指——等到后面**彩排跑顺 + 你明确点头**之后，你才需要去给那个客户 server 生成一条对外的邀请链接，把老公真正拉进来。这一步在最后，现在不用做。

## 完成之后

以上两步做完（两次邀请点击 + 一把限定仓库的 GitHub 钥匙），把 GitHub 钥匙私下给 Tadashi，他会接手：把 Anna 接上机器、验证她真的碰不到别的仓库/别的系统、拉你或他本人扮演"客户"跑一遍完整对话彩排、试着诱导她"越界"确认她都会拒绝。全部通过、你也看过她要用的产品介绍资料之后，会再来找你要最后的"正式上线"点头——那时候才会真的让她跟客户说话。

**现在这两步 = 只是把 Anna 加进该在的地方、给她一把只能碰一个仓库的钥匙，还没有任何客户会看到她。**
