"""FreqMapper partner evidence, kept separate from territory scoring and ownership."""
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from planner import route_grid_cells, LAT_STEP, LON_STEP

SOURCE = 'https://freqmapper.net/api/v1/integrations/coverage-events'


def normalize_event(event):
    """Retain only public routing evidence, never radio or participant identifiers."""
    if not isinstance(event, dict) or event.get('event_type') not in ('verified_tx', 'passive_rx'):
        raise ValueError('Unsupported coverage event.')
    event_id = event.get('event_id')
    lon, lat = event.get('longitude'), event.get('latitude')
    if not isinstance(event_id, str) or not event_id or len(event_id) > 200:
        raise ValueError('Invalid evidence ID.')
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (lon, lat)):
        raise ValueError('Invalid evidence position.')
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError('Evidence position out of range.')
    occurred = event.get('occurred_at')
    if not isinstance(occurred, str):
        raise ValueError('Missing evidence time.')
    parsed = datetime.fromisoformat(occurred.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Evidence time needs a timezone.')
    return {'event_id': event_id, 'event_type': event['event_type'],
            'longitude': lon, 'latitude': lat, 'occurred_at': occurred,
            'quality': event.get('quality') if event.get('quality') in ('strong', 'fair', 'weak') else None}


class RadioCoverage:
    def __init__(self, cache_path, token=None, region='SLC', interval=1800):
        self.path, self.token, self.region, self.interval = Path(cache_path), token, region, interval
        self._lock, self._refresh_lock = threading.Lock(), threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.events, self.cursor = {}, None
        self.last_success = self.last_checked = None
        self.error = None
        self.has_more = False
        self._suspended = False
        self._retry_delay = interval
        if token:
            try:
                data = json.loads(self.path.read_text())
                if data['region'] == region:
                    events = [normalize_event(e) for e in data['events']]
                    self.events = {e['event_id']: e for e in events}
                    self.cursor = data['cursor']
                    self.last_success = data['last_success']
                    self.has_more = data.get('has_more', False)
            except (OSError, ValueError, KeyError, TypeError):
                pass

    def snapshot(self):
        with self._lock:
            events = sorted(self.events.values(), key=lambda e: e['event_id'])
            revision = hashlib.sha256(json.dumps(events, sort_keys=True).encode()).hexdigest()
            return {'configured': bool(self.token), 'available': self.last_success is not None,
                    'source': 'FreqMapper partner coverage events', 'region': self.region,
                    'last_success': self.last_success, 'last_checked': self.last_checked,
                    'stale': bool(self.error) or self.last_success is None or time.time()-self.last_success > 2*self.interval,
                    'partial': True, 'history_pending': self.has_more,
                    'negative_evidence_available': False, 'error': self.error,
                    'revision': revision, 'events': [dict(e) for e in events]}

    def refresh(self):
        if not self.token or not self._refresh_lock.acquire(blocking=False):
            return
        try:
            with self._lock:
                events, cursor = dict(self.events), self.cursor
                self.last_checked = time.time()
            # Bound each refresh; persist each complete page before advancing.
            for _ in range(4):
                params = {'limit': 1000, 'region_iata': self.region}
                if cursor:
                    params['cursor'] = cursor
                request = Request(SOURCE + '?' + urlencode(params), headers={
                    'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json',
                    'User-Agent': 'MeshWarsRoutePlanner/0.1'})
                with urlopen(request, timeout=20) as response:
                    data = json.load(response)
                if not isinstance(data, dict) or data.get('schema_version') != 1 or not isinstance(data.get('events'), list):
                    raise ValueError('Invalid coverage response.')
                next_cursor = data.get('next_cursor')
                more = data.get('has_more')
                if not isinstance(next_cursor, str) or not next_cursor or not isinstance(more, bool):
                    raise ValueError('Invalid coverage cursor.')
                page = [normalize_event(e) for e in data['events']]
                if more and next_cursor == cursor:
                    raise ValueError('Coverage cursor did not advance.')
                updated = dict(events)
                updated.update({e['event_id']: e for e in page})
                if len(updated) > 100000:
                    raise ValueError('Coverage cache limit reached.')
                now = time.time()
                self._persist({'region': self.region, 'events': list(updated.values()),
                               'cursor': next_cursor, 'last_success': now, 'has_more': more})
                with self._lock:
                    self.events, self.cursor = updated, next_cursor
                    self.last_success, self.has_more, self.error = now, more, None
                    self._retry_delay = self.interval
                events, cursor = updated, next_cursor
                if not more or self._stop.is_set():
                    break
        except HTTPError as error:
            with self._lock:
                self._suspended = error.code in (401, 403, 404, 422)
                if error.code == 429:
                    try:
                        delay = float(error.headers.get('Retry-After', self.interval))
                        self._retry_delay = max(self.interval, delay) if math.isfinite(delay) else self.interval
                    except (TypeError, ValueError):
                        self._retry_delay = self.interval
                self.error = ('Coverage access needs server configuration changes; automatic requests paused.'
                              if self._suspended else 'Coverage provider unavailable; retaining previously loaded evidence.')
            error.close()
        except (OSError, ValueError, TypeError, KeyError):
            with self._lock:
                self.error = 'Coverage refresh unavailable; retaining previously loaded evidence.'
        finally:
            self._refresh_lock.release()

    def _persist(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as handle:
                temp = Path(handle.name)
                json.dump(data, handle)
            os.replace(temp, self.path)
        finally:
            if temp:
                temp.unlink(missing_ok=True)

    def start(self):
        if not self.token or self._thread:
            return
        def run():
            while not self._stop.is_set() and not self._suspended:
                self.refresh()
                self._stop.wait(self._retry_delay)
        self._thread = threading.Thread(target=run, daemon=True, name='freqmapper-coverage')
        self._thread.start()

    def close(self):
        self._stop.set()


def near_segment(point, a, b, tolerance_meters=50):
    """Compare evidence with the actual road, not just its containing square."""
    scale = max(.1, math.cos(math.radians(point[1])))
    dx, dy = (b[0]-a[0])*scale, b[1]-a[1]
    px, py = (point[0]-a[0])*scale, point[1]-a[1]
    length = dx*dx + dy*dy
    fraction = max(0., min(1., (px*dx+py*dy)/length)) if length else 0.
    return math.hypot(px-fraction*dx, py-fraction*dy)*111320 <= tolerance_meters


def annotate_routes(result, snapshot):
    """Add evidence counts without changing ranking, budgets, or capture scores."""
    indexed = {}
    for event in snapshot['events']:
        point = [event['longitude'], event['latitude']]
        cell_id = f'{math.floor(point[1]/LAT_STEP)}_{math.floor(point[0]/LON_STEP)}'
        indexed.setdefault(cell_id, []).append(event)
    routes = [result['baseline'], *result['routes']]
    for entry in result.get('strategy_results', {}).values():
        routes.extend(entry['routes'])
    annotated = set()
    for route in routes:
        if id(route) in annotated:
            continue
        annotated.add(id(route))
        coords = route['geometry']['coordinates']
        visited = route_grid_cells(coords)
        counts = {'verified_tx': 0, 'passive_rx_only': 0, 'unknown': 0}
        target_counts = dict(counts)
        targets = set(route.get('mission_target_ids',route['target_ids']))
        for cell in visited:
            kinds = set()
            for event in indexed.get(cell, []):
                point = [event['longitude'], event['latitude']]
                if any(near_segment(point, a, b) for a, b in zip(coords, coords[1:])):
                    kinds.add(event['event_type'])
            category = 'verified_tx' if 'verified_tx' in kinds else 'passive_rx_only' if kinds else 'unknown'
            counts[category] += 1
            if cell in targets:
                target_counts[category] += 1
        route['radio_coverage'] = dict(counts, targets=target_counts, proximity_meters=50)
    result['radio_coverage'] = {k: v for k, v in snapshot.items() if k != 'events'}
    return result
