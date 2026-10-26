import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import {
  buildCodexAppServerPrompt,
  codexAppServerOutputSchema,
  parseCodexAppServerTurn,
} from './codex-app-server'
import type { StreamCallbacks } from './protocols/shared'
import type { AiChatResponse, AiProviderConfig } from './types'
import { createStreamWatchdog } from './watchdog'

/**
 * Claude subscription via `claude -p`. Not `--bare`: bare mode never reads the
 * OAuth login, which is the whole point of this provider. The same isolation
 * comes from flags instead: no built-in tools, no settings/CLAUDE.md, no MCP,
 * no slash commands, no session file, neutral cwd.
 *
 * shortcut: one blocking call per turn (no token streaming), because tool
 * calls travel as a JSON-schema reply like the Codex bridge; upgrade to
 * stream-json partials if live typing matters.
 */
export const CLAUDE_CLI_MODELS = ['sonnet', 'opus', 'haiku']

const SYSTEM =
  'You are the model behind a document editor. Answer only in the required JSON schema.'

export function claudeCliArgs(model: string, schema: Record<string, unknown>): string[] {
  return [
    '-p',
    '--model',
    model || 'sonnet',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    SYSTEM,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
  ]
}

interface ClaudeCliResult {
  is_error?: boolean
  result?: string
  structured_output?: unknown
  usage?: { input_tokens?: number; output_tokens?: number }
}

function runClaude(
  config: AiProviderConfig,
  prompt: string,
  schema: Record<string, unknown>,
  signal: AbortSignal,
  onActivity?: () => void,
): Promise<ClaudeCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.cliPath?.trim() || 'claude', claudeCliArgs(config.model, schema), {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // an API key in the env would silently bill the API instead of the subscription
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
    })
    let out = ''
    let err = ''
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      onActivity?.()
    })
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000)
    })
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        e.code === 'ENOENT'
          ? new Error(
              'Claude CLI not found. Install Claude Code and run `claude login`, or set its path.',
            )
          : e,
      ),
    )
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted)
        return reject(Object.assign(new Error('Claude CLI cancelled'), { name: 'AbortError' }))
      try {
        const parsed = JSON.parse(out) as ClaudeCliResult
        if (parsed.is_error) throw new Error(parsed.result || 'Claude CLI reported an error')
        return resolve(parsed)
      } catch (e) {
        reject(
          new Error(
            code === 0 && out
              ? `Claude CLI: ${e instanceof Error ? e.message : String(e)}`
              : `Claude CLI exited ${code}: ${(err || out).trim()}`,
          ),
        )
      }
    })
    child.stdin.end(prompt)
  })
}

export async function streamClaudeCli(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(async () => {
    const schema = codexAppServerOutputSchema(tools)
    const prompt = buildCodexAppServerPrompt(system, messages, tools, maxTokens)
    const res = await runClaude(config, prompt, schema, wd.signal, () => {
      wd.touch()
      cb.onActivity?.()
    })
    const raw =
      typeof res.structured_output === 'object' && res.structured_output
        ? JSON.stringify(res.structured_output)
        : (res.result ?? '')
    const turn = parseCodexAppServerTurn(raw, tools)
    if (turn.text) cb.onDelta(turn.text)
    for (const call of turn.toolCalls) cb.onToolCall({ ...call, id: `claude-${randomUUID()}` })
    if (res.usage) {
      cb.onUsage?.({
        ...(res.usage.input_tokens !== undefined ? { inputTokens: res.usage.input_tokens } : {}),
        ...(res.usage.output_tokens !== undefined ? { outputTokens: res.usage.output_tokens } : {}),
      })
    }
  })
}

export async function chatClaudeCli(
  config: AiProviderConfig,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<AiChatResponse> {
  let content = ''
  await streamClaudeCli(config, system, [{ role: 'user', text: user }], [], 1024, {
    signal,
    onDelta: (t) => {
      content += t
    },
    onToolCall: () => undefined,
  })
  return content ? { ok: true, content } : { ok: false, error: 'Claude CLI returned no content' }
}
