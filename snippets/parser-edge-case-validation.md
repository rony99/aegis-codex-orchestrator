# Snippet: Parser edge-case validation

<!-- snippet-promotion: {"slug":"parser-edge-case-validation","title":"Parser edge-case validation","source":"2026_04_25T01_13_17Z-candidates.md","status":"approved","createdBy":"manual-curation"} -->

## Purpose

Enforce deterministic behavior for small line-oriented parser CLIs, especially env/config/ini-like formats.

Use this when a task asks for a local parser that must reject malformed input, preserve line-numbered errors, and handle repeated or typed values predictably.

## Dependencies

- Node.js for parser implementations.
- Bash for verification scripts.
- No external API dependencies.

## Pattern

Create a verification script with one explicit section per parser contract:

- valid parse and whitespace trimming
- blank line and comment skipping
- duplicate key behavior
- exact boolean coercion, if the task requires it
- malformed line failure
- stderr contains the 1-based source line number for malformed input

Prefer exact JSON assertions over substring checks for successful parse cases.

## Example Verification Skeleton

```bash
#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="${SCRIPT_DIR}/your-parser.js"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_json_eq() {
  local input_file="$1"
  local expected_json="$2"
  local desc="$3"
  local output_file="${TMP_DIR}/output.json"
  local error_file="${TMP_DIR}/error.log"

  if ! node "$PARSER" "$input_file" > "$output_file" 2> "$error_file"; then
    fail "$desc expected success: $(cat "$error_file")"
  fi

  node -e "
const fs = require('node:fs');
const actual = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const expected = JSON.parse(process.argv[2]);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('Expected:', JSON.stringify(expected));
  console.error('Got:', JSON.stringify(actual));
  process.exit(1);
}
" "$output_file" "$expected_json" || fail "$desc output mismatch"
}

assert_malformed_line() {
  local input_file="$1"
  local expected_line="$2"
  local desc="$3"
  local output_file="${TMP_DIR}/malformed-output.json"
  local error_file="${TMP_DIR}/malformed-error.log"

  if node "$PARSER" "$input_file" > "$output_file" 2> "$error_file"; then
    fail "$desc expected parser failure"
  fi

  grep -q "line ${expected_line}" "$error_file" \
    || fail "$desc missing line number ${expected_line}: $(cat "$error_file")"
}
```

## Common Pitfalls

- Only checking "command succeeds" instead of asserting exact parsed JSON.
- Forgetting negative tests for malformed non-empty lines.
- Reporting parse errors without source line numbers.
- Handling duplicate keys accidentally through object assignment without documenting whether first or last value wins.
- Coercing values too broadly, such as treating `True`, `TRUE`, or `true-ish` as booleans when the contract only allows exact `true` / `false`.
