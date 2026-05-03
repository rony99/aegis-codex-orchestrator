# AGENTS.md

This repo uses Claude Code SDK with the MiniMax Anthropic-compatible endpoint by default.

Before running Claude Code SDK workflows such as `codex-gtd cc-run` or `codex-gtd cc-spec`, load the repo-local `.env` file:

```bash
set -a
source .env
set +a
```

Use these Claude Code defaults for this repo:

- `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`
- `ANTHROPIC_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M2.7`
- `API_TIMEOUT_MS=3000000`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- Enable `superpowers@superpowers-marketplace`.
- Enable `swift-lsp@claude-plugins-official`.
- Set `includeCoAuthoredBy=false`.
- Set `skipDangerousModePermissionPrompt=true`.

Do not copy secrets from `.env` into committed docs, logs, examples, or run artifacts. `.env` is local runtime configuration and must stay ignored by git.
