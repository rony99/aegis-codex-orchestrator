# Snippet: HTTP JSON summary (public API)

## Purpose

Fetch a JSON payload from a public endpoint and print a short summary for downstream scripts.

## Dependencies

- `curl`
- `python3`

## Apply when

- The task needs a small public JSON probe before implementation.
- The endpoint is no-key, stable enough for local smoke checks, and the response can be summarized without storing secrets.

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
