# v0.2 task: API probes

Implement v0.2 API probe support for Aegis Codex Orchestrator.

Goal:

Before developer agents implement features that depend on an external API or SDK, the researcher phase should create executable probe artifacts and record real responses. Later developer/tester prompts should receive those probe artifacts as ground truth.

Required behavior:

- Each run directory should include an `api-probes/` directory.
- The researcher prompt must require an `api-probes/README.md` summary.
- If a task has no external API/SDK dependency, the researcher should explicitly record that no probes are needed.
- If a task depends on an external API/SDK, the researcher should create a minimal probe script or command note under `api-probes/`, plus a response sample or failure note.
- Developer and tester prompts should include an API probe summary so implementation does not rely on stale model memory.
- Keep v0.2 minimal. Do not implement OAuth, secret management, snippets, observer, UI, or parallel agents.
- Use a public no-key HTTP endpoint as the recommended sample probe target when a real probe is needed.

Acceptance criteria:

- `npm run typecheck` passes.
- `npm run build` passes.
- A new orchestration run creates `api-probes/`.
- Researcher instructions mention `api-probes/README.md` and no-probe handling.
- Developer/tester prompts include existing `api-probes/` contents.
- Documentation reflects current v0.2 API probe behavior and remaining limitations.
