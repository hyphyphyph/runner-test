// The version reported by the API, read once from package.json.

import { readFileSync } from 'node:fs'

let version = '0.0.0'
try {
  const packageText = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  const parsed: unknown = JSON.parse(packageText)
  if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') {
    version = (parsed as { version: string }).version
  }
} catch {
  // Keep the fallback when package.json cannot be read.
}

export const VERSION = version
