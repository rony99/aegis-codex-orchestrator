# Snippet: HTTP JSON summary (public API)

## Purpose

Fetch a JSON payload from a public endpoint and print a short summary for downstream scripts.

## Dependencies

- `curl`
- `python3`

## Configuration / secrets

- No secrets.
- Use only public no-key URLs for v0.3 tasks.

## Code

```bash
curl -fsSL "https://httpbin.org/json" | python3 -m json.tool | head
```

## Sample response

```json
{
  "slideshow": {
    "author": "Yours Truly",
    "date": "date of publication",
    "slides": [
      {
        "title": "Wake up to WonderWidgets!"
      }
    ]
  }
}
```

## Common pitfalls

- Some endpoints return huge responses; always keep the probe command bounded.
- If request headers are needed, capture them in `api-probes/README.md` and keep the developer implementation aligned.
