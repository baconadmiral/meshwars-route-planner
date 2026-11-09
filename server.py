"""Local-only HTTP application; Python standard library, no dependencies."""
import argparse
from app_version import build_version
from territory_reports import territory_report
from pwa import PWA_ASSETS, service_worker
from search_jobs import SearchJobs, SearchJobError
import json
import math
import os
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError
from urllib.parse import urlparse
from planner import search_routes
from geocoder import lookup_address
from board_feed import BoardFeed
from team_scores import TeamScores
from places import PlacesFeed, place_options
from capture_users import CaptureUsers
from drive_reports import DriveReports
from square_api import SquareAPI
from mission_modes import validate_mission_mode
from road_blocks import validate_blocked_roads, validate_blocked_stops
from navigation import build_export
from gpx_shares import GPXShares, ShareCapacityError
from teams import validate_team
from route_bounds import validate_bounds, validate_stops, StopsOutsideArea
from radio_coverage import RadioCoverage, annotate_routes

ROOT = Path(__file__).resolve().parent
LOCAL_GPX_SHARES = GPXShares()
ROUTER = os.environ.get('OSRM_URL', 'https://router.project-osrm.org').rstrip('/')

ROUTING_WORKERS = int(os.environ.get('OSRM_WORKERS', '4'))
if not 1 <= ROUTING_WORKERS <= 16:
    raise ValueError('OSRM_WORKERS must be between 1 and 16.')
PUBLIC_ROUTER = urlparse(ROUTER).hostname in ('router.project-osrm.org', 'routing.openstreetmap.de')
ROUTING_INTERVAL = float(os.environ.get('OSRM_REQUEST_INTERVAL', '1' if PUBLIC_ROUTER else '0'))
if not math.isfinite(ROUTING_INTERVAL) or ROUTING_INTERVAL < 0:
    raise ValueError('OSRM_REQUEST_INTERVAL must be a finite, nonnegative number.')
if PUBLIC_ROUTER:
    ROUTING_INTERVAL = max(1., ROUTING_INTERVAL)
_ROUTING_SLOTS = threading.BoundedSemaphore(ROUTING_WORKERS)
_REQUEST_START_LOCK = threading.Lock()
_LAST_REQUEST_START = 0.


def routing_response(url):
    """Bound outstanding requests and space provider calls across all searches."""
    global _LAST_REQUEST_START
    with _ROUTING_SLOTS:
        with _REQUEST_START_LOCK:
            delay = ROUTING_INTERVAL-(time.monotonic()-_LAST_REQUEST_START)
            if delay > 0:
                time.sleep(delay)
            _LAST_REQUEST_START = time.monotonic()
        with urlopen(Request(url, headers={'User-Agent': 'MeshWarsBluePlanner/0.1'}), timeout=20) as response:
            return json.load(response)


def fetch_routes(points, alternatives=False):
    coordinates = ';'.join(','.join(str(v) for v in p) for p in points)
    url = f'{ROUTER}/route/v1/driving/{coordinates}?steps=true&overview=full&geometries=geojson&alternatives={str(alternatives).lower()}'
    data = routing_response(url)
    if data.get('code') != 'Ok' or not data.get('routes'):
        raise ValueError('No driving route found for these locations.')
    return data['routes']


def point(value):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Locations must be [longitude, latitude].')
    if any(isinstance(v,bool) for v in value):
        raise ValueError('Coordinates must be numbers.')
    x, y = map(float, value)
    if not all(map(math.isfinite, (x, y))) or not -180 <= x <= 180 or not -90 <= y <= 90:
        raise ValueError('Invalid longitude or latitude.')
    return [x, y]


def parse_plan_request(data):
    if not isinstance(data, dict):
        raise ValueError('Expected a JSON object.')
    team = validate_team(data.get('team', 'BLUE'))
    validate_mission_mode(data.get('mission_mode','balanced'))
    allowed_bounds = validate_bounds(data.get('allowed_bounds'))
    start, end = point(data['start']), point(data['end'])
    raw_waypoints = data.get('waypoints', [])
    if not isinstance(raw_waypoints, list) or len(raw_waypoints) > 8:
        raise ValueError('Provide at most eight ordered waypoints.')
    required_waypoints = [point(value) for value in raw_waypoints]
    validate_stops(start,end,required_waypoints,allowed_bounds)
    validate_blocked_stops(start,end,required_waypoints,validate_blocked_roads(data.get('blocked_roads')))
    budget = float(data.get('detour_minutes', 15))*60
    if not math.isfinite(budget) or not 0 <= budget <= 7200:
        raise ValueError('Detour must be between 0 and 120 minutes.')
    strategy = data.get('strategy', 'beam')
    if strategy not in ('greedy', 'beam', 'compare'):
        raise ValueError('Search strategy must be greedy, beam, or compare.')
    return start, end, required_waypoints, budget, strategy, team, allowed_bounds


class SearchCancelled(Exception):
    """The browser disconnected from a streaming search."""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log trip coordinates.

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def board_snapshot(self, include_coverage=True):
        if hasattr(self.server, 'board_feed'):
            return self.server.board_feed.snapshot(include_coverage)
        # Compatibility for embedded/test servers providing a fixed board.
        data = {'source': str(self.server.board_path.name), 'available': True}
        if include_coverage:
            data['coverage'] = self.server.board['coverage']
        return data

    def radio_snapshot(self):
        feed = getattr(self.server, 'radio_coverage', None)
        return (feed or RadioCoverage(ROOT/'.cache'/'radio_coverage.json')).snapshot()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/api/searches/'):
            try:
                return self.send_json(self.server.search_jobs.get(path[len('/api/searches/'):]))
            except SearchJobError as error:
                return self.send_json({'error': str(error)}, error.status)
        if path == '/api/version':
            return self.send_json(build_version())
        if path == '/api/reports/territory':
            return self.send_json(territory_report(self.board_snapshot()))
        if path in ('/api/board', '/api/board/status'):
            return self.send_json(self.board_snapshot(include_coverage=path == '/api/board'))
        if path.startswith('/api/gpx-shares/') and path.endswith('.gpx'):
            token=path[len('/api/gpx-shares/'):-4]
            item=LOCAL_GPX_SHARES.get(token)
            if item is None:
                return self.send_json({'error':'GPX link expired or not found. Create a new GPX QR code.'},404)
            self.send_response(200)
            self.send_header('Content-Type','application/gpx+xml')
            self.send_header('Content-Disposition',f'attachment; filename="{item["filename"]}"')
            self.send_header('Cache-Control','no-store')
            self.send_header('Referrer-Policy','no-referrer')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Length',str(len(item['body'])))
            self.end_headers()
            return self.wfile.write(item['body'])
        if path.startswith('/api/cells/'):
            try:
                detail=self.server.square_api.cell(path[len('/api/cells/'):])
                self.server.board_feed.apply_cell_detail(detail)
                return self.send_json(detail)
            except ValueError as error:return self.send_json({'error':str(error)},400)
        if path == '/api/players':
            return self.send_json(self.server.drives.players())
        if path == '/api/drives/status':
            return self.send_json(self.server.drives.status())
        if path == '/api/radio-coverage':
            return self.send_json(self.radio_snapshot())
        assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css'),
                  '/reports': ('reports.html', 'text/html'), '/reports.js': ('reports.js', 'text/javascript'),
                  '/reports.css': ('reports.css', 'text/css')}
        assets['/search-client.js'] = ('search-client.js', 'text/javascript')
        assets['/startup.js'] = ('startup.js', 'text/javascript')
        assets.update(PWA_ASSETS)
        if path not in assets:
            return self.send_error(404)
        name, content_type = assets[path]
        body = service_worker().encode() if path == '/sw.js' else (ROOT/'static'/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        search_path = self.path.startswith('/api/searches/')
        if not search_path and self.path not in ('/api/plan', '/api/plan-stream', '/api/geocode', '/api/board/refresh', '/api/route-export', '/api/validate-route-area', '/api/gpx-shares', '/api/drives/start', '/api/drives/report'):
            return self.send_error(404)
        streaming = False
        try:
            length = int(self.headers.get('Content-Length', 0))
            limit = 5*1024*1024 if self.path in ('/api/route-export','/api/gpx-shares') else 16384
            if not 0 < length <= limit:
                raise ValueError('Invalid request size.')
            data = json.loads(self.rfile.read(length))
            if search_path:
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'):
                    return self.send_json({'error': 'Cross-origin requests are not allowed.'}, 403)
                if not isinstance(data, dict):
                    raise ValueError('Expected a JSON object.')
                token = self.path[len('/api/searches/'):]
                if token.endswith('/cancel'):
                    return self.send_json(self.server.search_jobs.cancel(token[:-len('/cancel')]))
            if self.path in ('/api/drives/start','/api/drives/report'):
                if not isinstance(data,dict):raise ValueError('Expected a JSON object.')
                action=self.server.drives.start if self.path.endswith('/start') else self.server.drives.report
                return self.send_json(action(data))
            if self.path == '/api/validate-route-area':
                if any(key in data for key in ('start','end','waypoints')):parse_plan_request(data)
                return self.send_json({'allowed_bounds': validate_bounds(data.get('allowed_bounds'))})
            if self.path == '/api/gpx-shares':
                return self.send_json(LOCAL_GPX_SHARES.create(data.get('route') if isinstance(data,dict) else None),201)
            if self.path == '/api/route-export':
                return self.send_json(build_export(data.get('route') if isinstance(data,dict) else None))
            if self.path == '/api/board/refresh':
                self.server.board_feed.request_refresh()
                return self.send_json({'message': 'Refresh requested. Checks are spaced at least 15 seconds apart.'}, 202)
            if self.path == '/api/geocode':
                query = data.get('query') if isinstance(data, dict) else None
                if not isinstance(query, str) or not 3 <= len(query.strip()) <= 300:
                    raise ValueError('Enter an address between 3 and 300 characters.')
                try:
                    return self.send_json({'results': lookup_address(query.strip())})
                except (URLError, TimeoutError, OSError, ValueError):
                    return self.send_json({'error': 'Address lookup unavailable. Retry or enter latitude, longitude instead.'}, 502)
            start, end, required_waypoints, budget, strategy, team, allowed_bounds = parse_plan_request(data)
            bonus_options=place_options(data.get('place_options'))
            places_feed=getattr(self.server,'places_feed',None)
            board_snapshot = self.board_snapshot()
            if board_snapshot.get('available') is False:
                return self.send_json({'error': 'No board data available yet. Wait for the feed or provide --board.'}, 503)
            coverage = board_snapshot['coverage']
            radio_snapshot = self.radio_snapshot()
            if search_path:
                def run(progress):
                    result = search_routes(start, end, coverage, budget, fetch_routes,
                                           progress=progress, strategy=strategy, workers=ROUTING_WORKERS,
                                           waypoints=required_waypoints, team=team, allowed_bounds=allowed_bounds,
                                           places_loader=places_feed.load if places_feed else None,
                                           place_options=bonus_options, blocked_roads=data.get('blocked_roads'),
                                           mission_mode=data.get('mission_mode', 'balanced'))
                    annotate_routes(result, radio_snapshot)
                    result['board_revision'] = board_snapshot.get('revision')
                    return result
                return self.send_json(self.server.search_jobs.start(token, data, run), 202)
            if self.path == '/api/plan-stream':
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-ndjson')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.send_header('Connection', 'close')
                self.end_headers()
                streaming = True
                self.close_connection = True
                result = search_routes(start, end, coverage, budget, fetch_routes,
                                       lambda update: self.send_event('progress', update), strategy=strategy, workers=ROUTING_WORKERS, waypoints=required_waypoints, team=team, allowed_bounds=allowed_bounds,
                                       places_loader=places_feed.load if places_feed else None,place_options=bonus_options,blocked_roads=data.get('blocked_roads'),mission_mode=data.get('mission_mode','balanced'))
                annotate_routes(result, radio_snapshot)
                result['board_revision'] = board_snapshot.get('revision')
                return self.send_event('result', result)
            result = search_routes(start, end, coverage, budget, fetch_routes, strategy=strategy, workers=ROUTING_WORKERS, waypoints=required_waypoints, team=team, allowed_bounds=allowed_bounds,
                                       places_loader=places_feed.load if places_feed else None,place_options=bonus_options,blocked_roads=data.get('blocked_roads'),mission_mode=data.get('mission_mode','balanced'))
            annotate_routes(result, radio_snapshot)
            result['board_revision'] = board_snapshot.get('revision')
            return self.send_json(result)
        except SearchJobError as error:
            return self.send_json({'error': str(error)}, error.status)
        except StopsOutsideArea as error:
            return self.send_json({'error':str(error),'outside_stops':error.stop_keys},400)
        except ShareCapacityError as error:
            return self.send_json({'error':str(error)},429)
        except SearchCancelled:
            return
        except (ValueError, KeyError, TypeError) as error:
            return self.send_event('error', {'error': str(error)}) if streaming else self.send_json({'error': str(error)}, 400)
        except (URLError, TimeoutError, OSError):
            error = {'error': 'Routing provider unavailable. Check your internet connection or OSRM_URL.'}
            return self.send_event('error', error) if streaming else self.send_json(error, 502)

    def send_event(self, kind, data):
        try:
            self.wfile.write((json.dumps({'type': kind, **data})+'\n').encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError) as error:
            raise SearchCancelled() from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--board', type=Path, default=ROOT.parent/'nodes.json')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    try:
        users = CaptureUsers(ROOT/'.cache'/'capture_users.json',
                             key=os.environ.get('MESHWARS_API_KEY'),
                             api_url=os.environ.get('MESHWARS_API_URL', 'https://meshwars.com/api/v1'))
        feed = BoardFeed(args.board, ROOT/'.cache'/'board.json', capture_users=users,
                         team_scores=TeamScores(ROOT/'.cache'/'team_scores.json',
                                               url=os.environ.get('MESHWARS_SCORES_URL','https://meshwars.com/scores')),
                         url=os.environ.get('MESHWARS_BOARD_URL', 'https://meshwars.com/get-nodes'),
                         interval=float(os.environ.get('MESHWARS_REFRESH_SECONDS', '1800')),
                               api_key=os.environ.get('MESHWARS_API_KEY'),
                               api_url=os.environ.get('MESHWARS_API_URL','https://meshwars.com/api/v1'))
    except ValueError as error:
        parser.error(str(error))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.search_jobs = SearchJobs()
    server.radio_coverage = RadioCoverage(ROOT/'.cache'/'radio_coverage.json',
                                          token=os.environ.get('FREQMAPPER_PARTNER_TOKEN'),
                                          region=os.environ.get('FREQMAPPER_REGION', 'SLC'))
    server.radio_coverage.start()
    server.places_feed=PlacesFeed(os.environ.get('MESHWARS_PLACES_URL','https://meshwars.com/api/places'))
    server.square_api = SquareAPI(os.environ.get('MESHWARS_API_KEY'),os.environ.get('MESHWARS_API_URL','https://meshwars.com/api/v1'))
    server.drives = DriveReports(os.environ.get('MESHWARS_API_KEY'), os.environ.get('MESHWARS_API_URL','https://meshwars.com/api/v1'))
    server.board_feed = feed
    feed.start()
    print(f'MeshWars route planner: http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    finally:
        server.search_jobs.stopping.set()
        server.radio_coverage.close()
        feed.close()
        server.server_close()

if __name__ == '__main__':
    main()
