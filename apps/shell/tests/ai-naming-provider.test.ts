import { describe, expect, it } from 'vitest'
import { resolveNamingProvider } from '../src/main/ai-naming-provider'

/**
 * The naming service used to resolve its provider on its own: a hardcoded list
 * of three ids, and the key read out of the settings file. That list did not
 * know every provider the build can talk to.
 *
 * These assertions are the evidence that the provider is now resolved the way
 * the rest of the app resolves it: the user's own provider and key, with a
 * half-filled setup degrading to the claude CLI.
 */

describe('resolveNamingProvider', () => {
  it('falls back to the claude CLI when nothing is configured', () => {
    expect(resolveNamingProvider({})?.provider).toBe('claude-cli')
  })

  it('falls back to the claude CLI when the settings file could not be read at all', () => {
    expect(resolveNamingProvider(null)?.provider).toBe('claude-cli')
  })

  it('honors a configured provider', () => {
    const resolved = resolveNamingProvider({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' } },
    })
    expect(resolved?.provider).toBe('anthropic')
    expect(resolved?.config.apiKey).toBe('sk-ant')
    expect(resolved?.config.model).toBe('claude-sonnet-4-6')
  })

  it('falls back to the claude CLI when the configured provider is half-filled', () => {
    const resolved = resolveNamingProvider({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant', model: '' } },
    })
    expect(resolved?.provider).toBe('claude-cli')
  })

  it('falls back to the claude CLI for a provider this build does not have', () => {
    const resolved = resolveNamingProvider({ provider: 'not-a-provider', providers: {} })
    expect(resolved?.provider).toBe('claude-cli')
  })

  it('does not need a key for codex', () => {
    const resolved = resolveNamingProvider({ provider: 'codex', providers: {} })
    expect(resolved?.provider).toBe('codex')
  })

  it('accepts a local custom endpoint without a key', () => {
    const resolved = resolveNamingProvider({
      provider: 'custom',
      providers: {
        custom: { apiKey: '', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' },
      },
    })
    expect(resolved?.provider).toBe('custom')
    expect(resolved?.config.model).toBe('local-model')
  })

  it("resolves a custom endpoint's key from the environment", () => {
    process.env.SELFOFFICE_NAMING_TEST_KEY = 'from-env'
    try {
      const resolved = resolveNamingProvider({
        provider: 'custom',
        providers: {
          custom: {
            apiKey: '',
            model: 'local-model',
            baseUrl: 'http://127.0.0.1:11434/v1',
            profile: { apiKeyEnv: 'SELFOFFICE_NAMING_TEST_KEY' },
          },
        },
      })
      expect(resolved?.provider).toBe('custom')
      expect(resolved?.config.apiKey).toBe('from-env')
    } finally {
      delete process.env.SELFOFFICE_NAMING_TEST_KEY
    }
  })
})
