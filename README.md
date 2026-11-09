# MeshWars Route Planner

A self-hostable Meshtastic route planner with a territory map and printable, MapQuest-style turn-by-turn directions. It prioritizes easy-to-capture enemy squares and unpainted exploration within a maximum extra-driving-time budget.

## Contribution rules for developers and Codex agents

`main` is protected and deploys to the public website automatically. All changes, including documentation and workflow changes, must be made on a feature branch and merged through a GitHub pull request targeting `main`. Do not commit or push directly to `main`, bypass protections, force-push `main`, or delete it.

1. Start from an up-to-date `main` and create a descriptive branch, for example `git switch -c feature/swap-endpoints`.
2. Make focused changes and run the relevant checks. Describe the resulting behavior and validation in the pull request; include screenshots for interface changes and explain scoring changes.
3. Push the feature branch and open a pull request targeting `main`.
4. Both required GitHub Actions checks, `test` and `browser`, must pass. They belong to the **Container checks** workflow; the workflow name itself is not a required-check name. The branch must be up to date with `main` before merging, and review conversations must be resolved.
5. Satisfy the repository's configured review requirements before merging. If an approval is required, obtain it from another reviewer; authors cannot approve their own pull requests. Do not weaken the ruleset to unblock a change.
6. Merge the accepted pull request through GitHub. The push resulting from the merge triggers the production workflow: container tests → production image published to GHCR → Render deployment requested for that exact commit. Check GitHub Actions and Render Events for success; a successful deploy-hook request alone does not confirm a healthy rollout.

The required pre-merge checks are `test` and `browser`, not `publish`: publishing runs after changes reach `main`. Keep the `main` ruleset **Active**, with no bypass entries, force pushes blocked, and branch deletion restricted. GitHub's active ruleset is authoritative for the current approval count; this README does not assume whether zero or one approval was selected.

Agents must preserve these rules and report any access or failing-check blockers rather than pushing directly to `main`. Keep API keys, `.env`, and the Render deploy-hook URL out of commits, pull request text, and logs.

## Deployed app version

The header displays **Version `<12-character Git commit>`**. Hover over it for the full commit and the five most recent merged changes, or tap/click it to open the same notes in a dialog. Refresh after a deployment to see the running build's version; an already-open page does not automatically detect a new deployment. Each merge produces a different version without manually updating a release number.

CI passes the full Git SHA as `APP_REVISION` and recent first-parent commit titles as JSON in `APP_CHANGES` into the production Docker image, independently of the GHCR image tag. Standard GitHub merge commits use their PR title; squash and direct commits use their subject. No Git history is needed in the running container. `/api/version` returns the short `version` and full `revision` with caching disabled. Builds without a valid 40-character commit SHA show **Version development**. Existing images need to be rebuilt and deployed with this change before they can display a version. Do not set fixed `APP_REVISION` or `APP_CHANGES` values in Render's environment, which would override the identity embedded by CI.

## Install as an app (PWA)

The planner and reports can be installed from an HTTPS site, including the Render address, and open in a standalone app window. Chromium browsers show **Install app** in the header when they offer installation; their browser menu may also provide an install action. On iPhone/iPad, open the site in Safari and use **Share → Add to Home Screen**. Installation availability and wording depend on the browser. Local testing works on `localhost`; an ordinary HTTP LAN address is not a secure context for service-worker installation.

The manifest (`/manifest.webmanifest`) defines the app name, standalone display, theme colors, icons, and a Reports shortcut. Shield/radio icons are supplied at 192 and 512 pixels, with a 180-pixel Apple touch icon. The editable source is `static/icons/icon.svg`; developers with the browser test dependencies installed can regenerate the PNGs using `node tests/browser/generate-icons.cjs` from the repository root.

This is an **online app**. Routing, address lookup, live territory, reports, and map tiles need a connection. The service worker caches only a self-contained offline notice, shown when planner/report navigation fails without a network connection after a successful first visit. It does not cache pages, JavaScript, styles, APIs, route results, location inputs, GPX downloads, CDN libraries, or map tiles. Existing saved trips and drive sessions keep their existing browser-storage behavior. Clearing site data removes installation-related caches as well as those existing saved items.

`/sw.js` embeds the production commit SHA, creating a separate offline-notice cache for each deployed build and cleaning up older caches with this app's prefix. Online navigation always uses the network, so refreshing loads the deployed version. Activating an updated worker does not automatically reload an open page or discard a trip in progress. The manifest and worker are served by both Python entry points with caching disabled. Actual installation into iOS/Android home screens still requires a manual device check; browser tests cover manifest/icons, installation prompt handling, worker lifecycle, offline fallback, and reconnection.

## Run locally

Requires Python 3.10+ and an internet connection for address lookup, routing, map tiles, and the Leaflet map library. The local development server uses only the standard library. The hosted entry point and full test suite additionally use the pinned packages in `requirements.txt`.

```sh
cd ~/OTHER_DEV/meshwars-route-planner
python3 server.py
```

Open **http://127.0.0.1:8000**. The server fetches MeshWars immediately and checks for updates every 30 minutes. The browser loads the board initially and checks for changes every 30 minutes. During startup without a board it briefly checks local readiness; those checks do not trigger upstream requests. The **Capture data** panel shows successful checks, errors/fallback status, and a **Refresh now** button.

The existing `../nodes.json` is an optional startup fallback. The latest successfully validated live board is saved atomically in `.cache/board.json` (Git-ignored), and reused on restart. Your original `nodes.json` is not overwritten. The app can start without either file and will enable planning once its first live fetch succeeds.

To use another snapshot or port:

```sh
python3 server.py --board /path/to/nodes.json --port 8080
```

## Container hosting

The portable deployment uses **Flask + Waitress** (`hosting.py`), rather than exposing the development `http.server` entry point. Keep one application process/replica: background feed ownership, provider request pacing, caches, and search admission limits are currently process-local. Python explicitly [does not recommend `http.server` for production](https://docs.python.org/3/library/http.server.html).

Requires Docker Engine with the Compose plugin. Create `.env` from `.env.example` on the host, keeping real credentials out of source control. No API key is required for normal territory planning; FreqMapper observations still need an approved partner key.

```sh
docker compose config --quiet
docker build --target test -t meshwars-route-planner:test .
docker compose up -d --build
```

The default deployment publishes only **http://127.0.0.1:8000** on the Docker host. Use it locally, through an SSH tunnel, or behind an authenticated reverse proxy. It does not publish a public website by itself. `PLANNER_PORT` changes the host port; the internal container port remains 8000. HTTPS is required for device location when using a remote hostname.

The image runs as UID/GID **10001**, has a read-only root filesystem in Compose, drops Linux capabilities, and has bounded memory/CPU/process usage. `/data` is its persistent named volume; `/tmp` is temporary. Docker context allowlisting excludes credentials, personal board snapshots, environment metadata, caches, and Git history. Production images omit tests. Dependencies are pinned; base image tags should be refreshed and rebuilt regularly for security fixes.

At startup, the app reads its last successful board from `/data/board.json`, or optionally a seed at `/data/seed-board.json`, and starts the live feed. Existing local `.cache` files are not automatically migrated into the named volume. With no seed/cache, planning waits for the first successful fetch. Optional radio evidence and cursors use the same volume. Do not share these files between running replicas.

Hosted behavior includes JSON/body-size validation, same-origin POST checks, basic response security headers, and an immediate **429** with `Retry-After` when search capacity is full. The default `MAX_CONCURRENT_SEARCHES=2` shares the configured OSRM worker/rate budget. The browser uses resumable background search jobs and short progress requests; a dropped connection does not cancel its search. Legacy `/api/plan-stream` still streams NDJSON with buffering disabled and keepalives, and only that legacy endpoint cancels on disconnect. Request bodies and personal locations are not written to access logs. The short-lived geocoder cache remains in memory.

### Publish a production image to GitHub Container Registry

The **Publish production image** workflow (`.github/workflows/publish.yml`) runs on pushes to `main`, with an optional manual run on `main`. It tests the container, publishes production images to GHCR, then requests a Render deployment of that exact commit's image. GitHub's built-in `GITHUB_TOKEN` supplies package-write access; local Docker and a personal registry token are unnecessary.

Set up deployment once:

1. In the existing Render image-backed service, open **Settings → Deploy Hook** and copy the secret URL.
2. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**. Name it `RENDER_DEPLOY_HOOK_URL` and paste the URL. Do not commit the hook URL or put it in issue comments or logs.
3. Keep the Render service configured with the image repository `ghcr.io/baconadmiral/meshwars-route-planner`. Its configured tag can remain the current commit tag: the hook overrides it with each newly published `sha-<full-commit-SHA>` tag.
4. Push to `main`, or use **Actions → Publish production image → Run workflow → main**. Watch the GitHub run, then Render's Events page for deployment completion.

The workflow fails clearly if the hook secret is missing. Build/test or image-push failures prevent the deployment request. Publishing is serialized, and each deploy specifies its commit tag instead of relying on `latest`. Tags are immutable by convention; a registry digest provides stronger pinning. A successful hook request means Render accepted or queued deployment, not that startup/readiness has completed. Verify `/healthz`, `/readyz`, feed status, and a route after rollout. The revised automatic deployment has not yet been exercised from this workspace.

Each successful publish produces `ghcr.io/baconadmiral/meshwars-route-planner:latest` and `ghcr.io/baconadmiral/meshwars-route-planner:sha-<full-commit-SHA>`. To roll back, select a previously working commit image in Render and redeploy; subsequent pushes to `main` deploy automatically again.

New GHCR packages are private by default. For anonymous hosting-service pulls, open your GitHub profile's **Packages → meshwars-route-planner → Package settings → Change visibility → Public**. Otherwise configure registry credentials in Render. Runtime secrets such as `MESHWARS_API_KEY` remain in Render's environment settings; the Docker context excludes `.env` and local caches. Publishing does not change package visibility.

### HTTPS and invited-user access

An optional Caddy configuration supplies automatic HTTPS and a password gate. Set `PLANNER_DOMAIN`, `PLANNER_USER`, and `PLANNER_PASSWORD_HASH` in `.env`. Generate a bcrypt hash interactively using Caddy so a real password does not enter shell history:

```sh
docker run --rm -it caddy:2-alpine caddy hash-password
```

Single-quote the hash in `.env` so its `$` characters remain literal. Point the hostname’s DNS to the deployment host and permit inbound TCP ports 80/443. Then the deployment command is:

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

This configuration uses Caddy’s documented [password authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth) and [`flush_interval -1`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) to preserve incremental search updates. Keep the backend’s localhost binding. A host-level proxy can instead target port 8000; a container proxy on the Compose network targets `planner:8000`. Keep both Caddy volumes to preserve certificates. The proxy configuration has been validated, but public DNS, certificate issuance, and a real-host HTTPS deployment have not been performed. Do not disable authentication for an internet-facing deployment without first planning abuse controls and upstream service capacity.

### OpenStreetMap tile access

The hosted responses use `Referrer-Policy: strict-origin-when-cross-origin`. OpenStreetMap [requires a valid browser referrer](https://operations.osmfoundation.org/policies/tiles/); `no-referrer` conflicts with its tile policy and can produce “Access blocked” 403 tiles. External requests receive only the site origin, not page paths or query strings. Do not override this with a referrer-stripping proxy header. Browser privacy extensions can also suppress referrers. Tiles load directly in the browser with its normal HTTP caching; there is no tile scraping or proxy.

After updating a Docker deployment, rebuild/recreate the app and reload its page to pick up the response header. If cached 403 tiles persist, clear this site's cached images/files once. Continued blocking needs investigation of the actual request headers or existing provider restrictions; changing this header does not guarantee an existing block is immediately lifted.

### Operations and remaining hosting decisions

- **Health:** `/healthz` reports application liveness; `/readyz` returns 503 until a board is available. The Docker health check uses liveness, so an upstream outage does not cause restart loops. Monitor readiness and feed freshness separately.
- **Data and secrets:** back up the `planner-data` volume off-host, and the Caddy volumes when used. Stop the application for a consistent volume snapshot. Keep the `.env`/secret-manager backup separate and restricted. A normal Compose shutdown preserves volumes; avoid `down -v` for real deployments.
- **Updates:** run the container tests, rebuild with refreshed base images, and recreate the service. Retain a known-good image tag for rollback. Container checks run on pushes and pull requests; the publishing workflow tests/pushes production images to GHCR on `main` and requests deployment through the configured Render hook.
- **External services:** configure `OSRM_URL`, `OSRM_WORKERS`, `OSRM_REQUEST_INTERVAL`, and `PHOTON_URL` for a provider suitable for your usage. Public demo services are the development defaults, not a promised production capacity or SLA. Map tiles and Leaflet/QR libraries also require external network access; library versions are fixed in the page but remain CDN-hosted.
- **Public launch:** choose the host/domain, authentication approach, uptime/freshness monitoring, backup destination, and routing/geocoding capacity. Anonymous public access additionally needs per-user/IP quotas and stronger abuse controls. Horizontal scaling needs shared admission/rate limits and one feed/cache owner first.

Validation performed here: production image build; 117 tests inside the image; actual Waitress socket startup, health/readiness, incremental route output, cache persistence, and SIGTERM shutdown against local deterministic providers; hardened Compose startup, volume persistence across restart, and Caddy configuration validation. No real domain or cloud account was modified, and no image was pushed to a registry.

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

The existing board payload has no player names. The optional integration reads the documented [`/api/v1/captures`](https://meshwars.com/api#captures) endpoint for Meshtastic, using a server-side `MESHWARS_API_KEY`. Obtain a read-only integration key from the MeshWars operator, configure it in your local environment, and restart `python3 server.py`. Do not put the key in frontend code, version control, or this chat. `MESHWARS_API_URL` overrides the API base if needed. For Docker Compose, set `MESHWARS_API_KEY` in your ignored `.env` file and run `docker compose up -d --build` to recreate the container with the token. Compose passes it to the backend only. This enables the existing attribution adapter; a per-drive session report is not implemented yet.

Attribution refreshes alongside the board. Events are joined only when both owner team and capture timestamp exactly match the current square. This identifies the last matching capturer, not everyone who ever visited or defended the square. Names and the cursor are cached in Git-ignored `.cache/capture_users.json`; the key is never cached or returned to the browser. Missing/failed attribution does not stop normal board updates.

Coverage is partial: the initial request reads at most 500 recent events; later polls accumulate the latest observed event per square. Older or missed events remain Unknown. The app does not guess names from teams or claim complete historical player coverage. An expired/rejected key is recorded in board attribution metadata.

## Plan a drive

1. Select **Your team** (BLUE by default), then set A and B. Enter an **address or place name**, choose **Find address**, hover over or keyboard-focus a result to preview its pin on the map, and select the correct match. The map pans to an offscreen preview and zooms to street level when needed. A preview does not select a stop or verify road access; check access for places such as airport terminals, garages, and restricted facilities. Include city and state or ZIP code to narrow the results. You can also enter **latitude, longitude** or click the map to set A and B. Mix addresses and coordinates freely. A third map click starts a new pair. Submitting an unresolved address also performs lookup and asks you to choose a match before routing. Editing a selected address clears its saved location.
2. Optionally add ordered manual waypoints using **Add waypoint** or **Pick on map**. Then set the maximum additional driving time, from 0 to 120 minutes. Choose **Beam search** (default), **Greedy** (the previous method), or **Compare beam vs. greedy**.
3. Choose **Find [your team] opportunities**. A live progress bar shows the search stage and completed detours, with elapsed time and time since the last server update. Slow provider requests display a waiting message. Percentages represent search work, not estimated time remaining. The search may take several minutes if routing requests time out. Use **Cancel search** to stop; a request already sent to the provider may take until its timeout to release the server task.
4. Compare up to six beam route options (up to three for greedy), the fastest-route baseline, and numbered directions. In Compare mode, a table shows each method’s weighted value, raw target count, driving time, and refinement checks. Use **Show route** to switch the map and directions without rerunning the search.
5. Print the selected directions or download its GeoJSON line geometry.

Use **Dark mode** in the header to toggle the interface and basemap appearance. The initial theme follows your system preference; an explicit choice is remembered in this browser. Only the basemap is filtered, preserving route and team colors. Printing uses the light theme.

The route plan and divider stay hidden until a search returns routes, giving the map the full workspace initially. In Compare mode the plan remains available if either method has routes. The saved split is restored when the plan appears.

Drag the **Map / route plan** divider up or down to change the panel sizes. The sidebar and route plan scroll independently on desktop, keeping the map visible. Your split is remembered in this browser. Focus the divider and use Up/Down arrows (Shift for larger steps), Home/End for minimum/maximum map size, or double-click to reset. Touch dragging is supported. Printed directions use a fixed map height and expand the full route plan.

The map shows team-colored cells with score-based faint-to-bold fills, visually capped at 3 points; hover to see the full holding score and recorded capture time. Missing scores are labeled unknown. Cells are drawn when fewer than 2,501 known squares are in view; zoom in if territory is hidden. Gray indicates the fastest baseline, and blue indicates the selected route.

## Mobile progress and reconnectable searches

On phone-sized screens (up to 800 px wide), starting route planning scrolls to the map and opens a compact progress dialog. Its decorative animation is reduced in height, and Cancel has a touch-sized button. When the search finishes, the dialog and progress box close automatically and the map/route panel is brought into view. Desktop searches keep the map progress control while running and hide it on completion too. Address-lookup-only requests retain their existing progress behavior.

After the server accepts a route request, it runs independently of the browser's connection. Locking the screen, switching apps, or losing connectivity does not cancel it. Returning to the page retrieves its latest progress or completed route. If the browser reloads the same tab, its pending token, endpoint labels, and form settings are restored from **session storage**, and it reconnects to the same job. Retrying a creation request after a lost response uses the same token instead of launching duplicate work. Address resolution and interactive match selection still happen before a route job starts.

**Cancel search** (or Escape in the mobile dialog) explicitly cancels the job at its next progress checkpoint. Already-issued routing calls can finish or time out first. If cancellation cannot reach the server, its intent remains in session storage and is retried when connectivity returns, even if a subsequent search has started.

Both Python entry points expose `POST /api/searches/<token>` to create/retry a job, `GET /api/searches/<token>` for progress/results, and `POST /api/searches/<token>/cancel` for explicit cancellation. Tokens are random 256-bit capabilities generated by the browser; there is no public job list. Keep them private. The production job pool shares the existing search-capacity limit with the legacy synchronous/streaming endpoints. The development job pool allows two concurrent background searches.

Jobs and route results are retained **in server memory**, not on disk: finished jobs expire after 30 minutes, and the bounded 16-record store can evict older finished jobs sooner under load. A retained result is limited to 8 MiB. Running jobs have a 30-minute limit, checked at progress/result checkpoints. A server restart or deployment loses pending jobs and retained results; the browser reports an expired/restarted search and asks for a new plan. Keep one instance, as the job store and capacity limits are process-local. Closing the tab or blocking session storage can prevent recovery of its token, although a started job continues until it completes or reaches its limit. The PWA service worker continues to leave these APIs uncached.

Validation includes a hidden/frozen Chromium tab, a lost creation response, restored form state after reload, explicit cancellation, mobile dialog cleanup, route visibility, and desktop progress cleanup. Actual OS screen-lock behavior still needs a phone check after deployment.

## Navigate and transfer to a phone

After selecting a route, choose **Navigate / send to phone** to open a centered QR and sharing dialog. Close it with **Close ×**, Escape, or a click outside the dialog; focus returns to the navigation button. Each navigation section has **Open Google Maps**, a camera-scannable QR code, **Copy link**, and (when supported by the browser) a native **Share link** button. Scan a QR from the desktop to open its Google Maps URL directly on your phone: the phone does not need access to the local Python server, and no route-hosting service or email is required. QR codes are generated in the browser with a CDN-loaded QR library; coordinates are not sent to a QR-image service.

The dialog opens on **Route preview**. A separate map shows the complete planned road geometry and numbered pins for the exact coordinates exported to Google Maps. Gaps longer than 2 km along the planned track are highlighted with amber dashes; select a gap to zoom to it, or choose **Fit whole route**. This threshold is a visual review aid, not a prediction of Google’s road choices: even shorter gaps can be rerouted. Stops are matched to the road track in trip order to estimate gap distances; off-road stops retain their original exported coordinates and may snap differently in Google. The preview shows how many intermediate stops and QR sections will be sent. Choose **QR & sharing** when ready. This preview does not fetch or compare Google’s actual calculated geometry, and it does not add automatic anchors.

All manual and exploration stops are retained in order. Exports target the Google Maps app on Android and iPhone: drives with up to nine intermediate stops use one link and QR code. Longer drives split into sections with at most nine intermediate stops per link. Mobile browsers support only three intermediate stops, so open the link in the Google Maps app to retain the full stop list. Sections overlap at their boundary stop. Use **Copy all navigation links** or **Share all links** to transfer the complete ordered list before leaving, then open sections in sequence. Google Maps can open a preview rather than immediately start navigation depending on the device/location; review it and start when ready. [Google Maps URL documentation](https://developers.google.com/maps/documentation/urls/get-started).

Google recalculates roads between the stops and may skip planned capture streets. For the complete geometry, use **Download GPX track**. The GPX retains every route coordinate and stop, without simplifying the track. It contains no spoken maneuver instructions; import it into an app that supports following GPX tracks and review that app’s handling of the track. Google Maps does not import a GPX track through these direction links.

**GPX for OsmAnd → Create GPX download QR** creates an expiring download URL for the full GPX track, with QR, copy-link, native link sharing, and download controls. Scan it on the phone, download the file, then use **Share → OsmAnd** to import it. It is not a direct OsmAnd navigation deep link. The QR contains a URL, not embedded track data, so your phone must be able to reach the planner’s current address. A localhost-only address will not work from a phone; the interface explicitly labels that condition. No LAN/public binding is enabled automatically by this feature. Once the planner is hosted at a reachable address, links use that same origin automatically. Existing proxy authentication still applies to downloads.

GPX links are created only when you choose the button. They expire after one hour or a server restart and are stored in memory only, with random 192-bit tokens. Anyone holding a link can download that route while it is valid, subject to the site’s login gate. Downloads disable caching and referrers. Storage is bounded to 100 links / 32 MiB total / 8 MiB per file; capacity errors leave existing links valid. Expired or missing links return 404. Both `python3 server.py` and the container’s hosted API support the same feature. Links are process-local, consistent with the deployment’s single-replica requirement. Creating a new link does not revoke older unexpired links. The plain file download remains available without creating a link.

**Share GPX file** appears when the browser supports sharing that file type. Otherwise download it and transfer it using AirDrop, Quick Share, your usual file/cloud app, or email. Native sharing targets depend on your device; no messages or emails are sent automatically. Browser/device handoff and QR scanning have not been verified in this sandbox. If the QR library cannot load, copy/share links remain available.

## Guide exploration with manual waypoints

Add up to eight mandatory stops between A and B. Each accepts an address or coordinates, or use **Pick on map** to create a stop with the next map click. Existing rows have a **Map** button to reposition them. Use the arrows to reorder stops and **Remove** to delete one. Press Escape to cancel a pending map pick. Markers and printed directions identify them as W1, W2, etc.

For example, place W1 west of your start and W2 farther along the western area before your destination. Every baseline, initial detour, and beam/greedy candidate must include those stops in order. The optimizer can insert exploration stops between them but cannot discard or reorder your manual stops. Broad exploration candidates are generated around each required leg, sharing a maximum of 16 initial requests instead of multiplying requests for every leg.

The time budget is relative to the fastest route **through all manual waypoints**. If that drive takes 30 minutes and you permit 15 extra minutes, results must fit within 45 minutes. An unreachable required route returns an error rather than silently dropping a stop. The map is intended to guide regional exploration; waypoints do not establish radio coverage or forbid every road outside a region. Routing providers may snap the chosen coordinates to nearby roads. Edit stops and run a new search to update an existing plan.

## Find your current location

Choose **My location** below the map zoom buttons to center the map on your device at street level. Allow the browser’s location request; a dot marks the reported position and a circle shows its accuracy. This is a one-time lookup on each click and does not change your route endpoints. Device location requires HTTPS or localhost.

## Limit driving to a drawn area

Choose **Draw box on map**, then click or tap two opposite corners around the area you want to drive in. A preview follows the pointer after the first corner; the finished area has an amber dashed outline. Choose **Cancel drawing** or press Escape to abandon a drawing, draw another box to replace it, or choose **Clear box** to remove the constraint. For an irregular area, choose **Draw freeform area**, click or tap corners along its boundary, then right-click on the map or choose **Finish shape**. Right-click finishes using the corners already placed; it does not add another corner. **Undo corner** removes the last corner. The server validates the shape before applying it; crossing edges, overlapping edges, holes, repeated corners, and empty shapes are rejected. Use 3–100 corners. Escape or the active drawing button cancels without changing the previous area. Switching drawing modes starts a new draft. Changing the area clears previous search results. One box or polygon is active at a time; these shapes reflect your own coverage knowledge and do not establish radio coverage.

Start, destination, and all manual stops must be inside the selected area. Before routing starts, the app checks the resolved coordinates, lists each outside stop (A, B, W1, etc.), highlights its input, and focuses the first invalid field. The same check is enforced server-side for direct API requests. The server rejects every provider route whose road geometry leaves it, including initial alternatives and refinement routes. Boundaries are included. Boxes use vertex containment; concave polygons additionally split each road segment at boundary intersections and check the intervals, preventing shortcuts through excluded indentations even when both road vertices are inside. No outside detours are requested. Both search strategies and their comparison share the constraint. The time budget is relative to the fastest *returned route that remains inside* the area.

The routing provider does not accept the shape as a road-avoidance rule: we filter its returned routes. If it returns no contained baseline, the app reports an error; enlarge/clear the shape or add guiding waypoints. A valid contained route can exist without the provider returning it. The selected box or GeoJSON Polygon is included in `allowed_bounds` in the result and GeoJSON metadata. Google Maps navigation can recalculate outside the area, so inspect its preview; the GPX preserves the constrained planned track.

## Radio coverage evidence (optional)

The **Show FreqMapper observations** map toggle displays independent verified transmit observations in green and passive receive observations as purple rings. These are measured points, not continuous road coverage. Zoom in when more than 2,000 observations are in view. The source status shows freshness, incomplete history, and refresh failures independently from the MeshWars board.

Each route and the fastest baseline receive an evidence breakdown. A square counts only when it contains an observation within 50 metres of the actual route geometry. Multiple observations count once per square; verified TX takes precedence over RX-only evidence. Counts are also reported for target squares separately. These are historical observations, not capture probabilities or proof that the whole square is covered. Route scores, budgets, and ranking remain unchanged. GeoJSON exports include the selected route’s evidence counts.

Live evidence requires an approved FreqMapper partner key. Set `FREQMAPPER_PARTNER_TOKEN` in the server environment and optionally `FREQMAPPER_REGION` (default `SLC`), then restart the server. Keep the key server-side; never paste it into browser code, URLs, version control, or chat. Without a key, the feature shows the source as disconnected and labels coverage unknown.

`radio_coverage.py` uses only the documented production [combined partner feed](https://help.freqmapper.net/verified-coverage-api/), with explicitly typed `verified_tx` and `passive_rx` records. It does not scrape browser tiles. The feed excludes failed, pending, not-heard tests, and ordinary Position Packet coverage. Empty responses and missing evidence never imply failure. Consequently there is no red/not-heard overlay or reliability-based route weighting yet. Those require a supported negative-evidence source.

The adapter checks at startup and every 30 minutes, importing up to four pages of 1,000 events per check. Initial history may require several checks. It saves each complete page and cursor atomically in Git-ignored `.cache/radio_coverage.json`, retaining observations and their event time but stripping radio/participant identifiers and never storing the key. Region changes do not reuse another region’s cache. Access/configuration errors (401/403/404/422) pause automatic requests until restart after configuration is corrected; rate-limit retry delays are respected. Other failures retain previous evidence and mark it stale. Cache size is bounded at 100,000 observations; reaching that limit reports an error instead of silently discarding history.

Searches pin the radio-evidence snapshot at their start and annotate results consistently across both strategies. `/api/radio-coverage` supplies evidence and availability metadata to the local UI. Browser startup may check this local endpoint briefly while the first import completes; these checks do not trigger upstream requests. No partner key or live integration was used in automated validation.

The selected navigation line uses a contrasting color rather than your team color (yellow for BLUE, cyan for RED/ORANGE/PINK, magenta for GREEN/YELLOW, and yellow for PURPLE), with a dark outline for readability over square fills and both map themes. The handoff preview uses the same route color; numbered export pins retain the team color.

## Clear a route or hide captured squares

**Clear route**, beside the navigation and GeoJSON buttons, removes route lines, target outlines, bonus-place markers, comparison results, directions, and completed progress. Start/destination/waypoint inputs, the drawn area, and scoring/display settings remain available for another search. The button is disabled during a running search; cancel the search first.

**Hide captured squares** in the sidebar toggles all teams’ owned-square fills and captured-square target outlines. The route and unpainted target outlines remain visible, subject to existing display filters. The button changes to **Show captured squares** to restore the layer and the choice persists in this browser. This only changes display: scoreboard totals and route scoring continue to use the full board.

## Territory reports

Open **Reports** in the header, or visit `/reports`, for a 30-day graph and daily table of territory points across all seven Meshtastic teams. The window includes today and the preceding 29 UTC calendar days. Toggle chart teams independently; the table and summary retain all teams. Hover or keyboard-focus a point to inspect its value. On phones, the chart and table scroll horizontally inside their panels.

Each point represents one **currently held square**, attributed to its current owner and grouped by its last capture timestamp, matching the capture-age filter's basis. It is not full capture-event history, cumulative points, or net territory gained: squares subsequently lost are absent, and repeated historical captures are not reconstructed. Check-in, exploration, and defense bonuses are excluded. Missing, invalid, or future capture timestamps are counted as exclusions, and today is labeled incomplete. The documented [capture API](https://meshwars.com/api#captures) supplies only a limited recent feed without historical pagination, so it cannot establish a complete 30-day gain history.

`GET /api/reports/territory` aggregates the shared cached board without new upstream requests. The page shows board freshness and excluded timestamp counts, preserves the previous report on refresh failure, and shows unavailable data separately from a valid zero-activity report. Refreshing uses the latest board already held by the server; the normal background feed controls its upstream freshness. Team/player/age filters from the map do not affect the standalone report.

## Team scores and color filters

The strip below the header shows **total points** and **squares currently held** for each team, ranked by total points. Total points come from MeshWars’ public Meshtastic scoreboard (`https://meshwars.com/scores`) and include territory, check-in, and exploration points. Hover a card for the breakdown. Squares held are current territory, not a count of all historical capture events; the board does not contain per-team lifetime capture counts. Per-square defense scores are not summed into this total.

Click a team card to show only that team’s squares and target outlines. Click the same card again, or **All teams**, to clear the filter. The color filter combines with capture-age filtering. It does not change your planning team, route scoring, or the scoreboard totals. Your planning team and the active display filter have separate highlights. The strip uses the full board/scoreboard, regardless of map zoom.

`team_scores.py` refreshes the scoreboard alongside the board on the existing 30-minute schedule, and on an explicit board refresh, without per-browser upstream polling. Last-good scores persist in `.cache/team_scores.json` (or the hosted `/data` directory). Cached or failed refreshes are labeled. If scores have never loaded, points remain **—**, while squares held can still come from the board. Hover the source note for score freshness. The public `/scores` route is the website’s own endpoint, not the versioned integration contract; responses are validated and schema/network failures retain previous totals. `MESHWARS_SCORES_URL` can override a compatible endpoint.

## Choose your team

Use **Your team** above the start address to select BLUE (the default), RED, GREEN, PURPLE, YELLOW, ORANGE, or PINK. Your team’s territory is excluded from enemy targets throughout exploration, refinement, and scoring. Other teams are scored using the current owner’s score. Changing teams clears the previous plan; run a new search. Route colors, labels, GeoJSON, and GPX exports reflect the selected team.

## Place bonuses in route weighting

**Places Worth Going** is enabled by default. The planner loads this week’s active summits, parks, and landmarks from MeshWars’ public `/api/places` feed once per search area, explicitly for the Meshtastic board. Responses are cached in memory for 30 minutes (up to eight areas); searches share the same pinned place data across beam and greedy. No player key or personal visit history is fetched. The source list can be truncated, and its public geometry is intended for display; the UI identifies bonus scoring as an estimate. The endpoint is the website’s own evolving interface, so malformed/unavailable data falls back to territory-only ranking, or same-week cached data.

The objective is **territory priority + bonus weight × estimated place points**. The default weight is 1 and can be set from 0 to 5. Estimated place points are capped by **Weekly place points remaining** (0–100, default 100). Bonus opportunities influence initial detours, refinements, and final ranking; a route through friendly territory can still be useful for places. The same road-time budget, mandatory stops, box/polygon containment, request limits, and beam diversity checks continue to apply. Initial discovery reserves up to eight of its sixteen requests for place candidates. Returned road geometry, rather than the requested point, determines whether an estimated scoring area was crossed.

Following the game’s [place rules](https://meshwars.com/rules), only the highest-value eligible place on a square can count. The planner uses the game’s published tie-break formula, counts each place once per route, and applies the remaining weekly cap. Mark a place **Already visited this week** in its map popup or route results; a used higher-value place still blocks lower-value overlaps. Settings changes require a new search rather than silently changing an existing result. Visit marks and remaining budget apply only to this browser session and are not confirmed game history. On a new scoring week (Wednesday, Mountain time), previously tagged settings are reset to an assumed 100 points remaining; check that value against your actual activity before planning. Most-recent claiming team is not treated as your personal visit status.

Eligibility estimates deliberately avoid broad proximity claims:

- **Landmarks and rotating small parks:** their point’s grid cell and its eight neighbors.
- **Boundary-backed parks/forests:** public boundary cells plus one neighboring ring, including hole boundaries. Deep interiors and entire bounding boxes are not rewarded. The game can also allow an interior boundary band; our simplified-outline estimate can miss valid cells or differ near boundaries.
- **Summits:** only the peak’s own grid cell. The public feed does not provide the elevation-qualified neighboring cells, so a road below or near a summit does not receive its bonus just for being within 1.5 km.
- **Other parks without a returned boundary:** if their point-based eligibility cannot be distinguished from a missing large-park outline, no bonus is guessed.

Routes show estimated place points separately from territory priority, plus names/types of potential places. Place markers appear after a search, independently of team-color square filters. GeoJSON includes the bonus estimate and matched places. These are potential points, not awarded points: prior visits, weekly usage, actual scoring pings, coverage, current game eligibility, and road access can prevent a payout. There is no live terrain/altitude verification. Trip query envelopes above five degrees, oversized source responses, or excessive geometry are bounded rather than scanned globally; incomplete results are indicated. Use `MESHWARS_PLACES_URL` only for a compatible source.

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

Browser assets load from unpkg.com; map tiles load from OpenStreetMap. The application suppresses HTTP access logs. Pending search requests and form context use per-tab browser session storage, saved trips and drive sessions use browser storage, and resumable job results have bounded server-memory retention described above. The optional seed snapshot stays outside the project folder; the live fallback cache stays in Git-ignored `.cache/`. Board data is not bundled into version control.

## Structure and verification

- `server.py`: local development HTTP API, shared input validation, and OSRM adapter.
- `hosting.py`: production Flask API, Waitress lifecycle, and bounded streaming searches.
- `Dockerfile`, `compose*.yaml`, `deploy/Caddyfile`: portable runtime, persistent storage, and optional authenticated HTTPS.
- `board_feed.py`: background board polling, validation, conditional requests, and durable fallback cache.
- `capture_users.py`: optional authenticated capture-event polling and conservative player attribution.
- `route_bounds.py`: validated WGS84 boxes and simple polygons, including concave road-segment containment.
- `radio_coverage.py`: supported FreqMapper partner evidence, durable cursors, and route evidence counts.
- `places.py`: active-place adapter, bounded cache, conservative bonus areas, overlap/cap handling, and detour proposals.
- `team_scores.py`: validated Meshtastic team totals and last-good scoreboard cache.
- `teams.py`: supported teams and shared input validation.
- `gpx_shares.py`: bounded, expiring in-memory GPX download links.
- `navigation.py`: mobile-compatible Google Maps sections and complete GPX track serialization.
- `planner.py`: geometry intersections, candidate selection, and route ranking.
- `geocoder.py`: Photon integration, response normalization, and bounded in-memory lookup cache.
- `static/`: map, route controls, directions, and print layout.
- `tests/`: deterministic scoring and HTTP-handler tests with mocked routing.
- `docs/meshwars-integration.md`: observed board schema and remaining questions.

Run the full checks using the tested Docker build above. With `requirements.txt` installed, the equivalent Python checks are:

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile server.py planner.py geocoder.py board_feed.py capture_users.py navigation.py teams.py radio_coverage.py route_bounds.py hosting.py gpx_shares.py team_scores.py places.py
```

Automated tests cover exploration away from a BLUE-only corridor, unique unpainted counts, budget enforcement, zero-target handling, progress events, streaming errors, disconnected-search termination, address result parsing, query encoding/caching, input validation, lookup failure handling, missed-cell insertion, long straight road sampling, preservation of the faster route when geometry is duplicated, beam search escaping a greedy local optimum, shared-request reuse, beam request limits, bounded concurrency, serial/parallel result equivalence, in-flight deduplication, partial batch failures, provider request spacing, owner-score thresholds, missing/invalid scores, low-score targets outranking larger groups of 50-point squares, live-feed updates, conditional responses, failure fallback, cache persistence, manual refresh throttling, pinned search revisions, exact player/event matching, attribution caching, cursor replay, rejected-key fallback, ordered waypoint preservation in every provider request, constrained baseline budgets, repeated stops, invalid/unreachable waypoint handling, navigation section continuity, waypoint/URL limits, GPX coordinate retention and XML escaping, and the route-export endpoint. HTTP handlers are exercised in memory. The hosted runtime also has a real socket smoke test in the Docker test stage, using only local deterministic providers. The sharing dialog has also been rendered and tested in Chromium using mocked tiles and providers. Real OSRM/Photon calls, on-device navigation handoff, and an externally hosted deployment have not been verified.

### Browser handoff regression checks

The test-only project in `tests/browser` uses pinned Playwright, Leaflet, and QR libraries. It loads the real UI in Chromium with fully mocked APIs and tiles; it makes no requests to OSM, MeshWars, or routing providers. It covers no area, a box, a polygon, a mobile viewport, preview failure fallback, place markers and visited-place controls, Maps QR rendering, GPX QR creation, and closing/reopening the dialog. The fixture is a synthetic route. Browser dependencies and screenshots are excluded from production images.

Use the matching `mcr.microsoft.com/playwright:v1.64.1-noble` test image with this repository mounted at `/app`, working directory `/app/tests/browser`, then run `npm ci --ignore-scripts` and `npm test`. The same checks run in the GitHub Actions browser job. A screenshot is written to `tests/browser/test-results/handoff-preview.png` (Git-ignored).

## References

- [MeshWars rules](https://www.meshwars.com/about)
- [Board schema notes](docs/meshwars-integration.md)
- [OSRM route and maneuver API](https://project-osrm.org/docs/v5.24.0/api/)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)

A deterministic mocked-road regression demonstrates greedy collecting 4 target squares while beam collects 9 under the same driving-time cap. This verifies branching behavior, not expected improvement on live roads. Live comparisons require running Compare mode on your machine.

### Saved trips and route value

Use **Saved trips** to store up to 30 named trip setups in this browser. Trips include entered locations and selected address coordinates, ordered waypoints, team, box or polygon, driving budget, strategy, and place bonus settings. Choose a trip to load, update, or delete it; select the empty option to save a new trip. Loading clears the displayed route and requires a fresh search. Saved trips contain locations, remain on this browser/device, and are removed when its site data is cleared. Review weekly place points remaining when reusing a trip.

Each selected route includes a territory priority breakdown: easy enemy squares contribute 1 each, defended enemy squares contribute 1 / owner score², unknown enemy scores contribute 0.5, and unpainted exploration squares contribute 1. Friendly squares contribute no territory priority. Each square counts once. Estimated place points, after visited-place exclusions and the weekly cap, are multiplied by the selected bonus weight and added to territory priority. This ranks route opportunities; it is not a prediction of game points or confirmed captures.

### Drive capture reports

Set `MESHWARS_API_KEY` in the ignored host `.env` file, optionally set `MESHWARS_PLAYER_NAME` and `MESHWARS_NODE_ID`, and recreate the container. The token is sent only from the server to the documented MeshWars API. **Track a drive** verifies the player and registered node on the Meshtastic board, then records a server start time. End the drive upon arrival and refresh the report later for delayed events. Session timestamps, identity, the latest report, and up to 20 previous sessions remain in browser storage; JSON reports can be downloaded. The page does not record GPS or need to remain open during a drive. A forgotten session cannot exceed 24 hours; report windows must be within 30 days.

Reports count unique captured squares and capture events attributed to that player during `[start, end)`, including unclaimed captures and captures from opponents. The API attributes captures to players across all registered radios, not individual nodes. Up to 500 recent global events are available per request; reaching the limit explicitly marks the result as potentially incomplete. Reports are cached for 30 seconds. No claim of a final complete capture history is made because delayed reports can arrive later. Place awards, defense points, and total earned points remain unavailable rather than being guessed from routes or team-score differences. Capture attribution also uses the Meshtastic board. No live token acceptance has been verified by the automated tests.

### Captured by player filter

With `MESHWARS_API_KEY` configured, the server loads the registered Meshtastic roster from `/api/v1/players`, caching it for 30 minutes. **Captured by player** combines with team, capture age, and hidden-square display settings; route scoring and team totals are unchanged. Tooltips show the confirmed capturer or Unknown. Names are joined only when the capture event's owner team and timestamp match the current square. This identifies the last confirmed capturer, not everyone who visited or defended it. The event history remains partial: initially only 500 recent global events are available, with subsequent board refreshes accumulating attribution. Old MeshCore/unlabelled attribution caches are discarded. An unavailable roster retains known attributed names and a warning; no guesses are made about Unknown squares.

### Authenticated square data

When `MESHWARS_API_KEY` is set, board refreshes use `/api/v1/board?board=meshtastic`. The live bulk API currently omits defense scores and capture timestamps, so `/get-nodes` supplements those fields only when owner, last-report timestamp, and bounds agree. The token is never forwarded to the public supplementary endpoint. Missing or unsynchronized scores remain unknown and a data warning is shown. API errors retain the last good board; an unavailable score supplement still allows the authenticated board to load.

Click a displayed square to request `/api/v1/cells/{cell_id}?board=meshtastic` through the local backend. Its richer recent-capture history can identify capturers older than the global 500-event window. A name is accepted only when `by_team` and `ts` match current ownership and `captured_at`; defenders or older owners are not substituted. Confirmed names update the map and player filter. Detail results and extra attribution are held in bounded 512-cell memory caches; detail responses expire after 5 minutes. Attribution is reapplied after board refreshes only while the ownership event still matches. Unknown names remain possible when upstream history lacks a matching event. Requests are made on click, not for every square on startup.

Capturer details now load automatically for the visible map area, including squares hidden by the selected player filter. Names and tooltips update as results arrive, with progress shown beside the player filter. Requests run sequentially and uncached square calls share server pacing of at least 1.1 seconds, leaving headroom below the documented API limit. Changing the viewport reprioritizes lookups; hidden tabs pause new requests. Unmatched or nameless results are remembered for 30 minutes in the browser to avoid repeat loops, and failures back off for one minute. Initial lookups are progressive rather than instantaneous. The existing click popup remains available for full details. A hard browser reload retains server-cached lookup results and learned attribution while the server is running.

Automatic square lookups default to zoom **15 or closer**, with a browser-saved threshold adjustable from the map. No detail requests are scheduled at wider zooms. At a qualifying zoom, only current-view squares are considered, prioritized nearest the map center. Panning or zooming cancels the pending timer and recomputes the view after movement stops; an already-sent request may still complete. Both known and unknown capturers are eligible for a refresh after **5 minutes**, matching the server detail-cache lifetime. The status explains when zoom or density prevents loading.

The map now displays its current zoom alongside the active detail threshold. **Use this zoom for details** saves the current zoom (13–19) as that browser's threshold, so the desired map scale can be chosen visually. The default remains 15. The previous 60-square cutoff is removed: a large viewport is no longer silently blocked. Requests still consider only the current viewport, run sequentially with server pacing, and refresh cached details after five minutes. Zooming out below the saved threshold pauses automatic details.

A square being refreshed displays a cyan animated outline with a dark halo and a “Refreshing…” label. It appears for automatic lookups and clicked detail requests, survives normal territory redraws, and clears on success or error. Overlapping requests for the same square share the indicator until both finish. Reduced-motion preferences disable animation.

**Temporary status:** automatic per-square detail refresh is disabled (`automaticSquareRefreshEnabled=false` in `static/app.js`). Zoom and viewport changes no longer schedule square-detail requests; the threshold control is hidden. Click-to-view API details and its refresh indicator remain available. Normal board, roster, and capture-event refreshes continue.

### Sidebar navigation

The sidebar prioritizes team selection, loading saved trips, and creating a route. Start, destination, extra-time budget and Search remain visible. Waypoints, route area, place bonuses and search strategy expand individually. Saving/managing trips is expandable under the always-visible saved-trip loader. Map display/filter controls, drive tracking, data/coverage and guidance are collapsed secondary sections. Plan/Saved/Map/Drive/Data shortcuts open and scroll to their sections. Loading waypoint trips reveals their stops; validation reveals hidden invalid controls. An active drive reopens its tracking section after reload. These layout changes do not reset settings or alter scoring.

The frequently used **Captured in last** slider stays visible directly below team selection, separate from the expandable map display controls. It remains a display filter; route scoring still uses the full board.

### Standard routes and wild loops

For beam searches with extra driving time, the first three options come from the existing search unchanged. A separate bounded search adds up to three **Wild routes**, probing departures away from the destination, left/right loops, and excursions beyond the destination before returning. Twelve probes cover three distances proportional to the extra-time allowance. Candidate generation uses a conservative 8 m/s estimate; actual routed duration enforces the hard budget. Required waypoints retain their order, and both stops and complete road geometry must remain inside any selected area.

Wild routes must introduce a target square or bonus place beyond the standard options and differ by at least 35% of crossed-square footprint from every retained route. Selection balances capture priority, geographic difference and budget use; it does not add game points for driving longer. Duplicate or infeasible loops are omitted rather than padding the list to six. Cards label the wild routes and show their direction and percentage of the extra-time budget used. Larger budgets expand loop reach; they are not minimum time requirements. Directional probes are deterministic rather than unseeded random choices, keeping repeat searches and tests reproducible. Greedy and zero-extra-time searches retain their existing behavior.

This adds at most 12 routing probes beyond the existing beam search's 72 local refinement requests and up to 16 shared initial detours (101 provider calls including the baseline in the worst case). Compare mode reuses matching requests as before.

### Blocked road sections

Expand **Route area → Blocked roads**, select **Mark road on map**, and click 2–20 points along the inaccessible section. Right-click or choose Finish to commit the red mark; Escape cancels. Up to ten sections can be saved, removed individually or cleared. Saved trips preserve the marks. A fixed 20-meter buffer on each side is excluded, including any nearby crossing inside that buffer; draw tightly along the intended road. This is a geographic corridor, not a road-ID closure, so overpasses are not distinguished by elevation.

Stops on blocked corridors are rejected before routing. Every proposed route, including standard and wild alternatives, is checked over its full geometry against all marks and the allowed area. If all initial baseline routes are blocked, the planner tries up to 12 bypass requests while preserving waypoint order. The fastest accessible baseline found sets the extra-time budget; this does not guarantee the globally fastest bypass. When no checked bypass works, the search returns an error asking for a guiding waypoint or adjusted marks rather than returning a blocked path. Ordinary candidate searches do not recursively launch bypass searches. Provider-call metrics include the additional baseline probes.

Google Maps may recalculate through a blocked section between exported stops; check its preview. A GPX export retains the checked planned geometry. Automated fixtures cover blocked crossings, buffers, named stop errors, provider alternatives, bounded bypass failure, waypoint order, budget/boundary enforcement, both hosted endpoints, and browser drawing/saving/removal. Live road-network bypass behavior has not been verified.

### Field-command theme

The interface uses a tactical field-command visual theme: olive/charcoal in dark mode, field-paper neutrals in light mode, a radio-shield insignia, subtle sidebar grid, compact monospace labels, patrol/wide-sweep route cards and a tactical map badge. Team colors and contrasting navigation lines retain their meaning. Mission/patrol wording is presentation only; route calculations, capture rules and controls are unchanged. No external fonts or bitmap assets are required.

### Mission modes

The main sidebar offers six objectives, saved with each trip. The interface defaults to **Offensive Strike**; API requests omitting `mission_mode` retain the original `balanced` objective for compatibility. All modes obey the same actual road-duration budget, required waypoint order, allowed area and blocked-road constraints. Beam searches keep the three standard plus up to three wild alternatives; mode scoring applies to both.

| Mode (`mission_mode`) | Ranking policy |
| --- | --- |
| Offensive Strike (`offensive`) | Enemy difficulty priority × 3; unpainted squares 0.2 each; entered place-bonus priority × 0.25. |
| Fortify (`fortify`) | Friendly squares: 2 / (1 + owner score), or 0.25 with unknown score; × 1.5 where an enemy square shares a side. Enemy, unpainted and place bonuses contribute no mission priority. |
| Frontier Patrol (`frontier`) | Unpainted squares sharing a side with friendly territory: 2; other unpainted: 0.15; enemy difficulty priority × 0.2; place-bonus priority × 0.25. |
| Flanking Maneuver (`flanking`) | Standard territory priority, place-bonus priority × 0.5, then multiply the subtotal by 1 + 0.75 × the share of crossed squares outside the fastest baseline. Reserve initial probes for wider directional loops. |
| Special Operations (`special_ops`) | Only eligible place bonuses contribute, at × 3 after the entered weight and weekly cap. Requires enabled bonuses, positive weight and a place source; unavailable/used/capped places are not invented. |
| Supply Run (`supply`) | Standard territory and place-bonus priority, multiplied by 1 / (1 + extra driving minutes / 3). |

Enemy difficulty priority remains 1 for owner scores at most 1, 1 / score² for defended squares, and 0.5 for unknown scores. Each square counts once per route. These are route-ranking weights, not game point rules or probabilities. Fortify reinforcement targets are counted separately from capture opportunities and displayed in amber; radio evidence uses mission targets. The route breakdown shows weighted contributions, place factors and time/geography modifiers. Place awards remain capped estimates, not confirmed earnings.

### Signal intel from the MeshWars token

A MeshWars integration token does not authorize the separate direct FreqMapper point-observation feed (`FREQMAPPER_PARTNER_TOKEN`). It can read the authenticated cell endpoint's `evidence_summary`: verified TX count, passive RX count, other report count, and maximum watcher count where provided. Clicked-square popups display those fields, and **Intel → Signal intel** summarizes up to 512 inspected squares from the current browser session. This adds no background square scan or upstream calls beyond explicit square clicks.

Counts are square-level historical evidence with unspecified observation ages/history window. Passive reception does not establish transmit coverage; missing/zero evidence remains unknown rather than failed. These summaries do not feed the route's 50-meter point-proximity coverage annotation or change route priority, because exact observation locations are unavailable.

When **Captured in last** is set to 1–60 days, each top team card also shows filtered territory points: one point per currently held square with a valid capture timestamp in that window. These counts cover the full board for every team, independently of team/player selection, map position, and hiding squares. Missing and future timestamps are excluded. Official totals remain visible; check-in and exploration bonuses cannot be filtered by capture age. Select All time to hide the extra counts.
