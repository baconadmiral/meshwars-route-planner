"""Thread-safe polling of the MeshWars board with a durable last-good cache."""
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def validate_board(data):
    if not isinstance(data, dict) or not isinstance(data.get('coverage'), list):
        raise ValueError('Expected a board object with a coverage array.')
    seen = set()
    for cell in data['coverage']:
        if not isinstance(cell, dict) or not isinstance(cell.get('cell_id'), str) or not isinstance(cell.get('owner_team'), str):
            raise ValueError('Invalid square ID or owner.')
        if cell['cell_id'] in seen:
            raise ValueError('Duplicate square ID.')
        seen.add(cell['cell_id'])
        for key in ('south', 'west', 'north', 'east'):
            value = cell.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError('Invalid square bounds.')
        if not (-90 <= cell['south'] < cell['north'] <= 90 and -180 <= cell['west'] < cell['east'] <= 180):
            raise ValueError('Square bounds out of range.')
    return data


def revision(data):
    return hashlib.sha256(json.dumps(data['coverage'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class BoardFeed:
    def __init__(self, seed_path, cache_path, url='https://meshwars.com/get-nodes', interval=1800, capture_users=None, team_scores=None):
        if not math.isfinite(interval) or interval < 15:
            raise ValueError('Board refresh interval must be at least 15 seconds.')
        self.seed_path, self.cache_path = Path(seed_path), Path(cache_path)
        self.url, self.interval = url, interval
        self.capture_users = capture_users
        self.team_scores = team_scores
        self._lock, self._refresh_lock = threading.Lock(), threading.Lock()
        self._stop, self._wake = threading.Event(), threading.Event()
        self._thread = None
        self.board = None
        self.etag = self.modified = self.last_checked = self.last_success = None
        self.error = self.cache_error = None
        self.source = 'unavailable'
        self.refreshing = False
        self.failures = 0
        self._last_attempt = None
        self.version = None
        try:
            cached = json.loads(self.cache_path.read_text())
            self.board = validate_board(cached['board'])
            self.last_success = cached.get('fetched_at')
            self.etag, self.modified = cached.get('etag'), cached.get('last_modified')
            self.source = 'cache'
        except (OSError, ValueError, KeyError, TypeError):
            try:
                self.board = validate_board(json.loads(self.seed_path.read_text()))
                self.source = 'snapshot'
            except (OSError, ValueError, TypeError):
                self.error = 'No cached board available; waiting for the live feed.'
        if self.board is not None:
            if self.capture_users is not None:
                self.board = self.capture_users.enrich(self.board)
            self.version = revision(self.board)

    def snapshot(self, include_coverage=True):
        with self._lock:
            data = {'source': self.source, 'revision': self.version,
                    'available': self.board is not None, 'coverage_count': len(self.board['coverage']) if self.board else 0,
                    'last_checked': self.last_checked, 'last_success': self.last_success,
                    'refresh_interval': self.interval, 'retry_interval': min(max(600,self.interval), self.interval*2**min(self.failures,4)), 'refreshing': self.refreshing,
                    'stale': self.source != 'live' or self.error is not None,
                    'error': self.error, 'cache_error': self.cache_error,
                    'attribution': self.capture_users.status() if self.capture_users else {'configured':False,'partial':True}}
            data['team_scores'] = self.team_scores.snapshot() if self.team_scores else {'available':False,'teams':[]}
            if include_coverage:
                data['coverage'] = self.board['coverage'] if self.board else []
            return data

    def _persist(self, board, fetched_at, etag, modified):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.cache_path.parent, delete=False) as handle:
                temp_path = Path(handle.name)
                json.dump({'board': board, 'fetched_at': fetched_at, 'etag': etag, 'last_modified': modified}, handle)
            os.replace(temp_path, self.cache_path)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    def refresh(self):
        if not self._refresh_lock.acquire(blocking=False):
            return
        try:
            now = time.monotonic()
            if self._last_attempt is not None and now-self._last_attempt < 15:
                return
            self._last_attempt = now
            with self._lock:
                self.refreshing = True
                etag, modified = self.etag, self.modified
            headers = {'Accept': 'application/json', 'User-Agent': 'MeshWarsBluePlanner/0.1'}
            if etag:
                headers['If-None-Match'] = etag
            if modified:
                headers['If-Modified-Since'] = modified
            try:
                with urlopen(Request(self.url, headers=headers), timeout=20) as response:
                    raw = response.read(25*1024*1024+1)
                    if len(raw) > 25*1024*1024:
                        raise ValueError('Board response exceeds 25 MB.')
                    board = validate_board(json.loads(raw))
                    etag = response.headers.get('ETag')
                    modified = response.headers.get('Last-Modified')
            except HTTPError as error:
                try:
                    if error.code != 304 or self.board is None:
                        raise
                    board = self.board
                finally:
                    error.close()
            if self.capture_users is not None:
                self.capture_users.refresh()
                board = self.capture_users.enrich(board)
            if self.team_scores is not None:
                self.team_scores.refresh()
            checked_at = time.time()
            cache_error = None
            try:
                self._persist(board, checked_at, etag, modified)
            except OSError:
                cache_error = 'Live board updated, but the local cache could not be saved.'
            version = revision(board)
            with self._lock:
                self.board, self.version = board, version
                self.etag, self.modified = etag, modified
                self.last_checked = self.last_success = checked_at
                self.source = 'live'
                self.error, self.cache_error = None, cache_error
                self.failures = 0
        except (OSError, ValueError, TypeError):
            with self._lock:
                self.last_checked = time.time()
                self.error = 'MeshWars refresh failed; retaining the last successful board. Retrying automatically.'
                self.failures += 1
        finally:
            with self._lock:
                self.refreshing = False
            self._refresh_lock.release()

    def start(self):
        if self._thread is not None:
            return
        def run():
            while not self._stop.is_set():
                self.refresh()
                delay = min(max(600,self.interval), self.interval * 2**min(self.failures, 4))
                self._wake.wait(delay)
                self._wake.clear()
        self._thread = threading.Thread(target=run, name='meshwars-board-feed', daemon=True)
        self._thread.start()

    def request_refresh(self):
        self._wake.set()

    def close(self):
        self._stop.set()
        self._wake.set()
