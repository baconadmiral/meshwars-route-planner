"""Cached Meshtastic scoreboard totals, separate from per-square defense scores."""
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.request import Request, urlopen

from teams import TEAMS


def validate_scores(payload):
    if not isinstance(payload,dict) or not isinstance(payload.get('teams'),list):
        raise ValueError('Expected team standings.')
    teams=[]
    seen=set()
    for row in payload['teams']:
        if not isinstance(row,dict) or row.get('team') not in TEAMS or row['team'] in seen:
            raise ValueError('Invalid or duplicate team.')
        entry={'team':row['team']}
        for field in ('tiles','checkin_points','explorer_points','total'):
            value=row.get(field)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
                raise ValueError('Invalid team score.')
            if field=='tiles' and int(value)!=value:
                raise ValueError('Invalid territory count.')
            entry[field]=value
        teams.append(entry)
        seen.add(row['team'])
    if seen!=set(TEAMS):
        raise ValueError('Incomplete team scoreboard.')
    return {'teams':teams,'season_id':payload.get('season_id')}


class TeamScores:
    def __init__(self, cache_path, url='https://meshwars.com/scores'):
        self.path,self.url=Path(cache_path),url
        self._lock=threading.Lock()
        self.data=None
        self.last_success=None
        self.error=None
        self.source='unavailable'
        try:
            cached=json.loads(self.path.read_text())
            self.data=validate_scores(cached['data'])
            self.last_success=cached['last_success']
            self.source='cache'
        except (OSError,ValueError,KeyError,TypeError):
            pass

    def snapshot(self):
        with self._lock:
            return {'available':self.data is not None,'source':self.source,
                    'last_success':self.last_success,'stale':self.source!='live' or bool(self.error),
                    'error':self.error,'board':'meshtastic',
                    'teams':[dict(row) for row in self.data['teams']] if self.data else [],
                    'season_id':self.data.get('season_id') if self.data else None}

    def refresh(self):
        try:
            request=Request(self.url,headers={'Accept':'application/json','User-Agent':'MeshWarsRoutePlanner/0.1'})
            with urlopen(request,timeout=10) as response:
                raw=response.read(256*1024+1)
                if len(raw)>256*1024:
                    raise ValueError('Scoreboard response too large.')
                data=validate_scores(json.loads(raw))
            now=time.time()
            self.path.parent.mkdir(parents=True,exist_ok=True)
            temp=None
            try:
                with tempfile.NamedTemporaryFile(mode='w',dir=self.path.parent,delete=False) as handle:
                    temp=Path(handle.name)
                    json.dump({'data':data,'last_success':now},handle)
                os.replace(temp,self.path)
            finally:
                if temp:temp.unlink(missing_ok=True)
            with self._lock:
                self.data,self.last_success,self.source,self.error=data,now,'live',None
        except (OSError,ValueError,KeyError,TypeError):
            with self._lock:
                self.error='Team scores unavailable; retaining the last successful scoreboard.'
