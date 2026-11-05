"""Short-lived, unguessable GPX download links; personal tracks stay in memory."""
import secrets
import threading
import time

from navigation import build_export
from teams import validate_team


class ShareCapacityError(Exception):
    pass


class GPXShares:
    def __init__(self, ttl_seconds=3600, max_bytes=32*1024*1024, max_items=100, clock=time.time):
        self.ttl_seconds, self.max_bytes, self.max_items = ttl_seconds, max_bytes, max_items
        self.clock = clock
        self._items = {}
        self._bytes = 0
        self._lock = threading.Lock()

    def _prune(self, now):
        for token, item in list(self._items.items()):
            if item['expires_at'] <= now:
                self._bytes -= len(item['body'])
                del self._items[token]

    def create(self, route):
        exported = build_export(route)
        team = validate_team(route.get('team', 'BLUE'))
        body = exported['gpx'].encode('utf-8')
        if len(body) > 8*1024*1024:
            raise ValueError('GPX is too large for a temporary QR link. Download the file instead.')
        with self._lock:
            now = self.clock()
            self._prune(now)
            if len(self._items) >= self.max_items or self._bytes+len(body) > self.max_bytes:
                raise ShareCapacityError('Temporary GPX sharing is full. Download the file or try again after existing links expire.')
            token = secrets.token_urlsafe(24)
            expires = now+self.ttl_seconds
            self._items[token] = {'body': body, 'filename': f'{team.lower()}-route.gpx', 'expires_at': expires}
            self._bytes += len(body)
        return {'download_path': f'/api/gpx-shares/{token}.gpx', 'expires_at': expires,
                'expires_in_seconds': self.ttl_seconds}

    def get(self, token):
        with self._lock:
            self._prune(self.clock())
            item = self._items.get(token)
            return dict(item) if item else None
