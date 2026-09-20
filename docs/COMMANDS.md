# 命令清单

统一使用 `/phi <命令>`，群聊先 @机器人。下表省略 `/phi ` 前缀；尖括号是需要填写的参数，方括号是可选参数，不要原样输入括号。
`/phi` 提供分类文本表格，`/phi help` 提供“命令／用法示例／说明”图片表格。`/phi tk help` 提供绑定说明，`/phi api help` 提供 API 图片帮助。

## 全部功能入口

| 模块 | 命令与主要别名 |
| --- | --- |
| 绑定与存档 | `bind` / `绑定`、`cnbind` / `cn绑定`、`gbbind` / `gb绑定`：后接 `qrcode` 或 `<sessionToken>`；`update` / `更新存档`；`unbind` / `解绑`；`clean`；`sessionToken` |
| 成绩 | `b<N>` / `rks` / `pgr`；`p<N>`、`x<N>`、`fc<N>`；`a b30`（趣味成绩图）；`lmtacc <ACC>`；`best <序号>`；`score[1或2] <曲名>` / `单曲成绩`；`suggest` / `推分` / `推分建议`；`chap [章节]`；`achievement` / `ahv` |
| 个人数据 | `data`；`info[1或2]`；`lvsco` / `lvscore` / `scolv`；`list [筛选条件]`；`年度总结` / `2025history`；`hisb30` |
| 排行榜 | `ranklist` / `排行榜`；`rankfind <名次>` / `查询排名` |
| 曲目与计算 | `song <曲名>` / `曲`；`search` / `查找` / `检索`；`setnick` / `setnic` / `设置别名`；`ill <曲名>` / `曲绘`；`randclg`；`rand` / `random` / `随机`；`alias <曲名>`；`com` / `计算`；`tips`；`newlog`；`live`；`table <定数> [-v <版本>]` / `定数表`；`difHis` / `difHistory` / `历史定数` |
| 评论与标签 | `comment` / `cmt` / `评论` / `评价`：后接曲名，可换行填写评论；`recmt <评论ID>`；`mycmt`；`addtag`、`subtag`、`retag`；`newnotice` |
| 谱面 | `chart <曲名>`；`tag <曲名>`；`settag <曲名>` |
| 别名提案 | `alias submit` / `alias 提案`；`alias mine` / `alias 我的`；`alias public` / `alias 公审`；`alias appeal` / `alias 申诉`；`alias vote` / `alias 投票`；`alias unvote` / `alias 撤票` |
| 签到与任务 | `sign` / `sign in` / `签到` / `打卡`；`task` / `我的任务`；`retask` / `刷新任务`；`send` / `送` / `转`；`theme <数字>`；`jrrp` / `今日人品` |
| 猜曲游戏 | `guess` / `猜曲绘`；`tipgame` / `提示猜曲`；`ltr` / `letter` / `开字母`；`tip` / `提示`；`ans` / `答案` / `结束`；普通消息回答曲名。开字母用 **`/开 a`**（不加 phi），也支持 `/出`、`/翻`、`/揭`、`/看`、`/翻开`、`/打开`、`/揭开`、`/open` 后接一个字符 |
| 个人设置 | `myset` / `mysetting` / `用户设置` / `个人设置`；`set` / `设置`（管理员） |
| 主题市场 | `market [子命令或参数]`；`nx` / `下一页`；`pr` / `上一页` |
| API 账号 | `setApiToken <token>`；`tkls` / `lstk`；`auth <token>`；`clearApiData`；`updateHistory`；`updateUserToken`（管理员）；`updateComment`；`apiset` |
| API Bot 管理 | `resetApiBot` / `重置API Bot身份`；`botClaimLink` / `获取Bot认领链接`（管理员） |
| 部署管理 | `repu`；`backup [back]`；`restore`；`get <名次>`；`del <sessionToken>`；`allow <sessionToken>`；`ban <功能或all>`；`unban <功能或all>`（管理员） |
| 更新 | `更新` / `gx`，也识别 `强制更新`、`qzgx` 等写法；`下载曲绘` / `更新曲绘` / `gxill` / `down ill` / `up ill`（管理员） |
| 帮助 | `help` / `命令` / `帮助` / `菜单` / `说明` / `功能` / `指令` / `使用说明`；`tk help` / `token help`；`api help` |

额外的接入命令：`/phi` 文本帮助、`/phi identity` 查看管理员配置 ID、`/phi license` 打开项目说明、`/phi reply <内容>` 回答多轮选择。多轮流程可回复 `取消`。

## 写法与权限

- `/phi b30`、`/phib30`、`#phi b30`、`/pgr b30`、`/屁股肉 b30` 均能进入相同处理函数。趣味成绩命令也保留 `杠phi啊比三零` 等写法。
- 无歧义的短命令如 `/b30`、`/gbbind`、`/ranklist`、`/api help` 可直接使用。**`/help`、`/send` 等宿主保留命令不能用于调用 Phigros**，请用 `/phi help`、`/phi send`。
- `phisign`、`phitask`、`phiretask`、`phitheme1` 等无斜杠写法仍可使用。
- 国服用 `/cnbind`，国际服用 `/gbbind`；`/bind` 使用 `defaultGlobal` 配置。扫码与 token 两种方式均保留。绑定、解绑和凭据管理请私聊，不能在群中发送 token。
- Notes 转赠：`/phi send <用户ID> <数量>`，用户ID可直接使用对方 `/phi identity` 显示的完整 ID，不一定是 QQ 号。接收方先在同一个 Bot 使用一次 `/b30`（无需绑定）以登记身份；已有结构化 @ 也可识别。不同 channel 或 Bot 账号之间不允许转赠。
- 管理员由 OpenClaw 插件配置的 `admins` 指定；获得宿主普通命令权限不等于成为插件管理员。恢复、删存档、清除 API 账号等操作会改变数据，请仔细核对后执行。

## 依赖与接入差异

本地存档查分、个人统计和签到不依赖额外查分 API。在线评论、标签、别名提案、主题市场、跨用户查询等仍保留，但需要启用 `enableApi`，以及服务端接受当前 Bot 身份、账号授权和可用网络。保留入口不代表外部服务已经过真实账号验收。

`更新`、`强制更新` 提供 OpenClaw 包管理器更新方法。`/phi downill` 刷新共享曲绘索引，从配置的资源仓库下载并校验完整曲绘库。

`backup` 等待备份完成再结束当前回复；ZIP 留在插件数据目录下的 `backup/`。`restore` 可选择已有 ZIP 恢复业务存档；完整迁移（包括 SQLite、设置等）请按 README 停机备份整个数据目录。`backup back` 不会在不支持群文件上传的 QQ channel 中伪装成上传成功。

QQ channel 的撤回、合并转发、主动消息和回复时限由宿主与平台决定；合并转发展开为普通消息/图片，自动游戏提示可能受回复窗口限制。

## 覆盖检查

对照迁移前代码，目前 16 个启用模块的 87 条业务规则均有对应入口。`Dan.js`、删除别名和封神榜在迁移前就是注释停用状态，不算可用命令。

`tests/openclaw-command-coverage.test.mjs` 逐项核对模块、处理函数和中英文别名，覆盖完整前缀、紧凑写法、短命令、游戏回答和命令冲突；新增或移除规则时必须同步清单。
`npm run smoke:gateway` 使用本机 OpenClaw 的真实启动规划和消息分发器验证接入，以模拟账号替代外部登录，不发送真实 QQ 消息。
