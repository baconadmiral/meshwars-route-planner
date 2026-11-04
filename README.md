# MeshWars Route Planner

A local, Meshtastic route planner with a territory map and printable, MapQuest-style turn-by-turn directions. It prioritizes easy-to-capture enemy squares and unpainted exploration within a maximum extra-driving-time budget.

## Run locally

Requires Python 3.10+ and an internet connection for address lookup, routing, map tiles, and the Leaflet map library. No package installation is required.

```sh
cd ~/OTHER_DEV/meshwars-route-planner
python3 server.py
```

Open **http://127.0.0.1:8000**. The server fetches MeshWars immediately and checks for updates every 5 minutes. The browser checks local feed status every 15 seconds and loads changed boards without reloading the page. The **Capture data** panel shows successful checks, errors/fallback status, and a **Refresh now** button.

The existing `../nodes.json` is an optional startup fallback. The latest successfully validated live board is saved atomically in `.cache/board.json` (Git-ignored), and reused on restart. Your original `nodes.json` is not overwritten. The app can start without either file and will enable planning once its first live fetch succeeds.

To use another snapshot or port:

```sh
python3 server.py --board /path/to/nodes.json --port 8080
```

## Automatic capture feed

`board_feed.py` polls `https://meshwars.com/get-nodes` in one background thread, independently of route requests. It uses ETag/Last-Modified conditional requests when provided, validates square records before replacing data, and retains the last good board if the network, response validation, or cache write fails. The feed checks immediately on server startup and every 30 minutes by default, including retries after failures; the UI displays the retry interval. The browser loads capture data initially and checks for updates every 30 minutes. Switching tabs does not trigger an extra check. Manual checks are spaced at least 15 seconds apart and never overlap.

Configure the feed when needed:

```sh
MESHWARS_REFRESH_SECONDS=1800 python3 server.py
```

`MESHWARS_REFRESH_SECONDS` defaults to 1800 (30 minutes) and must be at least 15. `MESHWARS_BOARD_URL` can override the feed endpoint for a compatible service. No session cookie is stored or sent. `/api/board/status` returns lightweight freshness metadata; `/api/board` includes the full coverage array; `POST /api/board/refresh` schedules a check.

Each route search holds the board version present when it starts. Updated scores cannot change the objective midway through a beam search. Existing results are flagged when newer board data arrives; rerun the search to use it. Capture-age and display settings apply to refreshed data immediately. Feed freshness reflects a successful fetch/check, not a guarantee that upstream observations are recent.

## Optional capture attribution

The capturing-player filter has been removed from the interface. Capture-age filtering remains available; any previously saved player filter no longer applies. The optional server integration below remains available for board metadata.

The existing board payload has no player names. The optional integration reads the documented [`/api/v1/captures`](https://meshwars.com/api#captures) endpoint for MeshCore, using a server-side `MESHWARS_API_KEY`. Obtain a read-only integration key from the MeshWars operator, configure it in your local environment, and restart `python3 server.py`. Do not put the key in frontend code, version control, or this chat. `MESHWARS_API_URL` overrides the API base if needed.

Attribution refreshes alongside the board. Events are joined only when both owner team and capture timestamp exactly match the current square. This identifies the last matching capturer, not everyone who ever visited or defended the square. Names and the cursor are cached in Git-ignored `.cache/capture_users.json`; the key is never cached or returned to the browser. Missing/failed attribution does not stop normal board updates.

Coverage is partial: the initial request reads at most 500 recent events; later polls accumulate the latest observed event per square. Older or missed events remain Unknown. The app does not guess names from teams or claim complete historical player coverage. An expired/rejected key is recorded in board attribution metadata.

## Plan a drive

1. Select **Your team** (BLUE by default), then set A and B. Enter an **address or place name**, choose **Find address**, and select the correct match. Include city and state or ZIP code to narrow the results. You can also enter **latitude, longitude** or click the map to set A and B. Mix addresses and coordinates freely. A third map click starts a new pair. Submitting an unresolved address also performs lookup and asks you to choose a match before routing. Editing a selected address clears its saved location.
2. Optionally add ordered manual waypoints using **Add waypoint** or **Pick on map**. Then set the maximum additional driving time, from 0 to 120 minutes. Choose **Beam search** (default), **Greedy** (the previous method), or **Compare beam vs. greedy**.
3. Choose **Find [your team] opportunities**. A live progress bar shows the search stage and completed detours, with elapsed time and time since the last server update. Slow provider requests display a waiting message. Percentages represent search work, not estimated time remaining. The search may take several minutes if routing requests time out. Use **Cancel search** to stop; a request already sent to the provider may take until its timeout to release the server task.
4. Compare up to six beam route options (up to three for greedy), the fastest-route baseline, and numbered directions. In Compare mode, a table shows each method’s weighted value, raw target count, driving time, and refinement checks. Use **Show route** to switch the map and directions without rerunning the search.
5. Print the selected directions or download its GeoJSON line geometry.

Use **Dark mode** in the header to toggle the interface and basemap appearance. The initial theme follows your system preference; an explicit choice is remembered in this browser. Only the basemap is filtered, preserving route and team colors. Printing uses the light theme.

The route plan and divider stay hidden until a search returns routes, giving the map the full workspace initially. In Compare mode the plan remains available if either method has routes. The saved split is restored when the plan appears.

Drag the **Map / route plan** divider up or down to change the panel sizes. The sidebar and route plan scroll independently on desktop, keeping the map visible. Your split is remembered in this browser. Focus the divider and use Up/Down arrows (Shift for larger steps), Home/End for minimum/maximum map size, or double-click to reset. Touch dragging is supported. Printed directions use a fixed map height and expand the full route plan.

The map shows team-colored cells with score-based faint-to-bold fills, visually capped at 3 points; hover to see the full holding score and recorded capture time. Missing scores are labeled unknown. Cells are drawn when fewer than 2,501 known squares are in view; zoom in if territory is hidden. Gray indicates the fastest baseline, and blue indicates the selected route.

## Navigate and transfer to a phone

After selecting a route, choose **Navigate / send to phone** to open a centered QR and sharing dialog. Close it with **Close ×**, Escape, or a click outside the dialog; focus returns to the navigation button. Each navigation section has **Open Google Maps**, a camera-scannable QR code, **Copy link**, and (when supported by the browser) a native **Share link** button. Scan a QR from the desktop to open its Google Maps URL directly on your phone: the phone does not need access to the local Python server, and no route-hosting service or email is required. QR codes are generated in the browser with a CDN-loaded QR library; coordinates are not sent to a QR-image service.

All manual and exploration stops are retained in order. Long routes are divided into sections with at most three intermediate stops per Google Maps link, respecting the documented mobile-browser waypoint limit. Sections overlap at their boundary stop. Use **Copy all navigation links** or **Share all links** to transfer the complete ordered list before leaving, then open sections in sequence. Google Maps can open a preview rather than immediately start navigation depending on the device/location; review it and start when ready. [Google Maps URL documentation](https://developers.google.com/maps/documentation/urls/get-started).

Google recalculates roads between the stops and may skip planned capture streets. For the complete geometry, use **Download GPX track**. The GPX retains every route coordinate and stop, without simplifying the track. It contains no spoken maneuver instructions; import it into an app that supports following GPX tracks and review that app’s handling of the track. Google Maps does not import a GPX track through these direction links.

**Share GPX file** appears when the browser supports sharing that file type. Otherwise download it and transfer it using AirDrop, Quick Share, your usual file/cloud app, or email. Native sharing targets depend on your device; no messages or emails are sent automatically. Browser/device handoff and QR scanning have not been verified in this sandbox. If the QR library cannot load, copy/share links remain available.

## Guide exploration with manual waypoints

Add up to eight mandatory stops between A and B. Each accepts an address or coordinates, or use **Pick on map** to create a stop with the next map click. Existing rows have a **Map** button to reposition them. Use the arrows to reorder stops and **Remove** to delete one. Press Escape to cancel a pending map pick. Markers and printed directions identify them as W1, W2, etc.

For example, place W1 west of your start and W2 farther along the western area before your destination. Every baseline, initial detour, and beam/greedy candidate must include those stops in order. The optimizer can insert exploration stops between them but cannot discard or reorder your manual stops. Broad exploration candidates are generated around each required leg, sharing a maximum of 16 initial requests instead of multiplying requests for every leg.

The time budget is relative to the fastest route **through all manual waypoints**. If that drive takes 30 minutes and you permit 15 extra minutes, results must fit within 45 minutes. An unreachable required route returns an error rather than silently dropping a stop. The map is intended to guide regional exploration; waypoints do not establish radio coverage or forbid every road outside a region. Routing providers may snap the chosen coordinates to nearby roads. Edit stops and run a new search to update an existing plan.

## Find your current location

Choose **My location** below the map zoom buttons to center the map on your device at street level. Allow the browser’s location request; a dot marks the reported position and a circle shows its accuracy. This is a one-time lookup on each click and does not change your route endpoints. Device location requires HTTPS or localhost.

## Choose your team

Use **Your team** above the start address to select BLUE (the default), RED, GREEN, PURPLE, YELLOW, ORANGE, or PINK. Your team’s territory is excluded from enemy targets throughout exploration, refinement, and scoring. Other teams are scored using the current owner’s score. Changing teams clears the previous plan; run a new search. Route colors, labels, GeoJSON, and GPX exports reflect the selected team.

## How route selection works

The planner requests OSRM driving routes with full geometry and maneuver steps, then tries near, medium, and far excursions on both sides of the trip, plus known enemy cell centers. Feasible initial routes seed the refinement search:

- **Greedy:** extends the best incumbent with up to four waypoint insertions per round, stopping when no improvement is found. At most three rounds and 12 refinement requests.
- **Beam:** retains up to six routes at each depth, balancing capture value (65%) with territory difference (35%) to explore different branches, trying up to four insertions per route over three rounds. It can continue a temporarily weaker branch to discover a better later combination. At most 72 refinement requests. Earlier good routes remain eligible for the final result.
- **Compare:** runs both refinements from identical initial routes and the same board/time budget. A request-scoped cache reuses identical routing requests, including failures, between methods. The table reports logical refinement checks; total provider requests reflect cache misses. Beam has a larger search allowance, so this is a comparison of the available modes, not an equal-compute experiment.

Insertions target missed cells within two grid cells of the actual road route, preserving previous waypoints in trip order. Routes exceeding the fastest baseline plus the detour budget are excluded at every depth. Remaining routes are ranked by weighted capture value, then raw target count, driving time, and distance. Beam always keeps the best-scoring route first. Final beam alternatives must differ from every selected option by at least 20% using Jaccard distance over all crossed grid cells (including friendly territory). This suppresses tiny street variations and may return fewer than six options when the feasible routes are similar. Alternatives balance capture value with territory difference before being displayed in score order; a different drive may have lower capture value. This compares territory footprints, not exact road overlap. Revisits count once. Traversal uses the observed 0.0027-degree latitude and 0.00384-degree longitude grid; boundary-only touches do not add counts. Zero-target routes are not recommended.

These are bounded heuristic searches, not proofs of the optimal route. Beam can still miss useful combinations or finish with fewer targets than greedy; Compare mode reports the difference rather than assuming beam wins. Unpainted cells are inferred from the observed grid and absence from the snapshot; this is an exploration assumption, not evidence of radio coverage or guaranteed eligibility. The UI separates enemy and unpainted counts and outlines selected targets in green (dashed for unpainted). Ownership is a targeting signal, not a capture probability. Holding-team scores influence the heuristic, but radio coverage, transmission timing, protection, future score decay, and your team’s existing score deficit are not modeled. Repeater coordinates are not treated as coverage predictions. Confirm that the downloaded board corresponds to MeshCore; the payload contains no explicit protocol field.

Directions are a planning sheet, without live navigation, traffic, rerouting, or guaranteed current road restrictions. Detour centers may snap to nearby roads and do not guarantee traversal of the target cell; the actual returned geometry determines the square count.

## Capture difficulty and square shading

The holding score is `scores[owner_team]`, not the sum of teams’ scores or `paint_count`. Squares owned by your selected team contribute no reward. Routing uses this explicit heuristic:

| Cell | Weighted value |
| --- | --- |
| Enemy with owner score 0–1 inclusive | 1 |
| Enemy above 1 point | `1 / score²` (2 points → 0.25; 50 points → 0.0004) |
| Enemy with missing/invalid score | 0.5, labeled unknown |
| Unpainted cell inferred from snapshot absence | 1, labeled exploration with unknown coverage |

The weights affect initial enemy candidates, exploration clusters, local insertion priorities, and both greedy/beam ranking. Raw target counts remain visible alongside weighted value, easy/defended enemy counts, unknown scores, and unpainted counts. Exported GeoJSON includes the weighted value. Square appearance is independent of route weights. **Overall square fill** sets maximum opacity (0–100%, default 80%); **Score contrast** controls how much lower-score cells fade (0% uniform, 100% strongest separation, default 70%). Both values persist in the browser, preserving the existing fill preference. The visual score range is 0–3: a 0.1-point cell is faint, 3 points reaches full strength, and 50 looks the same as 3. Full scores still determine routing difficulty.

The palette uses muted team hues without pale white-heavy fills in dark mode. Filled squares have no grid stroke; hover reveals a temporary team outline. At 0% overall fill, faint team outlines remain. Both sliders redraw immediately and on release; theme changes repaint the fills too. The legend follows the same settings.

**Captured in last** filters the map across all teams: 0 (the default) shows every square, and 1–60 shows captures in the last N rolling 24-hour days using `captured_at`, relative to the current device time. Both endpoints of the time window are included. Missing, invalid, and future capture timestamps are hidden while a window is active. The setting persists in the browser; a count shows how many snapshot squares match. Selected-route target overlays follow the same filter, while the route line and route statistics remain unchanged. This is a display filter: routing still uses the full snapshot. Moving either direction redraws immediately without recentering the map.

Score strength is not an exact capture-age measure: the tooltip includes `captured_at` from the snapshot where available.

This utility is a planning preference, not a capture probability or an estimate of awarded game points. [MeshWars describes a ping as earning up to one point](https://meshwars.com/about), so a low holding score is promising but does not establish that every single transmission will steal the square. Scores come from the loaded snapshot and are not extrapolated forward; use the automatic feed or Refresh now to reflect current territory.

## Parallel routing and performance

Independent initial detours and the candidates within each refinement round run concurrently, using four workers by default. The next beam round starts only after the current round finishes. Results are collected in original candidate order before ranking, so worker completion timing does not alter the search. Candidate counts, beam width, scoring, and driving budgets are unchanged. Concurrent duplicates share the same in-flight request, and progress updates as requests finish. Cancellation stops queued jobs; requests already running may finish their provider wait/timeout.

The server also caps concurrent provider calls across all searches. Public OSRM request starts are spaced at least one second apart, following its [demo server usage policy](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server). Slow responses can overlap, but this is not a way to bypass provider limits. The completion status reports worker count and average routing time, including queue and rate-limit waits.

For a local or dedicated OSRM service that supports the load:

```sh
OSRM_URL=http://localhost:5000 OSRM_WORKERS=8 OSRM_REQUEST_INTERVAL=0 python3 server.py
```

`OSRM_WORKERS` accepts 1–16 (default 4). `OSRM_REQUEST_INTERVAL` sets the minimum seconds between provider request starts; it defaults to 1 for the public demo hosts and 0 for other hosts. Public hosts always enforce at least 1 second. Choose settings appropriate to your dedicated provider. Set `OSRM_WORKERS=1` to run serially for comparison.

A mocked 30 ms request-latency benchmark completed 76 provider requests in 2.323 seconds serially versus 0.635 seconds with four workers (3.66×), with identical selected routes. This measures the concurrency implementation, not real OSRM performance. Live speedup depends on provider latency, rate limits, and available network capacity; no live performance claim has been verified in this sandbox.

## Services and privacy

The server listens on loopback only. Trip coordinates are sent to the configured routing provider, which defaults to the public OSRM demonstration service. This service has no availability guarantee; use your own or a supported provider for sustained use. Override its origin with `OSRM_URL`, for example:

```sh
OSRM_URL=http://localhost:5000 python3 server.py
```

Address lookup uses [Photon](https://photon.komoot.io/), which accepts modest usage but may throttle requests and does not guarantee availability. Lookups are explicitly triggered, not performed on every keystroke. Address text is sent to the configured Photon server, while coordinate inputs bypass geocoding. Up to 128 successful query responses are cached in server memory and cleared on restart; addresses are never written to disk by this app. Choose matches carefully, since map coverage and address precision vary. If lookup fails, coordinates and map clicks still work. To use a self-hosted or compatible Photon service:

```sh
PHOTON_URL=http://localhost:2322 python3 server.py
```

Browser assets load from unpkg.com; map tiles load from OpenStreetMap. The application suppresses HTTP access logs and does not persist trips. The optional seed snapshot stays outside the project folder; the live fallback cache stays in Git-ignored `.cache/`. Board data is not bundled into version control.

## Structure and verification

- `server.py`: local HTTP API and OSRM adapter.
- `board_feed.py`: background board polling, validation, conditional requests, and durable fallback cache.
- `capture_users.py`: optional authenticated capture-event polling and conservative player attribution.
- `teams.py`: supported teams and shared input validation.
- `navigation.py`: mobile-compatible Google Maps sections and complete GPX track serialization.
- `planner.py`: geometry intersections, candidate selection, and route ranking.
- `geocoder.py`: Photon integration, response normalization, and bounded in-memory lookup cache.
- `static/`: map, route controls, directions, and print layout.
- `tests/`: deterministic scoring and HTTP-handler tests with mocked routing.
- `docs/meshwars-integration.md`: observed board schema and remaining questions.

Run checks:

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile server.py planner.py geocoder.py board_feed.py capture_users.py navigation.py teams.py
```

Automated tests cover exploration away from a BLUE-only corridor, unique unpainted counts, budget enforcement, zero-target handling, progress events, streaming errors, disconnected-search termination, address result parsing, query encoding/caching, input validation, lookup failure handling, missed-cell insertion, long straight road sampling, preservation of the faster route when geometry is duplicated, beam search escaping a greedy local optimum, shared-request reuse, beam request limits, bounded concurrency, serial/parallel result equivalence, in-flight deduplication, partial batch failures, provider request spacing, owner-score thresholds, missing/invalid scores, low-score targets outranking larger groups of 50-point squares, live-feed updates, conditional responses, failure fallback, cache persistence, manual refresh throttling, pinned search revisions, exact player/event matching, attribution caching, cursor replay, rejected-key fallback, ordered waypoint preservation in every provider request, constrained baseline budgets, repeated stops, invalid/unreachable waypoint handling, navigation section continuity, waypoint/URL limits, GPX coordinate retention and XML escaping, and the route-export endpoint. HTTP handlers are exercised in memory because this development sandbox prevents opening local sockets. Live provider requests and browser rendering have not been verified here; DNS, socket restrictions, and missing Node tooling prevent live preview and Sites packaging/publication.

## References

- [MeshWars rules](https://www.meshwars.com/about)
- [Board schema notes](docs/meshwars-integration.md)
- [OSRM route and maneuver API](https://project-osrm.org/docs/v5.24.0/api/)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)

A deterministic mocked-road regression demonstrates greedy collecting 4 target squares while beam collects 9 under the same driving-time cap. This verifies branching behavior, not expected improvement on live roads. Live comparisons require running Compare mode on your machine.
