import { PhigrosPlugin, PLUGIN_ID } from './src/plugin.mjs'

export default {
  id: PLUGIN_ID,
  name: 'Phigros',
  description: 'Phigros 成绩查询、绑定、曲目信息与娱乐；本地 SQLite，无需 Redis。',
  register(api) {
    if (api.registrationMode !== 'cli-metadata') new PhigrosPlugin(api).register()
  },
}
