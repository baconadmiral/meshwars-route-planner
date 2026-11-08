"""Deterministic UTC windows and honest current-holdings report semantics."""
from datetime import datetime, timezone
import unittest

from territory_reports import territory_report


NOW = datetime(2026, 11, 8, 12, tzinfo=timezone.utc).timestamp()
START = datetime(2026, 10, 10, tzinfo=timezone.utc).timestamp()


def cell(cell_id, captured_at, team='BLUE'):
    return {'cell_id': cell_id, 'captured_at': captured_at, 'owner_team': team}


class TerritoryReportTests(unittest.TestCase):
    def test_thirty_calendar_days_include_today_and_boundary(self):
        result = territory_report({'available': True, 'coverage': [
            cell('before', START - 1), cell('boundary', START),
            cell('yesterday', NOW - 86400, 'RED'), cell('today', NOW)]}, NOW)
        self.assertEqual(len(result['days']), 30)
        self.assertEqual(result['start_date'], '2026-10-10')
        self.assertEqual(result['end_date'], '2026-11-08')
        self.assertEqual(result['days'][0]['teams']['BLUE'], 1)
        self.assertEqual(result['days'][-2]['teams']['RED'], 1)
        self.assertEqual(result['days'][-1]['teams']['BLUE'], 1)
        self.assertEqual(result['total'], 3)
        self.assertEqual(result['outside_window_count'], 1)

    def test_invalid_times_and_unsupported_owners_are_excluded(self):
        values = [None, True, '123', float('nan'), float('inf'), -1, 0, NOW+1]
        rows = [cell(str(i), value) for i, value in enumerate(values)]
        rows.append(cell('unknown-team', NOW, 'UNKNOWN'))
        result = territory_report({'available': True, 'coverage': rows}, NOW)
        self.assertEqual(result['total'], 0)
        self.assertEqual(result['missing_capture_time_count'], len(values))
        self.assertEqual(result['unknown_team_count'], 1)

    def test_counts_each_current_square_once_for_its_current_owner(self):
        row = cell('recaptured', NOW, 'RED')
        result = territory_report({'available': True, 'coverage': [row, row]}, NOW)
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['days'][-1]['teams']['RED'], 1)
        self.assertEqual(result['days'][-1]['teams']['BLUE'], 0)
        self.assertIn('not complete capture history', result['notice'])

    def test_unavailable_is_not_a_zero_activity_report(self):
        result = territory_report({'available': False, 'error': 'Waiting for board'}, NOW)
        self.assertFalse(result['available'])
        self.assertIsNone(result['total'])
        self.assertEqual(result['days'], [])

    def test_empty_available_board_and_stale_metadata(self):
        result = territory_report({'available': True, 'coverage': [], 'stale': True,
                                   'last_success': NOW-3600, 'source': 'cache'}, NOW)
        self.assertEqual(result['total'], 0)
        self.assertEqual(len(result['days']), 30)
        self.assertTrue(result['stale'])
        self.assertEqual(result['board_updated_at'], NOW-3600)
        self.assertTrue(all(day['total'] == 0 for day in result['days']))
