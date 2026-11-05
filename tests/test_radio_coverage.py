import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from radio_coverage import RadioCoverage, annotate_routes, normalize_event
from planner import opportunity_score
from server import Handler


def event(identity='verified_tx:one', kind='verified_tx', lon=.001, lat=.001):
    return {'event_id':identity, 'event_type':kind, 'longitude':lon, 'latitude':lat,
            'occurred_at':'2026-11-04T12:00:00Z', 'radio_node_id':'private-radio'}


def page(events, cursor='next', more=False):
    return io.BytesIO(json.dumps({'schema_version':1,'events':events,
                                 'next_cursor':cursor,'has_more':more}).encode())


class RadioCoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path=Path(self.directory.name)/'coverage.json'
        self.feed=RadioCoverage(self.path,token='secret-test-token')

    def test_unconfigured_never_fetches_or_exposes_cached_data(self):
        with patch('radio_coverage.urlopen') as fetch:
            feed=RadioCoverage(self.path)
            feed.refresh()
        fetch.assert_not_called()
        self.assertFalse(feed.snapshot()['configured'])
        self.assertEqual(feed.snapshot()['events'],[])

    def test_paginated_import_deduplicates_and_persists_cursor_without_secrets(self):
        with patch('radio_coverage.urlopen',side_effect=[page([event()], 'first', True),
                                                       page([event(),event('passive_rx:two','passive_rx')])]) as fetch:
            self.feed.refresh()
        self.assertEqual(len(self.feed.snapshot()['events']),2)
        request=fetch.call_args_list[1].args[0]
        self.assertIn('cursor=first',request.full_url)
        self.assertNotIn('secret-test-token',request.full_url)
        raw=self.path.read_text()
        self.assertNotIn('secret-test-token',raw)
        self.assertNotIn('private-radio',raw)
        restored=RadioCoverage(self.path,token='another-token')
        self.assertEqual(restored.cursor,'next')
        self.assertEqual(len(restored.snapshot()['events']),2)
        other_region=RadioCoverage(self.path,token='test',region='OTHER')
        self.assertEqual(other_region.snapshot()['events'],[])

    def test_failed_page_does_not_advance_cursor_or_erase_evidence(self):
        with patch('radio_coverage.urlopen',return_value=page([event()])):
            self.feed.refresh()
        with patch('radio_coverage.urlopen',return_value=page([event(kind='not_heard')],'bad')):
            self.feed.refresh()
        self.assertEqual(self.feed.cursor,'next')
        self.assertTrue(self.feed.snapshot()['stale'])
        self.assertEqual(len(self.feed.snapshot()['events']),1)
        with patch('radio_coverage.urlopen',side_effect=URLError('offline')):
            self.feed.refresh()
        self.assertEqual(self.feed.cursor,'next')

    def test_empty_page_is_unknown_and_http_access_errors_pause_polling(self):
        with patch('radio_coverage.urlopen',return_value=page([])):
            self.feed.refresh()
        self.assertTrue(self.feed.snapshot()['available'])
        self.assertFalse(self.feed.snapshot()['negative_evidence_available'])
        error=HTTPError('https://example.invalid',401,'Unauthorized',{},None)
        with patch('radio_coverage.urlopen',side_effect=error):
            self.feed.refresh()
        self.assertTrue(self.feed._suspended)
        self.assertNotIn('secret-test-token',json.dumps(self.feed.snapshot()))

    def test_rate_limit_and_cache_failure_retain_cursor(self):
        with patch('radio_coverage.urlopen',return_value=page([event()])):
            self.feed.refresh()
        error=HTTPError('https://example.invalid',429,'Slow down',{'Retry-After':'3600'},None)
        with patch('radio_coverage.urlopen',side_effect=error):
            self.feed.refresh()
        self.assertEqual(self.feed._retry_delay,3600)
        self.assertEqual(self.feed.cursor,'next')
        with patch('radio_coverage.urlopen',return_value=page([event('tx:new')],'later')), \
             patch.object(self.feed,'_persist',side_effect=OSError('disk full')):
            self.feed.refresh()
        self.assertEqual(self.feed.cursor,'next')
        self.assertEqual(len(self.feed.snapshot()['events']),1)

    def test_route_counts_use_nearby_points_once_and_preserve_scores(self):
        route=opportunity_score({'geometry':{'coordinates':[[.0001,.001],[.011,.001]]},
                                 'duration':100,'distance':1000},[])
        snapshot=self.feed.snapshot()
        snapshot['events']=[normalize_event(event()),normalize_event(event('tx:duplicate')),
                            normalize_event(event('rx:same','passive_rx')),
                            normalize_event(event('rx:next','passive_rx',lon=.005)),
                            normalize_event(event('tx:far','verified_tx',lon=.009,lat=.0025))]
        result={'routes':[route],'baseline':route,'strategy_results':{'beam':{'routes':[route]}}}
        before=route['capture_value']
        annotate_routes(result,snapshot)
        counts=route['radio_coverage']
        self.assertEqual(counts['verified_tx'],1)
        self.assertEqual(counts['passive_rx_only'],1)
        self.assertEqual(counts['unknown'],1)
        self.assertEqual(sum(counts['targets'].values()),route['target_count'])
        self.assertEqual(route['capture_value'],before)
        self.assertNotIn('events',result['radio_coverage'])
        snapshot['events']=[]
        annotate_routes(result,snapshot)
        self.assertEqual(route['radio_coverage']['unknown'],route['square_count'])

    def test_invalid_coordinates_and_times_rejected(self):
        for changes in ({'latitude':True},{'longitude':float('nan')},
                        {'latitude':91},{'occurred_at':'2026-11-04'},
                        {'event_type':'not_heard'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                normalize_event(dict(event(),**changes))

    def test_public_endpoint_needs_no_partner_key(self):
        class Connection:
            def __init__(self):
                self.request=io.BytesIO(b'GET /api/radio-coverage HTTP/1.0\r\n\r\n')
                self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        connection=Connection()
        Handler(connection,('127.0.0.1',0),SimpleNamespace())
        head,body=bytes(connection.response).split(b'\r\n\r\n',1)
        self.assertIn(b'200 OK',head)
        self.assertFalse(json.loads(body)['configured'])
