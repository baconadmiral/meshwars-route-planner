"""Local-only HTTP application; Python standard library, no dependencies."""
import argparse
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

ROOT = Path(__file__).resolve().parent
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
    x, y = map(float, value)
    if not all(map(math.isfinite, (x, y))) or not -180 <= x <= 180 or not -90 <= y <= 90:
        raise ValueError('Invalid longitude or latitude.')
    return [x, y]


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

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/board':
            return self.send_json({'coverage': self.server.board['coverage'], 'source': str(self.server.board_path.name)})
        assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path not in assets:
            return self.send_error(404)
        name, content_type = assets[path]
        body = (ROOT/'static'/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ('/api/plan', '/api/plan-stream', '/api/geocode'):
            return self.send_error(404)
        streaming = False
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 4096:
                raise ValueError('Invalid request size.')
            data = json.loads(self.rfile.read(length))
            if self.path == '/api/geocode':
                query = data.get('query') if isinstance(data, dict) else None
                if not isinstance(query, str) or not 3 <= len(query.strip()) <= 300:
                    raise ValueError('Enter an address between 3 and 300 characters.')
                try:
                    return self.send_json({'results': lookup_address(query.strip())})
                except (URLError, TimeoutError, OSError, ValueError):
                    return self.send_json({'error': 'Address lookup unavailable. Retry or enter latitude, longitude instead.'}, 502)
            start, end = point(data['start']), point(data['end'])
            budget = float(data.get('detour_minutes', 15))*60
            if not math.isfinite(budget) or not 0 <= budget <= 7200:
                raise ValueError('Detour must be between 0 and 120 minutes.')
            strategy = data.get('strategy', 'beam')
            if strategy not in ('greedy', 'beam', 'compare'):
                raise ValueError('Search strategy must be greedy, beam, or compare.')
            if self.path == '/api/plan-stream':
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-ndjson')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.send_header('Connection', 'close')
                self.end_headers()
                streaming = True
                self.close_connection = True
                result = search_routes(start, end, self.server.board['coverage'], budget, fetch_routes,
                                       lambda update: self.send_event('progress', update), strategy=strategy, workers=ROUTING_WORKERS)
                return self.send_event('result', result)
            return self.send_json(search_routes(start, end, self.server.board['coverage'], budget, fetch_routes, strategy=strategy, workers=ROUTING_WORKERS))
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
        board = json.loads(args.board.read_text())
        required = {'cell_id', 'owner_team', 'south', 'west', 'north', 'east'}
        if not isinstance(board.get('coverage'), list) or not all(required <= c.keys() for c in board['coverage']):
            raise ValueError('Expected coverage records with IDs, owners, and bounds.')
    except (OSError, ValueError, AttributeError) as error:
        parser.error(f'Cannot load board: {error}')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.board, server.board_path = board, args.board
    print(f'BLUE route planner: http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()

if __name__ == '__main__':
    main()
