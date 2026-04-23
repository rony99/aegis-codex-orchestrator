# Sample task: Public API probe

Build a tiny local CLI in `workspace/` that fetches JSON from a public no-key HTTP API and prints a concise summary.

Use `https://httpbin.org/json` as the default API endpoint.

Minimum behavior:

- Before implementation, create an API probe under `api-probes/` that verifies the endpoint can be reached.
- Record either a real response sample or a clear failure note.
- The implementation may be minimal and local.
- No OAuth, API keys, paid services, databases, or UI.

Acceptance criteria:

- `api-probes/README.md` summarizes the probe decision and result.
- `api-probes/` contains a command note or executable probe.
- `api-probes/` contains a response sample or failure note.
- Developer implementation should use the recorded probe result instead of inventing the API shape.
