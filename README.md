# MeshWars BLUE Route Planner

A local, MeshCore-first route planner with a territory map and printable, MapQuest-style turn-by-turn directions. It prioritizes unique non-BLUE squares crossed within a maximum extra-driving-time budget.

## Run locally

Requires Python 3.10+ and an internet connection for address lookup, routing, map tiles, and the Leaflet map library. No package installation is required.

```sh
cd ~/OTHER_DEV/meshwars-route-planner
python3 server.py
```

Open **http://127.0.0.1:8000**. The default board snapshot is `../nodes.json`, matching your existing download. To refresh it, stop the server, download a new snapshot, and restart:

```sh
curl --fail --silent --show-error https://meshwars.com/get-nodes -o ../nodes.json
```

To use another snapshot or port:

```sh
python3 server.py --board /path/to/nodes.json --port 8080
```

## Plan a drive

1. Enter an **address or place name**, choose **Find address**, and select the correct match. Include city and state or ZIP code to narrow the results. You can also enter **latitude, longitude** or click the map to set A and B. Mix addresses and coordinates freely. A third map click starts a new pair. Submitting an unresolved address also performs lookup and asks you to choose a match before routing. Editing a selected address clears its saved location.
2. Set the maximum additional driving time, from 0 to 120 minutes.
3. Choose **Find BLUE opportunities**. A live progress bar shows the search stage and completed detours, with elapsed time and time since the last server update. Slow provider requests display a waiting message. Percentages represent search work, not estimated time remaining. The search may take several minutes if routing requests time out. Use **Cancel search** to stop; a request already sent to the provider may take until its timeout to release the server task.
4. Compare up to three route options, the fastest-route baseline, and numbered directions.
5. Print the selected directions or download its GeoJSON line geometry.

The map shows team-colored cells when fewer than 2,501 known squares are in view; zoom in if territory is hidden. Gray indicates the fastest baseline, and blue indicates the selected route.

## How route selection works

The planner requests OSRM driving routes with full geometry and maneuver steps, then tries near, medium, and far excursions on both sides of the trip, plus known enemy cell centers, followed by up to three rounds of local refinement. Each round looks for unvisited target cells within two grid cells of the actual road route and tries inserting up to four additional waypoints in trip order. Useful waypoints are retained across rounds, allowing routes with more than two detours. The refinement phase stops if it finds no improvement and uses at most 12 routing requests, matching the previous refinement request limit. Routes exceeding the baseline duration plus the budget are excluded. Remaining routes are ranked by unique target squares crossed, then driving time and distance. Targets include known enemy squares and unpainted exploration cells. Repeated visits count once. Traversal is counted through cell interiors using the observed grid spacing of 0.0027 degrees latitude and 0.00384 degrees longitude. Boundary-only touches do not add target counts. Zero-target routes are not offered as recommendations.

This is a bounded heuristic search, not a proof of the optimal route. Unpainted cells are inferred from the observed grid and absence from the snapshot; this is an exploration assumption, not evidence of radio coverage or guaranteed eligibility. The UI separates enemy and unpainted counts and outlines selected targets in green (dashed for unpainted). Ownership is a targeting signal, not a capture probability. Radio coverage, transmission timing, protection, and game scores are not modeled yet. Repeater coordinates are not treated as coverage predictions. Confirm that the downloaded board corresponds to MeshCore; the payload contains no explicit protocol field.

Directions are a planning sheet, without live navigation, traffic, rerouting, or guaranteed current road restrictions. Detour centers may snap to nearby roads and do not guarantee traversal of the target cell; the actual returned geometry determines the square count.

## Services and privacy

The server listens on loopback only. Trip coordinates are sent to the configured routing provider, which defaults to the public OSRM demonstration service. This service has no availability guarantee; use your own or a supported provider for sustained use. Override its origin with `OSRM_URL`, for example:

```sh
OSRM_URL=http://localhost:5000 python3 server.py
```

Address lookup uses [Photon](https://photon.komoot.io/), which accepts modest usage but may throttle requests and does not guarantee availability. Lookups are explicitly triggered, not performed on every keystroke. Address text is sent to the configured Photon server, while coordinate inputs bypass geocoding. Up to 128 successful query responses are cached in server memory and cleared on restart; addresses are never written to disk by this app. Choose matches carefully, since map coverage and address precision vary. If lookup fails, coordinates and map clicks still work. To use a self-hosted or compatible Photon service:

```sh
PHOTON_URL=http://localhost:2322 python3 server.py
```

Browser assets load from unpkg.com; map tiles load from OpenStreetMap. The application suppresses HTTP access logs and does not persist trips. The board snapshot stays outside the project folder and is not bundled into a hosted site.

## Structure and verification

- `server.py`: local HTTP API and OSRM adapter.
- `planner.py`: geometry intersections, candidate selection, and route ranking.
- `geocoder.py`: Photon integration, response normalization, and bounded in-memory lookup cache.
- `static/`: map, route controls, directions, and print layout.
- `tests/`: deterministic scoring and HTTP-handler tests with mocked routing.
- `docs/meshwars-integration.md`: observed board schema and remaining questions.

Run checks:

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile server.py planner.py geocoder.py
```

Twenty-two automated tests pass, including exploration away from a BLUE-only corridor, unique unpainted counts, budget enforcement, zero-target handling, progress events, streaming errors, disconnected-search termination, address result parsing, query encoding/caching, input validation, lookup failure handling, missed-cell insertion, long straight road sampling, and preservation of the faster route when geometry is duplicated. HTTP handlers are exercised in memory because this development sandbox prevents opening local sockets. Live provider requests and browser rendering have not been verified here; DNS, socket restrictions, and missing Node tooling prevent live preview and Sites packaging/publication.

## References

- [MeshWars rules](https://www.meshwars.com/about)
- [Board schema notes](docs/meshwars-integration.md)
- [OSRM route and maneuver API](https://project-osrm.org/docs/v5.24.0/api/)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
