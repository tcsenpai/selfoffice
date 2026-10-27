import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatClaudeCli, claudeCliArgs } from '../src/claude-cli'
import { resetUserShellPathCache, userShellPath } from '../src/user-shell-path'

// the fake CLIs are POSIX scripts
const posix = it.skipIf(process.platform === 'win32')

let dir: string
const savedShell = process.env.SHELL

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-cli-test-'))
  resetUserShellPathCache()
  // a quick stand-in for the login shell: the real one runs the developer's rc files
  if (process.platform !== 'win32')
    process.env.SHELL = script(
      'quickshell',
      `printf '__SELFOFFICE_PATH__/usr/bin:/bin__SELFOFFICE_PATH__'`,
    )
})
afterEach(() => {
  process.env.SHELL = savedShell
  rmSync(dir, { recursive: true, force: true })
  resetUserShellPathCache()
})

function script(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const config = (cliPath?: string) => ({ apiKey: '', model: 'sonnet', cliPath })
const reply = (text: string) =>
  `cat >/dev/null; printf '%s' '{"structured_output":{"text":"${text}","toolCalls":[]},"usage":{"input_tokens":3,"output_tokens":2}}'`

describe('claudeCliArgs', () => {
  it('isolates the CLI and never uses --bare (bare ignores the OAuth login)', () => {
    const args = claudeCliArgs('', { type: 'object' })
    expect(args).not.toContain('--bare')
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'sonnet',
    ])
    expect(args).toEqual(
      expect.arrayContaining(['--tools', '--strict-mcp-config', '--setting-sources']),
    )
  })
})

describe('chatClaudeCli', () => {
  posix('returns the structured answer of the CLI', async () => {
    const cli = script('claude', reply('hello'))
    const res = await chatClaudeCli(config(cli), 'sys', 'hi', new AbortController().signal)
    expect(res).toEqual({ ok: true, content: 'hello' })
  })

  posix('surfaces an error reported by the CLI', async () => {
    const cli = script(
      'claude',
      `cat >/dev/null; printf '%s' '{"is_error":true,"result":"Not logged in"}'`,
    )
    await expect(
      chatClaudeCli(config(cli), 'sys', 'hi', new AbortController().signal),
    ).rejects.toThrow(/Not logged in/)
  })

  posix('says so when the CLI does not exist', async () => {
    await expect(
      chatClaudeCli(config(join(dir, 'missing')), 'sys', 'hi', new AbortController().signal),
    ).rejects.toThrow(/Claude CLI not found/)
  })

  posix('stops the CLI when the request is cancelled', async () => {
    const cli = script('claude', 'cat >/dev/null; sleep 30')
    const ctl = new AbortController()
    const run = chatClaudeCli(config(cli), 'sys', 'hi', ctl.signal)
    setTimeout(() => ctl.abort(), 300)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })

  posix(
    'finds `claude` on the login-shell PATH when the app PATH lacks it (mise, nvm ...)',
    async () => {
      script('claude', reply('from shell path'))
      process.env.SHELL = script(
        'fakeshell',
        `printf '__SELFOFFICE_PATH__${dir}:/usr/bin__SELFOFFICE_PATH__'`,
      )
      const res = await chatClaudeCli(config(), 'sys', 'hi', new AbortController().signal)
      expect(res).toEqual({ ok: true, content: 'from shell path' })
    },
  )
})

describe('userShellPath', () => {
  posix('ignores noise printed by the rc files', async () => {
    const shell = script(
      'noisy',
      `echo welcome; printf '__SELFOFFICE_PATH__/a:/b__SELFOFFICE_PATH__'; echo bye`,
    )
    expect(await userShellPath(shell)).toBe('/a:/b')
  })

  posix('reads the PATH of a real shell', async () => {
    expect(await userShellPath('/bin/sh')).toMatch(/\/bin/)
  })

  posix(
    'retries a failed lookup after a minute instead of keeping it for the session',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        expect(await userShellPath(script('broken2', 'exit 1'))).toBeUndefined()
        const good = script('good', `printf '__SELFOFFICE_PATH__/ok/bin__SELFOFFICE_PATH__'`)
        expect(await userShellPath(good)).toBeUndefined() // still within the minute
        vi.setSystemTime(Date.now() + 61_000)
        expect(await userShellPath(good)).toBe('/ok/bin')
      } finally {
        vi.useRealTimers()
      }
    },
  )

  posix('does not hang on an rc file that reads stdin', async () => {
    const shell = script('reader', `read line; printf '__SELFOFFICE_PATH__/r__SELFOFFICE_PATH__'`)
    expect(await userShellPath(shell)).toBe('/r')
  })

  posix('gives undefined when the shell fails', async () => {
    expect(await userShellPath(script('broken', 'exit 1'))).toBeUndefined()
  })
})
