"""Optional player attribution from the documented MeshWars capture-event API."""
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def valid_event(event):
    return (isinstance(event,dict) and isinstance(event.get('cell_id'),str)
            and isinstance(event.get('player'),str) and bool(event['player'].strip())
            and isinstance(event.get('team'),str)
            and not isinstance(event.get('ts'),bool) and isinstance(event.get('ts'),(int,float))
            and math.isfinite(event['ts']) and event['ts']>0)


def enrich_board(board,events):
    """Never infer an individual from a team or a historical capture of the cell."""
    coverage=[]
    for cell in board['coverage']:
        enriched={k:v for k,v in cell.items() if k!='captured_by'}
        event=events.get(cell['cell_id'])
        if event and valid_event(event) and event['team']==cell['owner_team'] and event['ts']==cell.get('captured_at'):
            enriched['captured_by']=event['player'].strip()
        coverage.append(enriched)
    return dict(board,coverage=coverage)


class CaptureUsers:
    def __init__(self,cache_path,key=None,api_url='https://meshwars.com/api/v1'):
        self.cache_path=Path(cache_path)
        self._key=key
        self.api_url=api_url.rstrip('/')
        self._lock=threading.Lock()
        self.events={}
        self.since=0
        self.last_success=None
        self.error=None
        try:
            cached=json.loads(self.cache_path.read_text())
            rows=cached['events']
            self.events={row['cell_id']:row for row in rows if valid_event(row)}
            self.since=max((row['ts'] for row in self.events.values()),default=0)
            self.last_success=cached.get('last_success')
        except (OSError,ValueError,KeyError,TypeError):
            pass

    def status(self):
        with self._lock:
            return {'configured':bool(self._key),'last_success':self.last_success,'error':self.error,
                    'tracked_cells':len(self.events),'partial':True}

    def refresh(self):
        if not self._key:
            return
        try:
            # Replay the last timestamp to avoid losing events with equal second timestamps.
            query=urlencode({'board':'meshcore','since':max(0,self.since-1),'limit':500})
            request=Request(self.api_url+'/captures?'+query,
                            headers={'X-API-Key':self._key,'Accept':'application/json','User-Agent':'MeshWarsBluePlanner/0.1'})
            with urlopen(request,timeout=15) as response:
                raw=response.read(5*1024*1024+1)
                if len(raw)>5*1024*1024:
                    raise ValueError('Capture feed too large.')
                payload=json.loads(raw)
            if not isinstance(payload,dict) or not isinstance(payload.get('captures'),list):
                raise ValueError('Invalid capture feed.')
            if payload.get('board') not in (None,'meshcore','mc'):
                raise ValueError('Wrong capture board.')
            rows=payload['captures']
            if not all(valid_event(row) for row in rows):
                raise ValueError('Invalid capture event.')
            with self._lock:
                events=dict(self.events)
            for row in rows:
                previous=events.get(row['cell_id'])
                if previous is None or row['ts']>previous['ts']:
                    events[row['cell_id']]={key:row[key] for key in ('cell_id','ts','player','team')}
            # Bounded cache: only the most recent event per cell, up to 50,000 cells.
            events=dict(sorted(events.items(),key=lambda item:item[1]['ts'],reverse=True)[:50000])
            now=time.time()
            self._persist(events,now)
            with self._lock:
                self.events=events
                self.since=max([self.since]+[row['ts'] for row in rows])
                self.last_success=now
                self.error=None
        except HTTPError as error:
            code=error.code
            error.close()
            with self._lock:
                self.error='MeshWars integration API key was rejected.' if code in (401,403) else 'Player capture feed unavailable; retaining cached attribution.'
        except (OSError,ValueError,TypeError):
            with self._lock:
                self.error='Player capture feed unavailable; retaining cached attribution.'

    def _persist(self,events,now):
        self.cache_path.parent.mkdir(parents=True,exist_ok=True)
        temp_path=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',dir=self.cache_path.parent,delete=False) as handle:
                temp_path=Path(handle.name)
                json.dump({'events':list(events.values()),'last_success':now},handle)
            os.replace(temp_path,self.cache_path)
        finally:
            if temp_path is not None:temp_path.unlink(missing_ok=True)

    def enrich(self,board):
        with self._lock:events=self.events
        return enrich_board(board,events)
