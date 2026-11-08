"""Daily capture-date counts from the current board, never inferred event history."""
from datetime import datetime, timedelta, timezone
import math
import time

from teams import TEAMS


def territory_report(snapshot, now=None):
    now = time.time() if now is None else now
    today = datetime.fromtimestamp(now, timezone.utc).date()
    start = today - timedelta(days=29)
    start_ts = datetime.combine(start, datetime.min.time(), timezone.utc).timestamp()
    days = [{'date': (start + timedelta(days=i)).isoformat(),
             'teams': {team: 0 for team in TEAMS}, 'total': 0} for i in range(30)]
    missing = outside = unknown_team = 0
    seen = set()
    for cell in snapshot.get('coverage', []) if snapshot.get('available') else []:
        cell_id = cell.get('cell_id')
        if not isinstance(cell_id, str) or cell_id in seen:
            continue
        seen.add(cell_id)
        team = cell.get('owner_team')
        if team not in TEAMS:
            unknown_team += 1
            continue
        captured = cell.get('captured_at')
        if (isinstance(captured, bool) or not isinstance(captured, (int, float))
                or not math.isfinite(captured) or captured <= 0 or captured > now):
            missing += 1
            continue
        if captured < start_ts:
            outside += 1
            continue
        index = (datetime.fromtimestamp(captured, timezone.utc).date() - start).days
        days[index]['teams'][team] += 1
        days[index]['total'] += 1
    available = bool(snapshot.get('available'))
    return {'available': available, 'board': 'meshtastic', 'timezone': 'UTC',
            'metric': 'currently_held_squares_by_capture_date',
            'start_date': start.isoformat(), 'end_date': today.isoformat(),
            'generated_at': now, 'board_updated_at': snapshot.get('last_success'),
            'source': snapshot.get('source'), 'stale': bool(snapshot.get('stale')),
            'error': snapshot.get('error'), 'days': days if available else [],
            'teams': list(TEAMS),
            'total': sum(day['total'] for day in days) if available else None,
            'missing_capture_time_count': missing, 'outside_window_count': outside,
            'unknown_team_count': unknown_team,
            'notice': 'One territory point per currently held square, grouped by its last capture date. '
                      'Squares later lost are absent. This is not complete capture history or net daily gain. '
                      'Check-in, exploration and defense points are excluded. '
                      'Missing, invalid or future capture times are excluded. Today is incomplete.'}
