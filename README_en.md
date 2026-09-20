# phi-plugin-openclaw

Phigros score lookup for OpenClaw by Hydroiodic. Supports CN and global account binding, B30 images,
song queries, score recommendations, themes, and games. Uses built-in SQLite; no database service is required.

See the maintained [Chinese installation and usage guide](README.md) and [static resource repository specification](docs/RESOURCE_REPOSITORY.md).
From this checkout, install with:

```bash
npm install --omit=dev --ignore-scripts && node scripts/install-openclaw.mjs --force --accept-capabilities && openclaw gateway restart
```

Song metadata is downloaded automatically from `https://hydroiodic.site/phi-plugin-openclaw/resources/v1/`
and cached locally. To use your own mirror, set `resourceBaseUrl` or `PHI_RESOURCE_BASE_URL` in the Gateway environment.
Artwork uses the same mirror's shared `illustrations/` catalog, independently of game-data versions.
Images are downloaded on demand, verified by SHA-256, and cached by content hash for reuse across versions.
Set `downloadIllustrations: true` or use the administrator command `/phi downill` to refresh and download the full artwork library.
Build artwork independently with `npm run resources:illustrations -- --input /path/to/illustrations --output /path/to/public`.
Privately send `/bind qrcode` (CN) or `/gbbind qrcode` (global), then `/b30`; in a QQ group, mention the bot and send `/b30`.
Use `/phi` for text help or `/phi help` for image help.

Regular lookup commands do not require OpenClaw control-command authorization. Plugin administration remains protected by the
plugin's own `admins` list. Score commands do not call a language model.
If a model answers that `/phi` is unknown, check the plugin configuration and restart the Gateway, then check its startup log for
`Phigros ready: commands and reply_dispatch registered.`; CLI runtime inspection alone does not prove Gateway loading.
`npm run smoke:gateway` tests the host startup planner and buffered message dispatcher with isolated state and captured delivery.

Project: https://github.com/Hydroiodic/phi-plugin-openclaw

See the [complete command inventory](docs/COMMANDS.md) for commands, aliases, and permissions.

Based on Catrong/phi-plugin, licensed under GPL-3.0-only; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

Original repository: https://github.com/Catrong/phi-plugin

Artwork source: [Catrong/phi-plugin-ill](https://github.com/Catrong/phi-plugin-ill). Game artwork belongs to its respective rights holders; the code license does not grant additional artwork rights.
