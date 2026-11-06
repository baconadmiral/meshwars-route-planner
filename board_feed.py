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
from urllib.parse import urlencode
from capture_users import valid_event


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


def merge_api_board(board,supplement):
    known={row['cell_id']:row for row in supplement['coverage']}
    cells=[]
    missing=0
    for row in board['coverage']:
        cell=dict(row)
        source=known.get(row['cell_id'])
        # Same owner, report version and bounds: no stale score or timestamp guessing.
        if source and all(source.get(k)==row.get(k) for k in ('owner_team','last_report_ts','south','west','north','east')):
            for key in ('scores','captured_at'):
                if key not in cell and key in source:cell[key]=source[key]
        if 'scores' not in cell:missing+=1
        cells.append(cell)
    result=dict(board,coverage=cells)
    if missing:result['data_warning']=f'{missing} squares lack synchronized defense scores; missing scores have reduced priority.'
    return result


def apply_cell_captures(board,events):
    cells=[]
    for cell in board['coverage']:
        event=events.get(cell['cell_id'])
        if (event and valid_event(event) and event['team']==cell['owner_team']
                and event['ts']==cell.get('captured_at')):
            cell=dict(cell,captured_by=event['player'].strip())
        cells.append(cell)
    return dict(board,coverage=cells)


class BoardFeed:
    def __init__(self, seed_path, cache_path, url='https://meshwars.com/get-nodes', interval=1800, capture_users=None, team_scores=None, api_key=None, api_url='https://meshwars.com/api/v1'):
        if not math.isfinite(interval) or interval < 15:
            raise ValueError('Board refresh interval must be at least 15 seconds.')
        self.seed_path, self.cache_path = Path(seed_path), Path(cache_path)
        self.url, self.interval = url, interval
        self._api_key=api_key
        self.api_url=api_url.rstrip('/')
        self._cell_captures={}
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
            if cached.get('feed')!=('api' if self._api_key else 'site'):self.etag=self.modified=None
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
                    'board_endpoint':'authenticated-api' if self._api_key else 'site-feed',
                    'data_warning':self.board.get('data_warning') if self.board else None,
                    'attribution': self.capture_users.status() if self.capture_users else {'configured':False,'partial':True}}
            data['team_scores'] = self.team_scores.snapshot() if self.team_scores else {'available':False,'teams':[]}
            if include_coverage:
                data['coverage'] = self.board['coverage'] if self.board else []
            return data

    def apply_cell_detail(self,detail):
        event=detail.get('capture_event')
        if not event or not valid_event(event):return
        with self._lock:
            current=next((c for c in self.board['coverage'] if c['cell_id']==event['cell_id']),None) if self.board else None
            if not current or current['owner_team']!=event['team'] or current.get('captured_at')!=event['ts']:return
            if len(self._cell_captures)>=512 and event['cell_id'] not in self._cell_captures:
                self._cell_captures.pop(next(iter(self._cell_captures)))
            self._cell_captures[event['cell_id']]=event
            if self.board is not None:
                self.board=apply_cell_captures(self.board,{event['cell_id']:event})
                self.version=revision(self.board)

    def _persist(self, board, fetched_at, etag, modified):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.cache_path.parent, delete=False) as handle:
                temp_path = Path(handle.name)
                json.dump({'board': board, 'fetched_at': fetched_at, 'etag': etag, 'last_modified': modified,'feed':'api' if self._api_key else 'site'}, handle)
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
            if self._api_key:headers['X-API-Key']=self._api_key
            if etag:
                headers['If-None-Match'] = etag
            if modified:
                headers['If-Modified-Since'] = modified
            try:
                with urlopen(Request(self.api_url+'/board?'+urlencode({'board':'meshtastic'}) if self._api_key else self.url, headers=headers), timeout=20) as response:
                    raw = response.read(25*1024*1024+1)
                    if len(raw) > 25*1024*1024:
                        raise ValueError('Board response exceeds 25 MB.')
                    payload=json.loads(raw)
                    if self._api_key:
                        if not isinstance(payload,dict) or payload.get('board') not in ('meshtastic','mt'):
                            raise ValueError('Wrong API board.')
                        board=validate_board({'coverage':payload.get('cells')})
                        try:
                            # Public feed supplies scores absent from the authenticated bulk endpoint.
                            # Never forward the token to this supplementary URL.
                            with urlopen(Request(self.url,headers={'Accept':'application/json','User-Agent':'MeshWarsRoutePlanner/0.1'}),timeout=20) as supplement:
                                supplement_raw=supplement.read(25*1024*1024+1)
                            if len(supplement_raw)>25*1024*1024:raise ValueError('Supplement too large.')
                            board=merge_api_board(board,validate_board(json.loads(supplement_raw)))
                        except (OSError,ValueError,TypeError):
                            board['data_warning']='API board loaded; supplementary defense scores unavailable. Missing scores have reduced priority.'
                    else:board=validate_board(payload)
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
            with self._lock:
                details=dict(self._cell_captures)
            board=apply_cell_captures(board,details)
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
