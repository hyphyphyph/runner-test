// A Web Storage shaped object that keeps values in memory.
//
// The page uses it only when the browser refuses localStorage, so the person
// can still see the workspace and is told that it will not survive the tab.
// The unit tests use it as a stand-in for the browser.

import type { KeyValueStorage } from './types.ts'

export class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
}
