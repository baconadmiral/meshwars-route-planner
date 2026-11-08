"""Production WSGI entry point: one process owns feeds and bounded route searches."""
import json
import logging
import os
from pathlib import Path
import queue
import signal
import threading
from urllib.parse import urlsplit

from flask import Flask, Response, jsonify, request, send_from_directory
from waitress import create_server
from werkzeug.exceptions import HTTPException

from board_feed import BoardFeed
from team_scores import TeamScores
from places import PlacesFeed, place_options
from capture_users import CaptureUsers
from drive_reports import DriveReports
from square_api import SquareAPI
from geocoder import lookup_address
from navigation import build_export
from gpx_shares import GPXShares, ShareCapacityError
from radio_coverage import RadioCoverage, annotate_routes
from route_bounds import validate_bounds, StopsOutsideArea
from server import ROOT, ROUTING_WORKERS, SearchCancelled, fetch_routes, parse_plan_request
from app_version import build_version
from territory_reports import territory_report
from planner import search_routes


class Runtime:
    def __init__(self):
        data_dir = Path(os.environ.get('DATA_DIR', str(ROOT/'.cache')))
        data_dir.mkdir(parents=True, exist_ok=True)
        users = CaptureUsers(data_dir/'capture_users.json', key=os.environ.get('MESHWARS_API_KEY'),
                             api_url=os.environ.get('MESHWARS_API_URL', 'https://meshwars.com/api/v1'))
        self.board = BoardFeed(Path(os.environ.get('BOARD_PATH', str(ROOT.parent/'nodes.json'))),
                               data_dir/'board.json', capture_users=users,
                               team_scores=TeamScores(data_dir/'team_scores.json',
                                                     url=os.environ.get('MESHWARS_SCORES_URL','https://meshwars.com/scores')),
                               url=os.environ.get('MESHWARS_BOARD_URL', 'https://meshwars.com/get-nodes'),
                               interval=float(os.environ.get('MESHWARS_REFRESH_SECONDS', '1800')),
                               api_key=os.environ.get('MESHWARS_API_KEY'),
                               api_url=os.environ.get('MESHWARS_API_URL','https://meshwars.com/api/v1'))
        self.radio = RadioCoverage(data_dir/'radio_coverage.json',
                                   token=os.environ.get('FREQMAPPER_PARTNER_TOKEN'),
                                   region=os.environ.get('FREQMAPPER_REGION', 'SLC'))
        self.places=PlacesFeed(os.environ.get('MESHWARS_PLACES_URL','https://meshwars.com/api/places'))
        self.square_api = SquareAPI(os.environ.get('MESHWARS_API_KEY'),os.environ.get('MESHWARS_API_URL','https://meshwars.com/api/v1'))
        self.drives = DriveReports(os.environ.get('MESHWARS_API_KEY'), os.environ.get('MESHWARS_API_URL', 'https://meshwars.com/api/v1'))
        self.stopping = threading.Event()

    def start(self):
        self.board.start()
        self.radio.start()

    def close(self):
        self.stopping.set()
        self.board.close()
        self.radio.close()


def create_app(runtime, search_limit=2):
    if not 1 <= search_limit <= 4:
        raise ValueError('MAX_CONCURRENT_SEARCHES must be between 1 and 4.')
    app = Flask(__name__, static_folder=None)
    app.config['MAX_CONTENT_LENGTH'] = 5*1024*1024
    slots = threading.BoundedSemaphore(search_limit)
    shares = GPXShares()

    @app.before_request
    def validate_request():
        if request.method != 'POST':
            return None
        origin = request.headers.get('Origin')
        if origin and urlsplit(origin).netloc != request.host:
            return jsonify(error='Cross-origin requests are not allowed.'), 403
        if not request.is_json:
            return jsonify(error='Send application/json.'), 415
        if request.path not in ('/api/route-export','/api/gpx-shares'):
            if request.content_length is None or request.content_length > 16384:
                return jsonify(error='Invalid request size.'), 413
        return None

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        # OSM requires a browser Referer; external requests receive only our origin.
        response.headers['Referrer-Policy'] = ('no-referrer' if request.path.startswith('/api/gpx-shares/')
                                               else 'strict-origin-when-cross-origin')
        response.headers['Permissions-Policy'] = 'geolocation=(self)'
        return response

    @app.errorhandler(Exception)
    def error_response(error):
        if isinstance(error, StopsOutsideArea):
            return jsonify(error=str(error),outside_stops=error.stop_keys),400
        if isinstance(error, ShareCapacityError):
            return jsonify(error=str(error)), 429, {'Retry-After':'60'}
        if isinstance(error, HTTPException):
            return jsonify(error=error.name), error.code
        if isinstance(error, (ValueError, KeyError, TypeError)):
            # Missing-field exceptions may include user input; do not log bodies.
            return jsonify(error=str(error) if isinstance(error, ValueError) else 'Invalid request fields.'), 400
        if isinstance(error, OSError):
            return jsonify(error='External service unavailable. Please retry.'), 502
        logging.getLogger(__name__).error('Request failed (%s); details withheld to protect location data.', type(error).__name__)
        return jsonify(error='Request failed. Please retry.'), 500

    @app.get('/')
    def index():
        return send_from_directory(ROOT/'static', 'index.html')

    @app.get('/reports')
    def reports_page():
        return send_from_directory(ROOT/'static', 'reports.html')

    @app.get('/api/reports/territory')
    def reports_data():
        return jsonify(territory_report(runtime.board.snapshot(True)))

    @app.get('/app.js')
    @app.get('/style.css')
    @app.get('/reports.js')
    @app.get('/reports.css')
    def asset():
        return send_from_directory(ROOT/'static', request.path[1:])

    @app.get('/healthz')
    def health():
        return jsonify(status='ok')

    @app.get('/api/version')
    def version():
        return jsonify(build_version())

    @app.get('/readyz')
    def ready():
        available = runtime.board.snapshot(False)['available']
        return jsonify(status='ready' if available else 'waiting_for_board'), 200 if available else 503

    @app.get('/api/board')
    @app.get('/api/board/status')
    def board():
        return jsonify(runtime.board.snapshot(request.path == '/api/board'))

    @app.get('/api/radio-coverage')
    def radio():
        return jsonify(runtime.radio.snapshot())

    def json_object():
        data = request.get_json()
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        return data

    @app.get('/api/cells/<cell_id>')
    def cell_details(cell_id):
        detail=runtime.square_api.cell(cell_id)
        runtime.board.apply_cell_detail(detail)
        return jsonify(detail)

    @app.get('/api/players')
    def players():
        return jsonify(runtime.drives.players())

    @app.get('/api/drives/status')
    def drive_status():
        return jsonify(runtime.drives.status())

    @app.post('/api/drives/start')
    def drive_start():
        return jsonify(runtime.drives.start(json_object()))

    @app.post('/api/drives/report')
    def drive_report():
        return jsonify(runtime.drives.report(json_object()))

    @app.post('/api/board/refresh')
    def refresh():
        json_object()
        runtime.board.request_refresh()
        return jsonify(message='Refresh requested. Checks are spaced at least 15 seconds apart.'), 202

    @app.post('/api/validate-route-area')
    def area():
        data=json_object()
        if any(key in data for key in ('start','end','waypoints')):parse_plan_request(data)
        return jsonify(allowed_bounds=validate_bounds(data.get('allowed_bounds')))

    @app.post('/api/route-export')
    def export():
        return jsonify(build_export(json_object().get('route')))

    @app.post('/api/gpx-shares')
    def create_gpx_share():
        return jsonify(shares.create(json_object().get('route'))), 201

    @app.get('/api/gpx-shares/<token>.gpx')
    def get_gpx_share(token):
        item = shares.get(token)
        if item is None:
            return jsonify(error='GPX link expired or not found. Create a new GPX QR code.'), 404
        return Response(item['body'], mimetype='application/gpx+xml', headers={
            'Content-Disposition':f'attachment; filename="{item["filename"]}"'})

    @app.post('/api/geocode')
    def geocode():
        query_text = json_object().get('query')
        if not isinstance(query_text, str) or not 3 <= len(query_text.strip()) <= 300:
            raise ValueError('Enter an address between 3 and 300 characters.')
        return jsonify(results=lookup_address(query_text.strip()))

    @app.post('/api/plan')
    @app.post('/api/plan-stream')
    def plan():
        body=json_object()
        start, end, via, budget, strategy, team, bounds = parse_plan_request(body)
        bonus_options=place_options(body.get('place_options'))
        places_feed=getattr(runtime,'places',None)
        snapshot = runtime.board.snapshot()
        radio_snapshot = runtime.radio.snapshot()
        if not snapshot['available']:
            return jsonify(error='No board data available yet. Please wait for the feed.'), 503
        if runtime.stopping.is_set() or not slots.acquire(blocking=False):
            response = jsonify(error='Search capacity is busy. Please retry shortly.')
            response.headers['Retry-After'] = '10'
            return response, 429

        def run(progress=None):
            result = search_routes(start, end, snapshot['coverage'], budget, fetch_routes,
                                   progress=progress, strategy=strategy, workers=ROUTING_WORKERS,
                                   waypoints=via, team=team, allowed_bounds=bounds,
                                   places_loader=places_feed.load if places_feed else None,place_options=bonus_options,blocked_roads=body.get('blocked_roads'),mission_mode=body.get('mission_mode','balanced'))
            annotate_routes(result, radio_snapshot)
            result['board_revision'] = snapshot.get('revision')
            return result

        if request.path == '/api/plan':
            try:
                return jsonify(run())
            finally:
                slots.release()

        events = queue.Queue(maxsize=8)
        cancelled = threading.Event()

        def emit(kind, data):
            while not cancelled.is_set() and not runtime.stopping.is_set():
                try:
                    events.put({'type': kind, **data}, timeout=.25)
                    return
                except queue.Full:
                    pass
            raise SearchCancelled()

        def produce():
            try:
                result = run(lambda update: emit('progress', update))
                emit('result', result)
            except SearchCancelled:
                pass
            except (ValueError, KeyError, TypeError) as error:
                try:
                    emit('error', {'error': str(error) if isinstance(error, ValueError) else 'Invalid route response.'})
                except SearchCancelled:
                    pass
            except Exception:
                try:
                    emit('error', {'error': 'Route search unavailable. Please retry.'})
                except SearchCancelled:
                    pass
            finally:
                slots.release()

        worker = threading.Thread(target=produce, daemon=True, name='hosted-route-search')
        try:
            worker.start()
        except Exception:
            slots.release()
            raise

        def stream():
            try:
                while True:
                    try:
                        event = events.get(timeout=10)
                    except queue.Empty:
                        if not worker.is_alive():
                            break
                        yield '\n'  # Keep proxy connections alive during provider waits.
                        continue
                    yield json.dumps(event)+'\n'
                    if event['type'] in ('result', 'error'):
                        break
            finally:
                cancelled.set()

        response = Response(stream(), mimetype='application/x-ndjson')
        response.headers['X-Accel-Buffering'] = 'no'
        response.call_on_close(cancelled.set)
        return response

    return app


def main():
    runtime = Runtime()
    app = create_app(runtime, int(os.environ.get('MAX_CONCURRENT_SEARCHES', '2')))
    http = create_server(app, host=os.environ.get('HOST', '127.0.0.1'),
                         port=int(os.environ.get('PORT', '8000')), threads=8,
                         connection_limit=100, channel_timeout=120,
                         max_request_body_size=5*1024*1024, expose_tracebacks=False,
                         clear_untrusted_proxy_headers=True)
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    runtime.start()
    print('MeshWars hosted server started.', flush=True)
    try:
        http.run()
    except KeyboardInterrupt:
        pass
    finally:
        runtime.close()
        http.close()


if __name__ == '__main__':
    main()
