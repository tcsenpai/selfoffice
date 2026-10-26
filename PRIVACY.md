# SelfOffice Privacy

SelfOffice opens, edits, and saves documents locally. It has no accounts, no
hosted backend and no usage analytics: the tracker is a no-op in this fork.

AI features send requests only when you use them, and only to the provider you
configured: the `claude` or `codex` CLI on your machine (which talk to their
vendors under your own login), a vendor API with your own key, or your own
server. Web search uses the free keyless chain (Parallel Search MCP, then
DuckDuckGo) unless you select a keyed provider. Image generation and media
analysis are off until you configure a provider.

API keys are stored only on this device.

## Analytics events (inactive)

The code still contains the upstream tracker hooks, but no measurement
credentials ship with this fork, so nothing is sent. For reference, the
events the hooks would emit are:

- `install_first_launch` — marks the first use of a newly assigned anonymous `client_id`
- `app_launch` — no event-specific parameter
- `file_open` — `ext`, the file extension such as `docx` or `xlsx`
- `file_new` — `kind`, one of `docx`, `xlsx`, `pptx`, `md`, or `pdf`
