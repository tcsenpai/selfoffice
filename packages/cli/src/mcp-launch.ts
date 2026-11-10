/**
 * How an MCP client starts `selfoffice mcp`. Shared by the app's Settings snippet
 * and `selfoffice mcp install` so the two cannot drift. Clients spawn without a
 * shell, so on Windows neither selfoffice.cmd nor `cmd /c` is safe (a path with
 * a space splits); the entry does what selfoffice.cmd does instead: the app
 * binary as Node on the bundled CLI. Pure string code: the renderer imports it.
 */
export interface McpLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * Compact tool schemas are requested through the child's environment, which every
 * agent config shape carries (`mcp install --compact-schemas` writes it), so an
 * entry that asks for them is still the same launcher, just with one option.
 */
export const COMPACT_SCHEMAS_ENV = 'SELFOFFICE_MCP_COMPACT_SCHEMAS'

/** The same launch with compact MCP tool schemas turned on. */
export function withCompactSchemas(launch: McpLaunch): McpLaunch {
  return { ...launch, env: { ...launch.env, [COMPACT_SCHEMAS_ENV]: '1' } }
}

const isWindowsPath = (p: string) => p.includes('\\')

/** The app's snippet: the bare name once selfoffice is on the PATH, else the launcher itself. */
export function mcpLaunch(
  cli: {
    status: string
    launcherDir: string
    pathHint?: string
  },
  opts: { compactSchemas?: boolean } = {},
): McpLaunch {
  const dir = cli.launcherDir
  if (isWindowsPath(dir)) return compact(windowsAppLaunch(dir), opts)
  const onPath = cli.status === 'present' && !cli.pathHint
  return compact({ command: onPath ? 'selfoffice' : `${dir}/selfoffice`, args: ['mcp'] }, opts)
}

function compact(launch: McpLaunch, opts: { compactSchemas?: boolean }): McpLaunch {
  return opts.compactSchemas ? withCompactSchemas(launch) : launch
}

function windowsAppLaunch(dir: string): McpLaunch {
  return {
    command: `${dir}\\..\\..\\SelfOffice.exe`,
    args: [`${dir}\\selfoffice.cjs`, 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

export interface LauncherLaunchOptions {
  platform?: string
  /** test seam for the packaged-app probe */
  exists?: (path: string) => boolean
  /** `mcp install --compact-schemas`: add the env toggle to the entry */
  compactSchemas?: boolean
}

/**
 * `mcp install`: always the absolute launcher, never the bare name. On Windows
 * the packaged app is run as Node (same entry as the app's snippet); a checkout
 * has no SelfOffice.exe beside it and runs the bundle on the system node, as the
 * bin/selfoffice script does.
 */
export function mcpLaunchFromLauncher(
  launcher: string,
  opts: LauncherLaunchOptions = {},
): McpLaunch {
  const win = isWindowsPath(launcher) || opts.platform === 'win32'
  if (!win) return compact({ command: launcher, args: ['mcp'] }, opts)
  const sep = isWindowsPath(launcher) ? '\\' : '/'
  const dir = launcher.slice(0, Math.max(launcher.lastIndexOf('\\'), launcher.lastIndexOf('/')))
  const exists = opts.exists ?? (() => false)
  if (exists(`${dir}${sep}..${sep}..${sep}SelfOffice.exe`))
    return compact(windowsAppLaunch(dir), opts)
  const bundle = exists(`${dir}${sep}selfoffice.cjs`)
    ? `${dir}${sep}selfoffice.cjs`
    : `${dir}${sep}..${sep}dist${sep}selfoffice.cjs`
  return compact({ command: 'node', args: [bundle, 'mcp'] }, opts)
}
