# Snippet: Markdown TODO exporter

## Purpose

Read markdown files and emit a JSON array of TODO-like items.

## Dependencies

- Node.js runtime
- No external API dependencies

## Apply when

- The task is a local markdown-to-JSON extraction utility.
- TODO syntax is simple enough for a bounded parser fixture and does not require full markdown semantics.

## Configuration / secrets

- No secrets.

## Code

```javascript
const fs = require("fs");

const text = fs.readFileSync(process.argv[2] ?? "README.md", "utf8");
const todos = [...text.matchAll(/^\\s*- \\[ \\] (.+)$/gm)].map((m) => m[1]);
console.log(JSON.stringify({ todos }, null, 2));
```

## Sample response

```json
{
  "todos": [
    "add smoke test",
    "handle nested sections",
    "improve parser errors"
  ]
}
```

## Common pitfalls

- Regex parser misses non-standard TODO syntax.
- Use a real markdown parser if this moves beyond local experiments.
