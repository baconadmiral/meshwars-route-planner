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


def score_history(rows,now,season_id):
    """Retain four days and a boundary anchor, with a strict storage bound."""
    valid={}
    for row in rows[-1024:] if isinstance(rows,list) else []:
        try:
            at=row['at']
            if isinstance(at,bool) or not isinstance(at,(int,float)) or not math.isfinite(at) or not 0<at<=now:continue
            data=validate_scores(row)
            if data.get('season_id')!=season_id:continue
            valid[at]={'at':at,**data}
        except (ValueError,KeyError,TypeError):continue
    ordered=[valid[at] for at in sorted(valid)]
    cutoff=now-4*86400
    before=[row for row in ordered if row['at']<cutoff]
    recent=[row for row in ordered if row['at']>=cutoff]
    return ((before[-1:] if before else [])+recent)[-512:]


class TeamScores:
    def __init__(self, cache_path, url='https://meshwars.com/scores'):
        self.path,self.url=Path(cache_path),url
        self._lock=threading.Lock()
        self.data=None
        self.history=[]
        self.last_success=None
        self.error=None
        self.source='unavailable'
        try:
            cached=json.loads(self.path.read_text())
            self.data=validate_scores(cached['data'])
            self.last_success=cached['last_success']
            previous=cached.get('history',[])
            if not isinstance(previous,list):previous=[]
            self.history=score_history(previous+[{'at':self.last_success,**self.data}],time.time(),self.data.get('season_id'))
            self.source='cache'
        except (OSError,ValueError,KeyError,TypeError):
            pass

    def snapshot(self):
        with self._lock:
            return {'available':self.data is not None,'source':self.source,
                    'last_success':self.last_success,'stale':self.source!='live' or bool(self.error),
                    'error':self.error,'board':'meshtastic',
                    'teams':[dict(row) for row in self.data['teams']] if self.data else [],
                    'season_id':self.data.get('season_id') if self.data else None,
                    'history':[dict(row,teams=[dict(team) for team in row['teams']]) for row in self.history]}

    def refresh(self):
        try:
            request=Request(self.url,headers={'Accept':'application/json','User-Agent':'MeshWarsRoutePlanner/0.1'})
            with urlopen(request,timeout=10) as response:
                raw=response.read(256*1024+1)
                if len(raw)>256*1024:
                    raise ValueError('Scoreboard response too large.')
                data=validate_scores(json.loads(raw))
            now=time.time()
            with self._lock:previous=list(self.history)
            history=score_history(previous+[{'at':now,**data}],now,data.get('season_id'))
            self.path.parent.mkdir(parents=True,exist_ok=True)
            temp=None
            try:
                with tempfile.NamedTemporaryFile(mode='w',dir=self.path.parent,delete=False) as handle:
                    temp=Path(handle.name)
                    json.dump({'data':data,'last_success':now,'history':history},handle)
                os.replace(temp,self.path)
            finally:
                if temp:temp.unlink(missing_ok=True)
            with self._lock:
                self.data,self.last_success,self.source,self.error=data,now,'live',None
                self.history=history
        except (OSError,ValueError,KeyError,TypeError):
            with self._lock:
                self.error='Team scores unavailable; retaining the last successful scoreboard.'
