import json
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from drive_reports import DriveReports


class Response:
    def __init__(self, data): self.data = json.dumps(data).encode()
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return self.data[:limit]


class DriveReportTests(unittest.TestCase):
    def setUp(self):
        self.service = DriveReports('secret')
        self.now = time.time()
        self.data = {'player':'🥓', 'node':'!018c0be1', 'started_at':self.now-100, 'ended_at':self.now-10}

    def event(self, cell='0_0', **kwargs):
        return {'cell_id':cell, 'ts':self.now-50, 'player':'🥓', 'team':'BLUE', 'from_team':None, **kwargs}

    def test_identity_encoded_and_node_verified(self):
        with patch('drive_reports.urlopen', return_value=Response({'board':'meshtastic','player':{'name':'🥓','team':'BLUE','radios':['018c0be1']}})) as call:
            session = self.service.start(self.data)
        self.assertEqual(session['node'],'!018c0be1')
        self.assertIn('/players/%F0%9F%A5%93?board=meshtastic',call.call_args.args[0].full_url)
        self.assertEqual(call.call_args.args[0].get_header('X-api-key'),'secret')
        self.assertNotIn('secret', json.dumps(session))
        with patch.object(self.service,'_get',return_value={'player':{'name':'🥓','team':'BLUE','radios':['deadbeef']}}):
            with self.assertRaisesRegex(ValueError,'not listed'): self.service.start(self.data)

    def test_report_filters_time_player_and_deduplicates_events(self):
        first=self.event()
        events=[first, first, self.event('0_1',from_team='RED'),
                self.event(ts=self.data['started_at']-1), self.event(ts=self.data['ended_at']),
                self.event(player='Other'), self.event(ts=self.now-40,from_team='RED')]
        with patch('drive_reports.urlopen',return_value=Response({'board':'meshtastic','captures':events})) as call:
            result=self.service.report(self.data)
            self.assertEqual(self.service.report(self.data),result)
            self.assertEqual(call.call_count,1)
        self.assertEqual(result['capture_events'],3)
        self.assertEqual(result['unique_squares'],2)
        self.assertEqual(result['enemy_capture_events'],2)
        self.assertEqual(result['unclaimed_capture_events'],1)
        self.assertFalse(result['feed_limit_reached'])
        self.assertIsNone(result['confirmed_total_points'])
        self.assertIsNone(result['confirmed_place_points'])
        self.assertEqual(result['attribution'],'player')

    def test_full_feed_explicitly_incomplete(self):
        rows=[self.event(str(i),player='Other') for i in range(500)]
        with patch.object(self.service,'_get',return_value={'captures':rows}):
            result=self.service.report(self.data)
        self.assertTrue(result['feed_limit_reached'])
        self.assertEqual(result['unique_squares'],0)

    def test_invalid_windows_and_identity_do_not_call_provider(self):
        for update in ({'started_at':True},{'ended_at':self.now+100},{'ended_at':self.now-1000},
                       {'started_at':self.now-90000},{'node':'bad'},{'player':''},{'ended_at':float('nan')}):
            with self.subTest(update=update), patch('drive_reports.urlopen') as call:
                with self.assertRaises(ValueError): self.service.report({**self.data,**update})
                call.assert_not_called()

    def test_missing_key_auth_failure_wrong_board_and_bad_events(self):
        with self.assertRaisesRegex(ValueError,'MESHWARS_API_KEY'):
            DriveReports().report(self.data)
        with patch('drive_reports.urlopen',side_effect=HTTPError('https://example',401,'bad',{},None)):
            with self.assertRaisesRegex(ValueError,'token rejected'): self.service.report(self.data)
        with patch('drive_reports.urlopen',return_value=Response({'board':'meshcore','captures':[]})):
            with self.assertRaisesRegex(ValueError,'unexpected board'): self.service.report(self.data)
        with patch.object(self.service,'_get',return_value={'captures':[{'ts':3}]}):
            with self.assertRaisesRegex(ValueError,'invalid capture'): self.service.report(self.data)

    def test_player_roster_is_sanitized_cached_and_has_failure_fallback(self):
        with patch.object(self.service,'_get',return_value={'players':[{'name':'🥓','team':'BLUE','radios':['private'],'extra':'ignored'}]}) as fetch:
            result=self.service.players()
            self.assertEqual(result['players'],[{'name':'🥓','team':'BLUE'}])
            self.assertEqual(self.service.players(),result)
            fetch.assert_called_once_with('/players',{})
        self.service._roster_attempt=0
        with patch.object(self.service,'_get',side_effect=ValueError('API unavailable')):
            fallback=self.service.players()
        self.assertTrue(fallback['stale'])
        self.assertEqual(fallback['players'],result['players'])
        self.assertFalse(DriveReports().players()['configured'])

    def test_invalid_roster_does_not_return_untrusted_fields(self):
        with patch.object(self.service,'_get',return_value={'players':[{'name':'Bad','team':'INVALID'}]}):
            result=self.service.players()
        self.assertFalse(result['available'])
        self.assertEqual(result['players'],[])
