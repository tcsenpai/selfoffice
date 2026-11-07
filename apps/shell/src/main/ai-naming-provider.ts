/**
 * Which provider answers a file-naming request.
 *
 * The naming service used to carry its own list of provider ids and read the
 * key out of the settings file. That list did not know every provider the
 * build can talk to.
 *
 * This module resolves the provider the way the rest of the app does: the
 * shared `resolveAiSettings` + `activeProvider` from `@selfoffice/ai-provider`
 * (the user's own key, local model or custom endpoint; a half-filled setup
 * degrades to the claude CLI), and a custom endpoint's credential reference
 * resolved from the environment.
 */
import type { AiProviderConfig, AiProviderId } from '@selfoffice/ai-provider'
import {
  activeProvider,
  defaultAiSettings,
  resolveAiSettings,
  resolveProfileCredential,
} from '@selfoffice/ai-provider'

/** The provider to call, and the credentials to call it with. */
export interface NamingProvider {
  provider: AiProviderId
  config: AiProviderConfig
}

/**
 * The provider a naming request goes to, or null when no provider can answer.
 *
 * `stored` is the parsed `ai-settings.json`. Null rather than a broken
 * provider: a request with no usable provider is declined, and the caller
 * keeps the name the document already has.
 */
export function resolveNamingProvider(stored: unknown): NamingProvider | null {
  const settings = resolveAiSettings(stored, defaultAiSettings())
  // a stored BYOK provider is honored when usable; a half-filled one falls back
  // to the claude CLI rather than silently disabling AI
  settings.provider = activeProvider(settings)
  const provider = settings.provider
  const storedConfig = settings.providers?.[provider]
  if (!storedConfig) return null
  // a custom endpoint may name an environment variable instead of storing a key
  const config = resolveProfileCredential(storedConfig)
  return { provider, config }
}
