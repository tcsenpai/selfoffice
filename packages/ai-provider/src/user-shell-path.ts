import { execFile } from 'node:child_process'

/**
 * A Finder/Dock-launched Electron app inherits a minimal PATH, so tools that
 * live behind version managers (mise, asdf, nvm, volta ...) are not found.
 * The login shell's PATH is what a terminal would see, so ask it once.
 *
 * Unix only; on Windows the app PATH already carries the user's PATH.
 */
const START = '__SELFOFFICE_PATH__'
const TIMEOUT_MS = 5_000

let cached: Promise<string | undefined> | undefined
let failedAt = 0
/** a failed lookup (slow rc file, odd shell) is retried after this long, not kept for the whole session */
const RETRY_AFTER_MS = 60_000

/** `shell` is a parameter for tests; callers use the default. */
export function userShellPath(
  shell = process.env.SHELL || '/bin/zsh',
): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  if (cached && !(failedAt && Date.now() - failedAt > RETRY_AFTER_MS)) return cached
  failedAt = 0
  const lookup = new Promise<string | undefined>((resolve) => {
    // markers drop whatever the rc files print; "$PATH" is colon-joined in zsh, bash and fish.
    // The marker stays a separate word: glued to $PATH its underscores would extend the variable name.
    const child = execFile(
      shell,
      ['-ilc', `printf '%s' '${START}' "$PATH" '${START}'`],
      { timeout: TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => {
        const match = error ? null : new RegExp(`${START}(.*?)${START}`, 's').exec(stdout)
        resolve(match?.[1] || undefined)
      },
    )
    // an rc file that waits for input must see end-of-file, not hang the first AI call
    child.stdin?.end()
  })
  cached = lookup
  void lookup.then((path) => {
    if (!path && cached === lookup) failedAt = Date.now()
  })
  return lookup
}

/** test hook */
export function resetUserShellPathCache(): void {
  cached = undefined
  failedAt = 0
}
