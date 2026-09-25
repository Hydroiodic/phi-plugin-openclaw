---
name: phigros-save
description: Use when a user asks to view, check, edit or upload their own Phigros cloud save (scores, Data, avatar, intro, settings) through the phigros_save_* tools.
user-invocable: false
---

# Phigros 云存档

用 `phigros_save_*` 工具帮用户查看和修改**他自己**的 Phigros 云存档。工具只认当前对话者本人绑定的账号，没有“指定其他用户”的参数；不要尝试替别人读取或修改存档。

## 什么时候用

- 用户想看自己存档里的内容：成绩、Data、课题等级、头像、简介、游戏设置。
- 用户想改这些内容并同步回游戏，例如改简介、换头像或背景、调整设置、修正某条成绩。

只是查 B30、推分建议等，用插件已有的 `/b30`、`/suggest` 等命令即可，不需要这些工具。

## 流程

1. **读取**：调用 `phigros_save_fetch`，把概览告诉用户。它会丢弃尚未上传的修改。
2. **查看**：用 `phigros_save_read` 按需查看分区：`profile`、`settings`、`progress`、`records`（可用 `song`、`level` 筛选，结果按单曲 RKS 排序并分页）、`changes`。
3. **修改**：用 `phigros_save_edit` 只写要改的字段。修改只在插件本地生效，工具会返回当前所有未上传的改动。
4. **上传**：用户明确要求上传时，调用 `phigros_save_upload`。插件会把修改清单和 6 位确认码直接发给用户。
5. **确认**：告诉用户核对清单后自己发送 `/phi 确认上传 <确认码>`，不想上传就发送 `/phi 取消上传`。**你不能也不要尝试替用户发送确认命令**；确认码 10 分钟内有效。

## 规则

- 只在私聊中使用。工具提示“只能在私聊中使用”时，请用户私聊机器人；如果已经是私聊，把提示原样转告，让机器人管理员调整 `session.dmScope`。
- 用户没有绑定账号时，请他私聊发送 `/bind qrcode` 扫码绑定。
- 改动前先说清要改什么，得到用户同意再调用 `phigros_save_edit`；上传前再次确认用户确实要覆盖云存档。
- 成绩必须合理：分数 0~1000000，acc 0~100；只有 acc 为 100 时分数才能是 1000000；Full Combo 的分数约等于 9000 × acc + 100000。工具会拒绝不可能的组合，照实转告用户即可。
- Data 用 `money` 表示，是 `[KB, MB, GB, TB, PB]` 五个整数，前四项不超过 1023。
- 课题等级 `challengeModeRank` = 颜色 × 100 + 等级，颜色 1~5 依次为绿、蓝、红、金、彩。
- 工具报错时直接把错误说明告诉用户，不要编造结果。云端在读取后有更新时上传会被拒绝，这时重新读取即可。
- 上传成功后提醒用户在游戏内从云端同步存档，并可发送 `/phi update` 更新查分数据。

## 示例

用户：“把我的简介改成‘今天也要 AP’，然后传上去。”

1. `phigros_save_fetch`
2. `phigros_save_edit`，参数 `{"profile": {"selfIntro": "今天也要 AP"}}`
3. 向用户确认改动后调用 `phigros_save_upload`
4. 回复：“修改清单和确认码已经发给你了，核对无误后发送 /phi 确认上传 加上确认码 即可。”
