# phi-plugin-openclaw

OpenClaw 专用的 Phigros 查分插件。支持 QQ Bot channel 中私聊查分，以及群聊 **@机器人 `/b30`**。
项目地址：[Hydroiodic/phi-plugin-openclaw](https://github.com/Hydroiodic/phi-plugin-openclaw)。

- 支持国服与国际服绑定、B30 查分、单曲成绩、推分建议、历史记录和排行榜。
- 提供曲目信息、定数表、签到任务、猜曲游戏及个人主题设置。
- 使用 OpenClaw 原生命令接口，查分不调用大模型。
- 数据保存在本机，使用 SQLite，无需配置数据库服务。
- 曲目元数据与曲绘从资源仓库下载，支持自建镜像；曲绘按需缓存、跨版本复用。

## 安装

需要已有的 OpenClaw **2026.9.3 或更新版本**、满足其要求的 Node.js（推荐 Node.js 24 LTS），以及已能收发消息的 QQ channel。
QQ channel 需单独安装、配置，可使用 `@tencent-connect/openclaw-qqbot`，对应 channel ID 为 `qqbot`。

默认资源仓库为 `https://hydroiodic.site/phi-plugin-openclaw/resources/v1/`。
首次查分时自动下载曲目元数据，也可以按 [资源仓库部署规范](docs/RESOURCE_REPOSITORY.md) 配置自己的镜像。
`/phi` 文本帮助不依赖资源仓库；查分需要下载完成。

### 从源码安装

下载或克隆本项目后，在项目目录执行一行安装命令：

```bash
npm install --omit=dev --ignore-scripts && node scripts/install-openclaw.mjs --force --accept-capabilities && openclaw gateway restart
```

这会安装依赖、把当前目录链接到 OpenClaw，然后重启 Gateway。链接安装后请保留该源码目录，不要移动或删除它。
`--force` 是 OpenClaw 对本地/Git/npm 来源的明确确认；`--accept-capabilities` 接受插件声明的能力。
安装脚本只安装本插件，不修改 QQ 凭据、模型配置或其他插件。重启会短暂中断 Gateway 的消息处理。
如果 Gateway 没有作为服务安装，请运行你原本启动 OpenClaw Gateway 的命令。

也可直接使用 OpenClaw CLI（依赖已安装时）：

```bash
openclaw plugins install --link . --force --accept-capabilities
openclaw gateway restart
openclaw plugins inspect phi-plugin-openclaw --runtime --json
```

检查结果应包含 `status: "loaded"`、`b30` 等 commands 和 `reply_dispatch` hook。
`inspect --runtime` 验证当前 CLI 进程的注册结果；重启后的实际 QQ 消息才验证正在运行的 Gateway。
Gateway 日志中应包含 `phi-plugin-openclaw` 和 `Phigros ready: commands and reply_dispatch registered`（开启存档工具时后面还有 `, save tools enabled`）。

### 从 Git 仓库安装

使用 OpenClaw CLI 一行安装：

```bash
openclaw plugins install git:github.com/Hydroiodic/phi-plugin-openclaw --force --accept-capabilities && openclaw gateway restart
```

## 在 QQ 中使用

1. 私聊机器人发送 `/phi`，确认出现文本帮助。
2. 私聊发送 `/bind qrcode`，按提示扫码绑定 TapTap；也可发送 `/bind <sessionToken>`。明确选服时，国服使用 `/cnbind qrcode`，国际服使用 `/gbbind qrcode`；`qrcode` 也可替换为对应服的 sessionToken。`/phi cnbind`、`/phi gbbind` 同样可用。
3. 私聊发送 `/b30`；在群里发送 `@机器人 /b30`。
4. 游戏内上传新存档后，发送 `/phi update`，再查分。`/unbind` 解除本地绑定。

sessionToken 是敏感登录凭据。群聊中的绑定、解绑和凭据管理会被拒绝；请使用与机器人的私聊。
扫码时必须使用自己触发的二维码。插件不会把账号凭据交给大模型，但消息平台和 OpenClaw 自身可能保存原始消息，
请只在你信任的机器人上绑定；优先使用扫码方式。

发送者身份使用 `channel + accountId + senderId` 隔离，同一 QQ Bot 账号下私聊与群聊共用个人绑定。
QQ 平台若为不同场景分配不同 OpenID，需要分别绑定；插件不会猜测两个不同 ID 属于同一个人。

### 常用命令

| 功能                           | 示例                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| 分类表格帮助（文本 / 图片）    | `/phi` / `/phi help`                                         |
| B30、更多成绩                  | `/b30`、`/b40`、`/phi b50`                                   |
| P30、FC、其他成绩列表          | `/p30`、`/fc30`、`/x30`                                      |
| 更新存档 / 解绑                | `/phi update` / `/unbind`                                    |
| 国际服 / 国服绑定              | `/gbbind qrcode` / `/cnbind qrcode`，也支持后接 sessionToken |
| 单曲成绩                       | `/score Rrhar'il`                                            |
| 推分建议                       | `/suggest`                                                   |
| 个人信息 / 成绩筛选 / 定数统计 | `/phi info`、`/phi list`、`/phi lvsco`                       |
| 章节成绩 / 成就 / 历史         | `/phi chap`、`/phi achievement`、`/phi hisb30`               |
| 曲目信息 / 检索 / 曲绘         | `/song Credits`、`/phi search`、`/phi ill Credits`           |
| 定数表 / 计算 / 随机曲目       | `/phi table 15`、`/phi com`、`/phi rand`                     |
| 本机绑定用户排行榜             | `/phi ranklist`                                              |
| 签到、任务、今日人品           | `/phi sign`、`/phi task`、`/phi jrrp`                        |
| 群聊猜曲绘、提示猜曲、开字母   | `/phi guess`、`/phi tipgame`、`/phi ltr`                     |
| 个人主题与统计展示             | `/phi myset`                                                 |
| 多轮选择或游戏回答             | `@机器人 /phi reply 1`；也可按原提示回复                     |
| 管理员身份 / 项目说明          | `/phi identity` / `/phi license`                             |

完整功能入口、别名、参数和权限见 [命令清单](docs/COMMANDS.md)。
详细参数也可看 `/phi help`、`/phi tk help`、`/phi api help`。
`/phi b30`、`/phib30` 与 `/b30` 均可；优先推荐 `/phi <命令>`，减少与其他插件的短命令冲突。
OpenClaw 自带 `/help` 等命令仍可使用。群聊是否必须 @、哪些用户能够访问，由 QQ channel 的接入策略决定。
若多个歌曲匹配同一别名，按提示选择序号；多轮状态按用户、会话和线程隔离。

普通 `/phi`、`/b30` 等查询不要求发送者拥有 OpenClaw 控制命令权限；`/phi set` 等管理操作仍由本插件的 `admins` 单独校验。
如果 `/phi` 被大模型回答成“没有识别到这个命令”，说明消息未被插件接管。先运行
`openclaw plugins inspect phi-plugin-openclaw --runtime`，确认包含 `reply_dispatch` 和 `phi` 命令，
再检查 **Gateway 自身的启动日志**，确认实际加载了插件；安装或调整配置后执行 `openclaw gateway restart`。
若已加载，检查插件 `channels` 是否包含当前 channel；普通查分用户无需加入管理员列表。
Linux systemd 安装可执行 `journalctl --user -u openclaw-gateway.service -n 100 --no-pager` 查看启动日志。

### 可选在线功能与平台限制

默认直接从 Phigros 官方云存档获取自己的数据，**不要求部署 phi-plugin-api**。
联合查分 ID、主题市场下载、在线评论/标签/别名提案、跨用户在线查询和部分统计分析依赖外部 API；需要在下方配置中开启 `enableApi`，
并满足服务端的账号、Bot 认证和用户授权要求。可用性取决于对应服务。
本地主题、基础 B30、个人数据、签到等不需要该 API。

QQ 官方 Bot 不保证支持撤回、私聊转发、合并转发或群文件等能力。转发内容展开为普通消息/图片；
从群聊转发凭据到私聊的操作会提示改到私聊执行。自动超时提醒和游戏提示受当前 QQ 回复窗口及 OpenClaw dispatcher 生命周期限制。
管理备份保存在服务器的数据目录中；`/phi restore` 可选择 ZIP 恢复业务存档，完整数据迁移请使用下方停机备份流程。插件更新由 OpenClaw 管理。

### 让 AI 助手查看和修改自己的存档

插件自带 `phigros-save` skill 和 `phigros_save_fetch`、`phigros_save_read`、`phigros_save_edit`、`phigros_save_upload` 四个工具。
在私聊里对助手说“看看我 IN 难度的成绩”“把我的简介改成今天也要 AP 然后上传”，助手会下载并解密**你自己绑定的**云存档，
查看或修改成绩、Data、课题等级、头像、背景、简介和游戏设置，然后准备上传。

- **只能操作自己的存档。** 身份只来自 OpenClaw 提供的消息发送者，工具没有“指定用户”或凭据参数，助手无法读取或修改别人的存档。
- **只在按用户隔离的私聊会话中可用。** 群聊和多人共用的会话里工具直接拒绝，存档内容不会进入别人能看到的对话。
  OpenClaw 默认 `session.dmScope` 为 `main`，所有私聊共用一个会话，此时工具会拒绝工作；需要改为按用户隔离：

    ```bash
    openclaw config set session.dmScope per-channel-peer   # 一个 channel 接多个 Bot 账号时用 per-account-channel-peer
    openclaw gateway restart
    ```

- **上传必须由本人确认。** 插件把修改清单和 6 位确认码直接发给用户，用户自己发送 `/phi 确认上传 <确认码>` 才会上传，
  `/phi 取消上传` 放弃；确认码 10 分钟内有效，助手无法代为确认。
- **不写入不合理的数据。** 分数、acc 与 Full Combo 必须能同时出现；插件无法无损重建的存档（例如游戏更新了存档格式）只读不写。
- **可以恢复。** 上传前原存档备份到数据目录的 `backup/saves/`；读取之后云端若出现新存档（例如在游戏里同步过）则取消上传；
  上传后重新下载校验，校验失败时把云端记录指回原文件。

上传流程按社区公开的 TapTap 云存档接口实现，仓库中的测试使用模拟服务端。第一次使用前建议先在游戏内同步一次，确认原存档已备份。
不需要此功能时在配置中设置 `saveEditing: false`。

## 配置

默认即可查分，无需填写数据库地址、用户名或密码。以下示例合并到已有 `openclaw.json` 的对应位置，保留已有的其他字段：

```json
{
    "plugins": {
        "entries": {
            "phi-plugin-openclaw": {
                "enabled": true,
                "config": {
                    "channels": ["qqbot"],
                    "admins": [],
                    "enableApi": false,
                    "renderScale": 100,
                    "renderNum": 1,
                    "timeout": 20000
                }
            }
        }
    }
}
```

| 配置                    | 说明                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `channels`              | 允许的 channel ID；未配置或空数组表示全部，QQ Bot 是 `qqbot`                                             |
| `admins`                | 管理员身份列表，格式 `channel:accountId:senderId`，从 `/phi identity` 获取；普通命令授权不等于管理员权限 |
| `enableApi`             | 是否启用外部联合查分服务，默认 `false`                                                                   |
| `saveEditing`           | 是否允许 AI 助手在私聊中读取、修改用户本人的云存档，默认 `true`；上传始终需要用户本人确认                |
| `dataDir`               | 可选，自定义持久数据目录；建议绝对路径                                                                   |
| `resourceBaseUrl`       | 自建资源仓库的根 HTTPS 地址，默认 `https://hydroiodic.site/phi-plugin-openclaw/resources/v1/`            |
| `resourceVersion`       | `latest`（默认）或游戏版本，如 `3.20.0`；首次解析 latest 后缓存，手动更新                                |
| `downloadIllustrations` | 是否预下载完整共享曲绘库，默认 `false`；默认按需下载单张并校验缓存                                       |
| `chromiumPath`          | 可选，指定现有 Chrome/Chromium 可执行文件                                                                |
| `renderScale`           | 图片比例 50–200，默认 100                                                                                |
| `renderNum`             | 同时渲染的浏览器数量 1–4，默认 1                                                                         |
| `timeout`               | 图片页面加载超时，毫秒，默认 20000                                                                       |

例如在 Linux 上使用本机 Chrome：

```bash
openclaw config set plugins.entries.phi-plugin-openclaw.config.chromiumPath /usr/bin/google-chrome
openclaw gateway restart
```

更多功能设置存放于数据目录的 `config/config.yaml`。OpenClaw 中显式配置的渲染参数优先；
命令前缀为 `/phi`，API 总开关以 OpenClaw 的 `enableApi` 为准。修改这些配置后重启 Gateway。
`/phi set` 为管理员设置命令，个人设置使用 `/phi myset`。

## 存储与升级

采用 **Node.js 内置 SQLite** 保存绑定、缓存键值、过期状态和排行榜，不需要 MySQL、Redis、Docker 或编译数据库扩展。
成绩存档、历史与主题使用 JSON/YAML/资源文件，统一放到持久目录。

默认目录为 OpenClaw 状态目录下的 `phi-plugin-openclaw/`（普通安装通常是 `~/.openclaw/phi-plugin-openclaw/`；profile 会使用自己的目录）：

```text
phi-plugin-openclaw/
  phi.sqlite             绑定、TTL 缓存、排行榜（运行时可能有 -wal/-shm）
  config/                业务配置、别名与其他配置
  data/                  成绩存档、历史、个人设置
  themes/                本地主题与可选下载主题
  resource-cache/        按镜像隔离：v/<版本>/song-data/ 保存元数据，illustrations/ 保存共享曲绘
  otherill/              用户曲绘
  backup/                管理命令生成的备份；saves/ 是 AI 助手上传前保存的原云存档
  browser/               没有系统 Chrome 时下载的浏览器
  temp/                  临时渲染文件和浏览器 profile
```

待发送图片位于 OpenClaw 的 `media/phi-plugin-openclaw/`。该目录属于可删除的输出缓存，不是成绩数据。
SQLite 文件创建时采用 `0600` 权限，持久数据目录采用 `0700`；它不是加密数据库，请控制服务器账号访问权限。
升级只替换插件代码，不会把上述持久目录一起覆盖。

备份最简单的方法：停止 Gateway，复制整个持久数据目录，再启动。停止后复制可以避免遗漏 SQLite WAL 中未合并的写入。
恢复时同样先停止 Gateway，再把自己的备份恢复到原目录，保留文件权限。不要把真实数据、凭据或备份提交到 Git。

已安装 Git/npm 版本：

```bash
openclaw plugins update phi-plugin-openclaw
openclaw gateway restart
```

本地链接版本：在源码目录更新代码并重新安装依赖，再重启 Gateway。
卸载使用 `openclaw plugins uninstall phi-plugin-openclaw`；持久数据位于独立目录，删除前请自行确认并备份。

## 图片与资源

图片通过模板和浏览器渲染。首次需要图片时优先查找系统 Chrome；未找到时下载与 Puppeteer 匹配的 Chrome for Testing，
不在 npm 安装阶段执行浏览器下载脚本。浏览器按需启动、空闲后退出，关闭插件时释放。
无桌面的最小 Linux 容器仍可能缺少 Chrome 所需的系统动态库，此时需要安装系统 Chrome 或按它的提示补库；SQLite 不需要任何额外服务。
已有浏览器时设置 `chromiumPath` 可以避免下载。

曲目名称、定数、历史版本等元数据**不在插件安装包里**，第一次执行查分命令时从资源仓库下载。
下载有 SHA-256 校验和解压限制，完成后缓存到数据目录；已有缓存时启动不联网检查，仓库暂时离线仍可加载数据。
Phigros 云存档获取本身仍需要联网。更新资源失败保留旧版本；运行中的进程不会中途切换曲目数据。

曲绘来自同一资源仓库下的 **`illustrations/` 公共资源库**，与曲目数据版本独立。
`illustrations/index.json` 将曲目 ID 映射到以 SHA-256 命名的图片对象；发送图片和渲染前先检查大小及哈希，再写入本地缓存。
默认按需下载需要的图片，同一内容只缓存一份；切换或更新曲目数据版本时继续复用。
启用 `downloadIllustrations: true`，或由管理员执行 `/phi downill`，可通过 ZIP 分包下载完整曲绘库并刷新曲绘索引。
曲绘索引、单图和 ZIP 都使用配置的资源仓库地址；`PHI_RESOURCE_BASE_URL` 对元数据与曲绘同时生效。
已有曲绘缓存可离线使用；缺失或校验失败的图片显示内置占位图并记录警告，不会把损坏文件交给渲染器。
游戏资源只用于展示，归各自权利人所有。

### 自建镜像、环境变量与资源升级

配置方式（修改已有配置，不需要修改代码）：

```bash
openclaw config set plugins.entries.phi-plugin-openclaw.config.resourceBaseUrl https://your.example/phigros/resources/v1/
openclaw config set plugins.entries.phi-plugin-openclaw.config.resourceVersion latest
openclaw gateway restart
```

也可以在**运行 Gateway 的进程环境**中设置：

```bash
export PHI_RESOURCE_BASE_URL=https://your.example/phigros/resources/v1/
export PHI_RESOURCE_VERSION=3.20.0
openclaw gateway run
```

优先级：环境变量 > OpenClaw 插件配置 > 默认值。systemd 等服务必须在服务环境配置这些变量；
仅在终端 `export` 后重启已安装服务，不保证服务继承变量，因此常规部署推荐配置项。
HTTPS 为默认要求；`http://127.0.0.1` / `localhost` / `[::1]` 仅供本机测试。
地址不能包含用户名、密码、查询参数；镜像内链接均为相对路径，所以复制同一套文件即可换域名或子目录。

在本项目源码目录列出和更新资源（CLI 显式参数优先于环境变量）：

```bash
npm run resources -- list --base-url https://hydroiodic.site/phi-plugin-openclaw/resources/v1/
npm run resources -- install --base-url https://hydroiodic.site/phi-plugin-openclaw/resources/v1/ --data-dir "$HOME/.openclaw/phi-plugin-openclaw"
openclaw gateway restart
```

加 `--version 3.20.0` 可选择曲目数据版本，加 `--illustrations` 同时刷新并下载共享曲绘库。
脚本**不读取 openclaw.json**；自定义 `dataDir`、profile、镜像和版本时，请传入与 Gateway 一致的参数。
CLI 会明确联网刷新索引；安装后重启 Gateway。若锁定了 `resourceVersion`，还需将配置改为目标版本。
旧版本目录保留，可回退；不同镜像互不共用缓存。

服务器只需静态 HTTPS 文件服务，不需要数据库或动态 API。
具体目录、JSON 字段、latest 语义、缓存头、发布顺序和生成命令见 [资源仓库部署规范](docs/RESOURCE_REPOSITORY.md)。

## 开发与验证

模块职责、生命周期、存储边界和贡献约定见 [架构与开发规范](docs/ARCHITECTURE.md)。

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm run format        # Prettier 格式化；推送后 GitHub Actions 也会自动格式化并提交
npm run lint
npm test
npm run typecheck
npm run smoke
npm run smoke:gateway
npm pack --dry-run
```

测试默认从配置的资源镜像取得元数据，缓存于系统临时目录；离线开发时可指定独立的资源源目录：

```bash
export PHI_RESOURCE_SOURCE_DIR=/path/to/phi-plugin-openclaw-resources/song-data
```

此开发变量只供资源构建和测试使用，Gateway 不读取它作为数据来源。
`npm test` 覆盖成绩、主题、渲染生命周期、SQLite、命令路由和身份隔离。
测试串行运行，避免资源目录测试相互影响。
`npm run smoke` 在源码仓库中生成临时资源仓库，启动本地 HTTP 服务并由插件真实下载元数据，
随后用模拟游戏成绩经插件消息接口执行真实 B30 计算与 Chrome 图片渲染，验证曲绘按需下载、哈希校验和缓存复用；
不使用真实账号，不给 QQ 发送消息，不调用大模型。成功后打印输出图片位置，可人工检查图片。
`npm run smoke:gateway` 需要本机安装 OpenClaw（或设置 `OPENCLAW_PACKAGE_ROOT` 指向其 npm 包目录）。
它在独立临时状态目录中执行宿主的真实启动规划、插件加载和 QQ 使用的 buffered dispatcher，验证 `/phi`、
`/b30`、群聊绑定限制和管理员限制都不会落到模型，并验证普通聊天继续处理。
发送过程被捕获，模型解析器使用桩函数；不会读取实际账号数据或向 QQ 发消息。
传入安装目录可检查实际安装的代码：`npm run smoke:gateway -- /path/to/openclaw/extensions/phi-plugin-openclaw`。
OpenClaw 本机加载验证可使用独立 profile：

```bash
openclaw --profile phi-plugin-openclaw-test plugins install --link . --force --accept-capabilities
openclaw --profile phi-plugin-openclaw-test plugins inspect phi-plugin-openclaw --runtime --json
```

真实账号的 TapTap 授权和腾讯 QQ 投递需要由使用者在连接好的 channel 上完成一次绑定与查询。
仓库不附带账号凭据。

目录说明：`openclaw.mjs` 是轻量注册入口；`src/` 是 OpenClaw 路由、事件、SQLite、运行时与渲染接入；
`apps/` 是业务功能；`model/`、`lib/` 是存档/成绩/主题逻辑；`resources/` 是图片模板和字体。
曲目元数据和曲绘由独立资源仓库维护。用 `resources:build --info <外部目录>` 构建元数据，
用 `resources:illustrations --input <曲绘目录> --output <发布目录>` 独立构建共享曲绘，无需更改游戏版本。
Gateway 读取经下载器安装的资源缓存。资源仓库的构建和完整性校验方法见 [部署规范](docs/RESOURCE_REPOSITORY.md)。

## 许可证与原作者

基于 Catrong/phi-plugin，按 **GPL-3.0-only** 发布；保留 [LICENSE](LICENSE)、[来源与修改声明](NOTICE.md) 及第三方许可，公开分发时须提供完整对应源代码。游戏素材授权另计。
感谢原作者与贡献者；云存档代码来源于 [7aGiven/PhigrosLibrary](https://github.com/7aGiven/PhigrosLibrary)。

原仓库：https://github.com/Catrong/phi-plugin

曲绘来源：[Catrong/phi-plugin-ill](https://github.com/Catrong/phi-plugin-ill)。曲绘及游戏素材归各自权利人所有，代码许可证不扩大素材授权。
