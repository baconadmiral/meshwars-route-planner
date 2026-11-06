"""Read-only, player-attributed capture reports for explicit Meshtastic drive windows."""
import json
import math
import os
import re
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from capture_users import valid_event
from teams import TEAMS


class DriveReports:
    def __init__(self, key=None, api_url='https://meshwars.com/api/v1'):
        self._key = key
        self.api_url = api_url.rstrip('/')
        self._lock = threading.Lock()
        self._cache = {}
        self._roster = None
        self._roster_attempt = 0

    def status(self):
        return {'configured': bool(self._key), 'board': 'meshtastic',
                'player': os.environ.get('MESHWARS_PLAYER_NAME', ''),
                'node': os.environ.get('MESHWARS_NODE_ID', '')}

    def _get(self, path, params):
        if not self._key:
            raise ValueError('Set MESHWARS_API_KEY on the server and restart to enable drive reports.')
        request = Request(self.api_url + path + '?' + urlencode({'board': 'meshtastic', **params}),
                          headers={'X-API-Key': self._key, 'Accept': 'application/json',
                                   'User-Agent': 'MeshWarsRoutePlanner/0.1'})
        try:
            with urlopen(request, timeout=15) as response:
                raw = response.read(5 * 1024 * 1024 + 1)
            if len(raw) > 5 * 1024 * 1024:
                raise ValueError('MeshWars response too large.')
            data = json.loads(raw)
        except HTTPError as error:
            code = error.code
            error.close()
            raise ValueError('MeshWars API token rejected.' if code in (401, 403)
                             else 'MeshWars API unavailable; try again later.') from None
        except (OSError, ValueError):
            raise ValueError('MeshWars API unavailable or returned invalid data; try again later.') from None
        if not isinstance(data, dict) or data.get('board') not in ('meshtastic', 'mt'):
            raise ValueError('MeshWars returned an unexpected board.')
        return data

    def players(self):
        if not self._key:
            return {'configured': False, 'available': False, 'players': [], 'error': 'Set MESHWARS_API_KEY and restart to load players.'}
        with self._lock:
            now = time.time()
            if self._roster and now - self._roster_attempt < 1800:
                return self._roster
            self._roster_attempt = now
            try:
                payload = self._get('/players', {})
                rows = payload.get('players')
                if not isinstance(rows, list) or len(rows) > 50000:
                    raise ValueError('MeshWars returned an invalid player roster.')
                players = {}
                for row in rows:
                    if (not isinstance(row, dict) or not isinstance(row.get('name'), str)
                            or not row['name'].strip() or len(row['name']) > 100 or row.get('team') not in TEAMS):
                        raise ValueError('MeshWars returned an invalid player roster.')
                    name = row['name'].strip()
                    players[name.casefold()] = {'name': name, 'team': row['team']}
                self._roster = {'configured': True, 'available': True, 'board': 'meshtastic',
                                'players': sorted(players.values(), key=lambda p: p['name'].casefold()),
                                'last_success': now, 'stale': False}
            except ValueError as error:
                self._roster = {**(self._roster or {'players': [], 'available': False}),
                                'configured': True, 'stale': True, 'error': str(error)}
            return self._roster

    def identity(self, data):
        player = data.get('player')
        node = data.get('node')
        if not isinstance(player, str) or not 1 <= len(player.strip()) <= 100:
            raise ValueError('Enter your registered player name.')
        if not isinstance(node, str) or not re.fullmatch(r'!?[0-9a-fA-F]{8}', node):
            raise ValueError('Enter a node ID such as !0123abcd.')
        return player.strip(), node.lstrip('!').lower()

    def start(self, data):
        player, node = self.identity(data)
        payload = self._get('/players/' + quote(player, safe=''), {})
        profile = payload.get('player')
        if (not isinstance(profile, dict) or not isinstance(profile.get('name'), str)
                or profile['name'].casefold() != player.casefold()
                or profile.get('team') not in TEAMS):
            raise ValueError('MeshWars returned an invalid player profile.')
        radios = profile.get('radios', [])
        if not isinstance(radios, list) or node not in [r.lstrip('!').lower() for r in radios if isinstance(r, str)]:
            raise ValueError('That node is not listed for this player on the Meshtastic board.')
        return {'player': profile['name'], 'node': '!' + node, 'team': profile['team'],
                'started_at': time.time(), 'ended_at': None, 'board': 'meshtastic'}

    def report(self, data):
        player, node = self.identity(data)
        start, end = data.get('started_at'), data.get('ended_at')
        now = time.time()
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
               for v in (start, end)):
            raise ValueError('Provide valid drive start and end times.')
        if not now - 30 * 86400 <= start < end <= now + 5 or end - start > 86400:
            raise ValueError('Drive must be within the last 30 days and last less than 24 hours.')
        cache_key = (player.casefold(), node, start, end)
        # Serialize refreshes and share a short cache to avoid repeated button requests upstream.
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached and now - cached['checked_at'] < 30:
                return cached
            payload = self._get('/captures', {'since': max(0, math.floor(start) - 1), 'limit': 500})
            rows = payload.get('captures')
            if not isinstance(rows, list) or len(rows) > 500 or not all(valid_event(row) for row in rows):
                raise ValueError('MeshWars returned invalid capture events.')
            found = {}
            for row in rows:
                if start <= row['ts'] < end and row['player'].strip().casefold() == player.casefold():
                    if row['team'] not in TEAMS or row.get('from_team') not in (*TEAMS, None):
                        raise ValueError('MeshWars returned invalid capture teams.')
                    signature = (row['cell_id'], row['ts'], row['team'])
                    found[signature] = {k: row.get(k) for k in ('cell_id', 'ts', 'player', 'team', 'from_team')}
            events = sorted(found.values(), key=lambda row: (row['ts'], row['cell_id']))
            report = {'player': player, 'node': '!' + node, 'board': 'meshtastic',
                      'started_at': start, 'ended_at': end, 'checked_at': time.time(),
                      'capture_events': len(events), 'unique_squares': len({r['cell_id'] for r in events}),
                      'enemy_capture_events': sum(r['from_team'] is not None for r in events),
                      'unclaimed_capture_events': sum(r['from_team'] is None for r in events),
                      'feed_limit_reached': len(rows) == 500, 'events': events,
                      'confirmed_place_points': None, 'confirmed_defense_points': None,
                      'confirmed_total_points': None, 'attribution': 'player',
                      'notice': 'Captures are attributed to the player across all registered radios, not to an individual node. '
                                'Place awards and defense contributions are unavailable from this feed. '
                                'Delayed reports can change results; refresh later. This is not a net team-score calculation.'}
            if len(self._cache) >= 32:
                self._cache.pop(next(iter(self._cache)))
            self._cache[cache_key] = report
            return report
