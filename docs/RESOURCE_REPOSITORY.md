# 静态资源仓库规范 v1

维护者：Hydroiodic。默认根地址：`https://hydroiodic.site/phi-plugin-openclaw/resources/v1/`。
服务器只需静态 HTTPS 文件服务，不需要数据库或动态 API。

## 两类资源

曲目元数据按 Phigros 游戏版本管理，例如 `3.20.0`；插件版本独立使用 `0.1.0`。
曲绘是所有游戏版本共用的资源库，**不放在游戏版本目录内，也没有单独的发行版本号**。
清单不记录创建、上传或发布日期。

JSON 描述索引，ZIP 传输整包，图片对象用于按需下载。所有路径均为相对路径，复制到任意镜像根地址即可使用。

```text
public/
├── index.json                       全部曲目数据版本，按版本降序
├── index.tab                        TAB 分隔的版本列表
├── latest.json                      最新曲目数据清单的指针
├── v/
│   └── 3.20.0/
│       ├── metadata.json
│       ├── SHA256SUMS
│       └── song-data-001.zip
└── illustrations/                   跨版本共享曲绘
    ├── index.json                   曲目路径 → 对象路径、大小、SHA-256
    ├── SHA256SUMS                   曲绘索引及 ZIP 的 SHA-256
    ├── objects/
    │   └── ab/<64位SHA-256>.png      按内容命名的图片
    └── packages/
        └── <64位SHA-256>.zip         完整下载用的独立分包
```

同一张图被不同曲目或游戏版本使用时，指向同一个哈希对象。
图片发生变化时产生新对象，未变的图片继续使用原对象。发布器保留已有对象，避免影响正在下载或使用旧索引的客户端。
图片对象和 ZIP 的路径不变则内容不得改变；曲绘索引可以更新。

## 曲目版本索引与 latest

版本列表的使用方式类似 Node.js 的 dist 列表：可列出版本、选择版本、指定镜像。
`latest.json` 指向一个确定的 `metadata.json`，不是 ZIP、目录重定向或 Git 分支。
`latest` **只描述曲目数据版本**，不控制曲绘。

下面的哈希和大小是字段示意，实际值由构建脚本生成：

```json
{
  "schemaVersion": 1,
  "version": "3.20.0",
  "manifest": "v/3.20.0/metadata.json",
  "sha256": "<metadata.json 原始字节的 SHA-256>",
  "game": { "version": "3.20.0", "code": 154 },
  "packages": ["song-data"]
}
```

`index.json` 为 `{ "schemaVersion": 1, "releases": [上述对象, ...] }`。
`latest.json` 与版本号最大的第一项相同。`index.tab` 的列是 `version、phigros、code、packages`，以 TAB 分隔。
版本按数值排序；例如 `3.20.0` 高于 `3.9.0`。版本目录发布后保持不变，新增游戏版本写入新的目录。

```bash
curl -fsS https://hydroiodic.site/phi-plugin-openclaw/resources/v1/index.tab
npm run resources -- list
```

### metadata.json

```json
{
  "schemaVersion": 1,
  "dataFormat": "phi-info-v1",
  "version": "3.20.0",
  "minPluginVersion": "0.1.0",
  "game": { "version": "3.20.0", "code": 154 },
  "packages": {
    "song-data": {
      "archives": [{
        "path": "v/3.20.0/song-data-001.zip",
        "sha256": "<ZIP 原始字节的 SHA-256>",
        "bytes": 123456,
        "unpackedBytes": 765432,
        "fileCount": 42
      }]
    }
  }
}
```

`bytes` 为下载大小，`unpackedBytes` 为普通文件内容大小之和，`fileCount` 不计目录。
`minPluginVersion` 是所需的最低插件版本。`game` 用于游戏版本展示和存档版本判断。

ZIP 根目录直接包含 `info.csv`、`infolist.json`、`notesInfo.json`、`oldNotesInfo.json`、
`spinfo.json`、`nicklist.yaml`、`chaplist.yaml`、`avatar.txt`、`tips.txt`、`notice.json`、
`jrrp.json`、`sentences.json`、`help.json`、`help/api.json`、`DLC/`、`oldInfo/` 等数据。
不要套额外的 `song-data/` 外层目录；历史数据也是业务功能所需的数据。

## 共享曲绘索引

`illustrations/index.json` 的格式如下。所有 `path` 均相对于 `illustrations/`：

```json
{
  "schemaVersion": 1,
  "files": {
    "ill/Glaciaxion.SunsetRay.png": {
      "path": "objects/ab/<SHA-256>.png",
      "bytes": 123456,
      "sha256": "<图片原始字节的 SHA-256>"
    }
  },
  "archives": [{
    "path": "packages/<ZIP的SHA-256>.zip",
    "sha256": "<ZIP 原始字节的 SHA-256>",
    "bytes": 123456,
    "unpackedBytes": 120000,
    "fileCount": 1
  }]
}
```

对象目录名是哈希前两位，文件名是完整的 64 位小写哈希加图片扩展名。
`files` 的 key 是逻辑路径，插件使用它查询曲绘，不用显示曲名猜文件名：

```text
ill/<曲目ID去掉结尾.0>.png
illBlur/<同ID>.png
illLow/<同ID>.png
SP/<同ID>.png
chartimg/<难度>/<ID>.png
table/<定数>.png
chap/<章节名>.png
```

支持 PNG、JPEG 和 WebP 文件；业务调用的逻辑路径须与索引 key 一致。
曲绘 ZIP 内使用上述逻辑路径，不额外套 `illustrations/`。
分包是可单独解压的 ZIP，不是二进制切片；跨分包不能重名。
`SHA256SUMS` 每行采用 `<哈希><两个空格><相对文件名>`，包含 `index.json` 和所有 `packages/*.zip`。
单图的大小和哈希记录在索引中。

默认按需获取索引、下载所需图片，校验后才交给渲染器或消息 channel。
同一进程并发请求相同对象只下载一次，图片传输最多六路并发。
完整下载使用 ZIP，但安装后也是相同的哈希对象缓存，因此两种下载方式可直接复用。
缺图或哈希不符时显示内置占位图并记录警告。

## 构建

独立维护资源输入目录，不把曲目元数据和曲绘放进插件安装包：

```text
phi-plugin-openclaw-resources/
├── song-data/            元数据输入
├── illustrations/        曲绘输入，内含 ill/、SP/ 等分类
├── public/               上传内容
└── verify.mjs            无 npm 依赖的完整性校验器
```

在插件源码目录安装依赖，然后构建首个资源版本及共享曲绘：

```bash
npm install --ignore-scripts
npm run resources:build -- --version 3.20.0 --game-code 154 --info ../phi-plugin-openclaw-resources/song-data --illustrations ../phi-plugin-openclaw-resources/illustrations --output ../phi-plugin-openclaw-resources/public
```

`--game-version` 可省略；脚本由资源版本推导。`--info` 也可通过 `PHI_RESOURCE_SOURCE_DIR` 指定。
已有元数据版本不重复构建；**添加或更换曲绘只运行独立命令，不更改游戏版本**：

```bash
npm run resources:illustrations -- --input ../phi-plugin-openclaw-resources/illustrations --output ../phi-plugin-openclaw-resources/public
```

发布器生成可复现 ZIP、索引、大小和校验和。按约 32 MiB 未压缩内容分包，单图片上限 32 MiB。
输出目录不能位于输入目录内。源目录应只包含要分发的数据，不能含用户存档、凭据、缓存、脚本或符号链接。
隐藏文件不参与构建；维护时请保持源目录整洁。
元数据分包附带必要的分发说明文件。图片及其他素材的权利说明见 [README](../README.md#许可证与原作者)。

### 完整性校验

在独立资源目录运行：

```bash
node verify.mjs
node verify.mjs https://hydroiodic.site/phi-plugin-openclaw/resources/v1/
```

在插件目录也可运行同一个校验器：

```bash
npm run resources:verify -- ../phi-plugin-openclaw-resources/public
```

校验器只依赖 Node.js 22.16+ 内置模块，维护源文件为 `scripts/verify-resources.mjs`，可复制为独立的 `verify.mjs`。
它检查全部版本、索引关系、清单和 ZIP 的 SHA-256、ZIP CRC32、解压大小、文件数量、路径安全、
JSON 语法、必需数据，以及共享曲绘的每个对象和每个分包，并核对图片格式标识。
本地发布目录旁有 `song-data/`、`illustrations/` 时，还会逐文件比较源文件与发布内容，
可发现手动修改输入后忘记构建的问题。校验和不能判断定数填写是否正确或图片内容是否符合预期。

任何内容错误返回非零退出码。HTTP 头配置默认只警告，`--strict-http` 可将其视为失败。
远端完整校验会下载全部 ZIP 和独立图片对象，流量约为完整曲绘库的两倍。

## 上传与 HTTP 配置

只上传 `public/` **内的内容**，保持相对目录结构；输入文件、源码快照及本地备份不用上传。

1. 上传 `v/<版本>/` 文件，以及共享曲绘的 `objects/` 和 `packages/` 新文件。
2. 更新 `illustrations/index.json`，再更新它的 `SHA256SUMS`；建议暂存后原子切换整个静态站点。
3. 更新根目录 `index.json`、`index.tab`，最后更新 `latest.json`。
4. 刷新可变索引的 CDN 缓存，运行远端完整性校验。

只更新曲绘时执行相应曲绘步骤即可，不用修改 `v/`、`latest.json` 或插件版本。
切换过程中若索引与校验和暂不匹配，客户端会拒绝该索引并保留已有缓存。
使用服务器临时文件和同文件系统 rename，避免客户端下载到半个 JSON。
构建脚本只生成本地文件，不自动上传或更改服务器。

| 文件 | Content-Type | Cache-Control |
| --- | --- | --- |
| 根目录 index.json、latest.json；illustrations/index.json | application/json; charset=utf-8 | public, max-age=60, must-revalidate |
| index.tab；illustrations/SHA256SUMS | text/plain; charset=utf-8 | public, max-age=60, must-revalidate |
| v/版本/metadata.json | application/json; charset=utf-8 | public, max-age=31536000, immutable |
| v/版本/*.zip；illustrations/packages/*.zip | application/zip | public, max-age=31536000, immutable |
| v/版本/SHA256SUMS | text/plain; charset=utf-8 | public, max-age=31536000, immutable |
| illustrations/objects/ 下的图片 | image/png、image/jpeg 或 image/webp | public, max-age=31536000, immutable |

服务器直接返回文件，不重定向到登录页、下载页或其他域名。镜像配置应使用最终地址。
建议 ZIP 不额外 gzip/br 压缩，正确返回 Content-Length。
不要改写 JSON 空白、编码或图片内容，任何字节变化都会改变哈希。
Node.js 下载不需要 CORS；若另建浏览器查询页面，可按需开放 GET 跨域。

## 客户端配置、缓存与更新

运行时优先级：`PHI_RESOURCE_BASE_URL` > `resourceBaseUrl` > 默认根地址；
`PHI_RESOURCE_VERSION` > `resourceVersion` > `latest`。
CLI 的显式 `--base-url`、`--version` 优先于环境变量。元数据和曲绘使用同一个镜像根地址。

```text
<dataDir>/resource-cache/<镜像地址哈希>/
├── current.json
├── v/<游戏版本>/song-data/
└── illustrations/
    ├── index.json
    └── objects/<哈希前两位>/<哈希>.png
```

镜像之间隔离缓存；同一镜像下，游戏版本之间共享曲绘。
已验证缓存可离线读取。首次解析 latest 后使用本地曲目数据；显式更新后重启 Gateway：

```bash
npm run resources -- install --base-url https://hydroiodic.site/phi-plugin-openclaw/resources/v1/ --data-dir /path/to/data --illustrations
openclaw gateway restart
```

CLI 不读取 openclaw.json，请提供与 Gateway 一致的数据目录和镜像；锁定版本时同时更新配置。
曲绘可单独用管理员命令 `/phi downill` 刷新索引、校验并补齐完整缓存，无需切换曲目版本。
遇到缓存索引中没有的新曲目，进程会尝试刷新一次共享索引；其他已缓存图片继续复用。
曲目版本缓存通过临时解压和完成标记安装，失败保留原有数据。曲绘发布前会核对整包与逐文件索引，失败不发布损坏对象。

客户端限制单 ZIP 128 MiB、解压 512 MiB、单文件 32 MiB、每 ZIP 10000 文件、最多 256 个分包，
并拒绝不安全路径、符号链接、重复文件和不允许的文件类型。
SHA-256 保证内容与清单一致，**不是独立签名**；只使用可信 HTTPS 镜像。
本机调试可使用 localhost、127.0.0.1 或 [::1] 的 HTTP 地址，地址不得包含凭据、查询参数或片段。

项目：https://github.com/Hydroiodic/phi-plugin-openclaw
