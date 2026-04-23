# Pilot task: Markdown TODO exporter

Build a small local CLI in `workspace/` that reads a Markdown file and exports TODO items as JSON.

Minimum behavior:

- Input: a Markdown file path.
- Output: JSON printed to stdout.
- Detect unchecked Markdown task items such as `- [ ] Write tests`.
- Ignore checked items such as `- [x] Done`.
- Include the task text and 1-based line number in each output item.
- Include a test command that verifies the parser on a sample Markdown file.

No external services, accounts, network APIs, or UI.
