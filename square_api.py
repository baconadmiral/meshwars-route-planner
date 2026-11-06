"""Authenticated Meshtastic square details, bounded and cached on demand."""
import re
import threading
import time
from drive_reports import DriveReports
from capture_users import valid_event
from teams import TEAMS


def capture_from_cell(cell):
    """Match the exact ownership event; later defenders are not the capturer."""
    rows=cell.get('recent_captures',[])
    if not isinstance(rows,list):return None
    for row in rows:
        if not isinstance(row,dict):continue
        event={'cell_id':cell.get('cell_id'),'ts':row.get('ts'),
               'team':row.get('by_team'),'player':row.get('by_display_name')}
        if (valid_event(event) and event['team'] in TEAMS
                and event['team']==cell.get('owner_team') and event['ts']==cell.get('captured_at')):
            event['player']=event['player'].strip()
            return event
    return None


class SquareAPI:
    def __init__(self,key=None,api_url='https://meshwars.com/api/v1'):
        self.client=DriveReports(key,api_url)
        self._lock=threading.Lock()
        self._cache={}
        self._next_request=0

    def cell(self,cell_id):
        if not isinstance(cell_id,str) or not re.fullmatch(r'-?\d{1,8}_-?\d{1,8}',cell_id):
            raise ValueError('Invalid square ID.')
        with self._lock:
            now=time.time()
            cached=self._cache.get(cell_id)
            if cached and now-cached['checked_at']<300:return cached
            # Shared pacing applies to clicks and background requests from every browser.
            delay=self._next_request-time.monotonic()
            if delay>0:time.sleep(delay)
            self._next_request=time.monotonic()+1.1
            payload=self.client._get('/cells/'+cell_id,{})
            cell=payload.get('cell')
            if not isinstance(cell,dict) or cell.get('cell_id')!=cell_id or cell.get('owner_team') not in TEAMS:
                raise ValueError('MeshWars returned an invalid square.')
            event=capture_from_cell(cell)
            result={'cell_id':cell_id,'owner_team':cell['owner_team'],
                    'captured_at':cell.get('captured_at'),'last_report_ts':cell.get('last_report_ts'),
                    'scores':cell.get('scores'),'captured_by':event['player'] if event else None,
                    'capture_event':event,'checked_at':now,'source':'meshwars-api'}
            if len(self._cache)>=512:self._cache.pop(next(iter(self._cache)))
            self._cache[cell_id]=result
            return result
