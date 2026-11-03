# MeshWars Board Integration

## Scope

Prioritize MeshCore. Use current board ownership to identify promising squares, while treating coverage and capture feasibility as separate inputs.

## Candidate endpoint

The user identified this request from the MeshWars map:

```sh
curl --fail-with-body --silent --show-error \
  --url 'https://meshwars.com/get-nodes' \
  --header 'Accept: application/json'
```

Start without authentication to determine whether the board is publicly readable. The original browser request included a session cookie; do not copy that value into code, documentation, fixtures, or logs. Authentication requirements have not been confirmed.

Omit `If-None-Match` for initial inspection: an unchanged response may return HTTP 304 without a body. If caching is supported, retain the response ETag alongside the cached payload and send it only when that payload is available.

Browser headers such as `sec-ch-ua` and `sec-fetch-site` are not part of the application data contract. Confirm the minimum required request before implementing a client.

## Verified response snapshot

Inspected the user-downloaded `../nodes.json` on November 3, 2026. It contains a JSON object with two arrays: `coverage` (14,229 records) and `repeaters` (1,608 records). The user's successful curl command did not require a session cookie. Live access from the development shell remains unavailable because of DNS resolution.

Each coverage record contains:

| Field | Observed meaning |
| --- | --- |
| `cell_id` | Unique square identifier, formatted as two signed integer indices separated by `_` |
| `owner_team` | Team name: RED, GREEN, BLUE, PURPLE, YELLOW, ORANGE, or PINK |
| `south`, `west`, `north`, `east` | Latitude/longitude bounds in decimal degrees |
| `scores` | Object mapping each of the seven team names to a numeric score |
| `last_report_ts`, `captured_at` | Numeric timestamps; report values are consistent with Unix seconds |
| `paint_count` | Numeric count; exact game semantics remain unverified |

Every observed square spans 0.0027 degrees latitude and 0.00384 degrees longitude. All records satisfy `south = first_index * 0.0027` and `west = second_index * 0.00384`. These are observations from this snapshot, not a guaranteed API contract. Prefer supplied bounds over reconstructing geometry. Physical cell width varies with latitude.

All coverage records have unique IDs and a named owner. This snapshot does not show how unowned squares are represented. Some owned squares have zero scores, so do not discard records based on score alone. The latest `last_report_ts` is `2026-11-03T21:35:17Z`; this is an observation timestamp, not a response generation timestamp.

Repeater records contain `id`, `name`, `lat`, `lon`, `elev`, `time`, and `team`. The units and semantics of `time` and `elev` remain unverified. Repeater positions alone do not establish radio coverage.

No explicit protocol discriminator appears in either record type. Confirm that this endpoint represents the MeshCore board before using it for production recommendations. The raw snapshot remains outside the project folder; do not commit the full location dataset as a fixture.

## Required schema checks

- Confirm how MeshCore records are selected or distinguished from Meshtastic records.
- Confirm the coordinate reference system and boundary inclusion rules.
- Verify score decay and capture rules; no explicit protection-expiry field is present.
- Determine whether uncolored squares are explicit records or absent from the response.
- Verify permitted data usage, freshness, and request limits before automated polling.

Store only a small, sanitized response fixture after inspecting real data. Avoid inventing field names in the production adapter.

## Planning implications

Ownership alone does not establish whether a square can be captured. The planner also needs the user's team, road access, likely radio coverage, and any available capture constraints. Absence from the board must not be interpreted as confirmed absence of coverage. Count each candidate square once per route.
