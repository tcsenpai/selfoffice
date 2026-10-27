# SelfOffice Privacy

SelfOffice opens, edits, and saves documents locally. It has no accounts, no
hosted backend, and sends no analytics or telemetry.

AI features send requests only when you use them, and only to the provider you
configured: the `claude` or `codex` CLI on your machine (which talk to their
vendors under your own login), a vendor API with your own key, or your own
server. Web search uses the free keyless chain (Parallel Search MCP, then
DuckDuckGo) unless you select a keyed provider. Image generation and media
analysis are off until you configure a provider.

API keys are stored only on this device, in a settings file that only your user
account can read (it is not encrypted). Network traffic happens only to the AI
and search providers you configure.
