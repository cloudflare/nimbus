---
name: call-sample-co-api
description: Call the Sample Co Weather API for forecasts, current conditions, severe-weather alerts and weather-dependent decisions at a place. Use when a task needs weather data for coordinates or a place name, or code that integrates the Weather API.
---

# Call the Sample Co Weather API

Docs: https://demo.nimbus-docs.com/llms.txt. Every page has a Markdown version at `<page>/index.md`.

## When to use it

- Weather now, or forecasts from minute-by-minute rain (next two hours) to daily forecasts (sixteen days).
- Severe-weather alerts from national services, polled or pushed to a webhook.
- Decisions that depend on the weather: frost risk, spray windows, soil conditions, lightning nearby.
- Not for: climate projections beyond sixteen days, ocean or air-traffic data.

## Request basics

- Base URL: `https://api.weather.example/v2`.
- Auth: `Authorization: Bearer <key>`. Keys starting `wx_test_` are free and return realistic fixed data; `wx_live_` keys are billed. Read the key from `WEATHER_API_KEY`; never print it.
- Times are UTC; units are metric unless you pass `units=imperial`.
- Versions: v2 is current. v1 stops responding on 2026-12-31; don't write new v1 code. https://demo.nimbus-docs.com/concepts/versioning/index.md
- Errors share one shape, `{"error": {"type", "code", "message", "request_id"}}`. Retry `429` after `Retry-After` seconds, and `500` with backoff. https://demo.nimbus-docs.com/concepts/errors/index.md
- Lists paginate with `cursor`: pass the previous response's `next_cursor`. https://demo.nimbus-docs.com/concepts/pagination/index.md

## Common operations

Find a place, then use its coordinates:

```sh
curl "https://api.weather.example/v2/locations/search?q=Oslo" -H "Authorization: Bearer $WEATHER_API_KEY"
```

Reference: https://demo.nimbus-docs.com/api/locations/search-locations/index.md

A daily forecast (`days` up to 16):

```sh
curl "https://api.weather.example/v2/forecasts/daily?latitude=59.91&longitude=10.75&days=7" -H "Authorization: Bearer $WEATHER_API_KEY"
```

Reference: https://demo.nimbus-docs.com/api/forecasts/get-daily-forecast/index.md

Active alerts, filtered by country and severity:

```sh
curl "https://api.weather.example/v2/alerts?country=NO&severity=severe" -H "Authorization: Bearer $WEATHER_API_KEY"
```

Reference: https://demo.nimbus-docs.com/api/alerts/list-active-alerts/index.md

## Everything else

Every endpoint, grouped by product: https://demo.nimbus-docs.com/api/index.md. The OpenAPI document: https://demo.nimbus-docs.com/api/openapi.json.
