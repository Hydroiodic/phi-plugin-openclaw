# 来源与修改声明

本项目是 [Catrong/phi-plugin](https://github.com/Catrong/phi-plugin) 的派生作品。
原作者：Catrong 及原项目贡献者。保留原有源码中的作者、来源及第三方许可声明。
原始版本及原说明见本仓库保留的 Git 历史。

2026-09-20：制作 OpenClaw 专用版本 `phi-plugin-openclaw`；移除 Yunzai、Koishi、Guoba 入口与适配，
新建 OpenClaw 命令和回复接口、SQLite 存储、独立数据目录、安装脚本与测试；保留并修改 Phigros 业务代码。
本派生项目维护者：Hydroiodic；项目地址：https://github.com/Hydroiodic/phi-plugin-openclaw 。
曲目元数据迁移到独立静态资源发布输入目录，新增可自建镜像的版本化 ZIP 分发、完整性校验和缓存下载器。

仓库根目录原有 `LICENSE` 为 GNU General Public License version 3，保持原文不变。
原 `package.json` 的 ISC 字段与该文件冲突，本派生版本明确按 **GPL-3.0-only** 发布。
公开分发本项目时，须同时保留此声明、LICENSE、原作者和来源信息，并提供此版本的完整对应源代码及构建/安装材料。
本项目不提供担保。若原作者对特定资源另外授权，以对应资源的权利声明为准。

云存档相关代码改写自 [7aGiven/PhigrosLibrary](https://github.com/7aGiven/PhigrosLibrary)。
`resources/LICENSE` 中的 Apache-2.0 许可证原文也一并保留和打包。

Phigros、游戏曲绘、音乐、头像、字体和第三方前端库属于其各自权利人；代码 GPL 许可不等于获得这些素材的独立授权。
本项目未扩大上游素材的授权范围；发布时应保留素材已有的许可证，并按各自授权分发。
曲目元数据和完整曲绘库均不打入 npm 包，按独立资源版本下载；资源发布包继续附带原许可证和本修改声明。
