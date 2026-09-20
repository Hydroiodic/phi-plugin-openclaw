import path from 'path'
import { fileURLToPath } from 'url'
import { getPlatformAdapter } from '../../components/platform/state.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**宿主进程根目录 */
export const _path = process.cwd()

/**插件根目录 */
export const pluginRoot = path.resolve(__dirname, '..', '..')
/** OpenClaw persistent state, separate from the installed source. */
export const stateRoot = getPlatformAdapter()?.dataRoot || pluginRoot
/**插件名 */
export const pluginName = path.basename(pluginRoot)
/**插件临时文件目录 */
export const tempPath = path.join(stateRoot, 'temp')
/**插件资源目录 */
export const pluginResources = path.join(pluginRoot, 'resources')


/**曲绘资源、曲目信息路径 */
export const infoPath = getPlatformAdapter()?.resourceInfoPath || process.env.PHI_TEST_INFO_PATH || path.join(stateRoot, 'resource-cache', 'uninitialized')

/**额外曲目名称信息（开字母用） */
export const DlcInfoPath = path.join(infoPath, 'DLC')

/**上个版本曲目信息 */
export const oldInfoPath = path.join(infoPath, 'oldInfo')

/**数据路径 */
export const dataPath = path.join(stateRoot, 'data')


/**用户娱乐数据路径 */
export const pluginDataPath = path.join(dataPath, 'pluginData')

/**用户存档数据路径 */
export const savePath = path.join(dataPath, 'saveData')

/**API用户存档数据路径 */
export const apiSavePath = path.join(dataPath, 'apiSaveData')

/**其他插件数据路径 */
export const otherDataPath = path.join(dataPath, 'otherData')

/**用户设置路径 */
export const configPath = stateRoot === pluginRoot ? path.join(pluginRoot, 'config', 'config') : path.join(stateRoot, 'config')

/**默认设置路径 */
export const defaultPath = path.join(pluginRoot, 'config', 'default_config')

/**默认图片路径 */
export const imgPath = path.join(pluginResources, 'html', 'otherimg')

/**用户图片路径 */
export const ortherIllPath = stateRoot === pluginRoot ? path.join(pluginResources, 'otherill') : path.join(stateRoot, 'otherill')

/**音频资源 */
export const guessMicPath = path.join(stateRoot, 'splited_music')

/**备份路径 */
export const backupPath = path.join(stateRoot, 'backup')
