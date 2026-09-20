// Development/test input is external too; it never becomes a runtime fallback.
import path from 'node:path'
import os from 'node:os'
import { ensureResources, validateInfoDirectory } from '../src/resources.mjs'

export async function resolveTestInfo() {
  const source = process.env.PHI_RESOURCE_SOURCE_DIR
  if (source) { const info = path.resolve(source); await validateInfoDirectory(info); return info }
  const resources = await ensureResources({ dataRoot: path.join(os.tmpdir(), 'phi-plugin-openclaw-development') })
  return resources.infoPath
}
