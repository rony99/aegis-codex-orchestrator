# Snippet: Parser edge-case validation

<!-- snippet-promotion: {"slug":"parser-edge-case-validation","title":"Parser edge-case validation","source":"2026_04_25T00_41_28Z-candidates.md","status":"approved","createdBy":"promote-snippet"} -->

## Promotion

- Status: approved
- Slug: parser-edge-case-validation
- Source candidate: 2026_04_25T00_41_28Z-candidates.md
- Promoted by: codex-gtd promote-snippet

## Content

# Snippet candidates (Aegis v0.5)

Source run: (redacted local path)/2026-04-25T00-41-28Z
Generated at: 2026-04-25T00:42:51.343Z

## Candidates extracted from observer lessons

### 1

**Run-summary health-check script**
- Purpose: prevent missing/unreadable `run-summary.json` at closeout.
- Pattern:
- `test -f run-summary.json`
- `node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync('run-summary.json')); ..."`
- assert required keys + non-empty values.
- Apply when: every loop finish.

### 2

**API-probe README section validator**
- Purpose: enforce protocol section completeness.
- Pattern:
- grep for exact section headers:
- `^# Probe Decision`
- `^# External Dependencies`
- `^# Probe Artifacts`
- `^# Recorded Results`
- `^# Known Limitations`
- Apply when: no external dependencies and when probe section is intentionally minimal.

### 3

**Parser edge-case unit block for CLI validation scripts**
- Purpose: reusable input parsing sanity checks:
- comment/blank handling
- duplicate key accumulation order
- boolean coercion only for exact `true|false`
- invalid line fails with line number.
- Can be adapted from this run’s verify expectations to future local parsers.

## Acceptance before promotion

- Run tests on the extracted snippet in your repo context.
- Validate assumptions against current tech stack (runtime, dependencies, error contract).
- Move approved snippets to `snippets/` and add to `snippets/INDEX.md`.
