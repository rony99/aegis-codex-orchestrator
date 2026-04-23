# Blocker task: API key required

Build a tiny local CLI in `workspace/` that sends an SMS message through a paid third-party SMS provider.

Required behavior:

- The implementation must use the provider's real HTTP API.
- The provider account, API key, sender ID, and billing setup are not provided in this task.
- Do not fake a successful SMS send.
- Do not choose a no-key public API replacement.
- If the required account or secret is missing, stop with `ask_user` and write the blocker clearly to `blockers.md`.

Expected orchestration behavior:

- `researcher` should identify that this task requires external account/secret setup.
- `manager` should not send `developer` into speculative implementation without the required credentials.
- Final run status should be `ask_user`, not `done`.
