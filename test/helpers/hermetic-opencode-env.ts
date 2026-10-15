import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  getHostCacheDirOverride,
  HOST_PATH_BRIDGE,
  setHostCacheDirOverride,
} from "../../src/context/paths.js"

export type HermeticOpencodeDirs = {
  home: string
  cache: string
}

export type SavedProcessEnv = {
  home?: string
  userProfile?: string
  xdgCache?: string
  bridge: unknown
  cacheOverride: string | undefined
}

/** Capture process env before {@link installHermeticOpencodeEnv} (for describe-level hooks). */
export function snapshotProcessEnv(): SavedProcessEnv {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    xdgCache: process.env.XDG_CACHE_HOME,
    bridge: (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE],
    cacheOverride: getHostCacheDirOverride(),
  }
}

function restoreProcessEnv(saved: SavedProcessEnv): void {
  setHostCacheDirOverride(saved.cacheOverride)
  if (saved.home === undefined) delete process.env.HOME
  else process.env.HOME = saved.home
  if (saved.userProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = saved.userProfile
  if (saved.xdgCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = saved.xdgCache
  const globalRef = globalThis as Record<PropertyKey, unknown>
  if (saved.bridge === undefined) delete globalRef[HOST_PATH_BRIDGE]
  else globalRef[HOST_PATH_BRIDGE] = saved.bridge
}

/**
 * Isolate OpenCode discovery from the developer machine.
 *
 * `collectAgents` and `loadMergedConfig` read `$HOME/.config/opencode`; repointing
 * only `XDG_CACHE_HOME` is not enough. Matches the sandbox used in
 * `frozen-request-context.test.ts`.
 */
export async function installHermeticOpencodeEnv(label: string): Promise<HermeticOpencodeDirs> {
  const stamp = `${process.pid}-${Date.now()}`
  const home = path.join(os.tmpdir(), `cursor-hermetic-home-${label}-${stamp}`)
  const cache = path.join(os.tmpdir(), `cursor-hermetic-cache-${label}-${stamp}`)
  await mkdir(path.join(home, ".config", "opencode"), { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CACHE_HOME = cache
  delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  setHostCacheDirOverride(cache)
  return { home, cache }
}

export async function restoreHermeticOpencodeEnv(
  saved: SavedProcessEnv,
  dirs?: HermeticOpencodeDirs,
): Promise<void> {
  restoreProcessEnv(saved)
  if (!dirs) return
  await rm(dirs.cache, { recursive: true, force: true })
  await rm(dirs.home, { recursive: true, force: true })
}

export async function withHermeticOpencodeEnv<T>(
  label: string,
  run: (dirs: HermeticOpencodeDirs) => Promise<T>,
): Promise<T> {
  const saved = snapshotProcessEnv()
  const dirs = await installHermeticOpencodeEnv(label)
  try {
    return await run(dirs)
  } finally {
    await restoreHermeticOpencodeEnv(saved, dirs)
  }
}
