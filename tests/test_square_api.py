import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from board_feed import BoardFeed, merge_api_board
from square_api import SquareAPI, capture_from_cell, normalize_evidence_summary


def cell(**changes):
    return {'cell_id':'0_0','owner_team':'BLUE','south':0,'west':0,'north':.0027,'east':.00384,
            'last_report_ts':150,'captured_at':100,'scores':{'BLUE':3},**changes}


def response(data):
    result=io.BytesIO(json.dumps(data).encode());result.headers={};return result


class SquareAPITests(unittest.TestCase):
    def test_cell_api_matches_capture_not_later_defender_and_caches(self):
        c=cell(recent_captures=[{'ts':101,'by_team':'BLUE','by_display_name':'Defender'},
                                {'ts':100,'by_team':'RED','by_display_name':'Wrong'},
                                {'ts':100,'by_team':'BLUE','by_display_name':'🥓'}])
        api=SquareAPI('secret')
        with patch.object(api.client,'_get',return_value={'cell':c}) as fetch:
            detail=api.cell('0_0')
            self.assertEqual(detail['captured_by'],'🥓')
            self.assertEqual(api.cell('0_0'),detail)
            fetch.assert_called_once_with('/cells/0_0',{})
        self.assertIsNone(capture_from_cell(cell(recent_captures=[{'ts':99,'by_team':'BLUE','by_display_name':'Old'}])))
        self.assertNotIn('secret',json.dumps(detail))
        for invalid in ('../players','0_0?x=1','0_0/extra'):
            with self.assertRaises(ValueError):api.cell(invalid)

    def test_square_evidence_is_sanitized_without_inventing_failures(self):
        evidence={'verified_tx_count':4,'passive_rx_count':2,'other_count':0,'max_watcher_count':3,'private_node':'omit'}
        api=SquareAPI('secret')
        with patch.object(api.client,'_get',return_value={'cell':cell(evidence_summary=evidence)}):
            result=api.cell('0_0')
        self.assertEqual(result['evidence_summary']['verified_tx_count'],4)
        self.assertNotIn('private_node',result['evidence_summary'])
        self.assertIsNone(normalize_evidence_summary({'verified_tx_count':True,'passive_rx_count':-1}))
        self.assertEqual(normalize_evidence_summary({'verified_tx_count':0})['verified_tx_count'],0)
        self.assertNotIn('failed',result['evidence_summary'])

    def test_uncached_requests_are_paced_and_cache_hits_skip_wait(self):
        api=SquareAPI('secret')
        with patch.object(api.client,'_get',side_effect=[{'cell':cell()},{'cell':cell(cell_id='0_1')}]) as fetch, patch('square_api.time.monotonic',return_value=10), patch('square_api.time.sleep') as sleep:
            api.cell('0_0');api.cell('0_0');api.cell('0_1')
        self.assertEqual(fetch.call_count,2)
        sleep.assert_called_once()
        self.assertAlmostEqual(sleep.call_args.args[0],1.1)

    def test_api_board_merges_only_synchronized_scores(self):
        bulk=cell();bulk.pop('scores');bulk.pop('captured_at')
        result=merge_api_board({'coverage':[bulk]},{'coverage':[cell()]})
        self.assertEqual(result['coverage'][0]['scores'],{'BLUE':3})
        self.assertEqual(result['coverage'][0]['captured_at'],100)
        for changes in ({'owner_team':'RED'},{'last_report_ts':151},{'west':-.01}):
            result=merge_api_board({'coverage':[bulk]},{'coverage':[cell(**changes)]})
            self.assertNotIn('scores',result['coverage'][0])
            self.assertIn('data_warning',result)

    def test_authenticated_fetch_supplement_failure_and_key_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            feed=BoardFeed(Path(tmp)/'seed',Path(tmp)/'cache',api_key='secret')
            bulk=cell();bulk.pop('scores');bulk.pop('captured_at')
            with patch('board_feed.urlopen',side_effect=[response({'board':'meshtastic','cells':[bulk]}),response({'coverage':[cell()]})]) as fetch:
                feed.refresh()
            self.assertEqual(feed.snapshot()['coverage'][0]['scores'],{'BLUE':3})
            self.assertIn('/api/v1/board?board=meshtastic',fetch.call_args_list[0].args[0].full_url)
            self.assertEqual(fetch.call_args_list[0].args[0].get_header('X-api-key'),'secret')
            self.assertIsNone(fetch.call_args_list[1].args[0].get_header('X-api-key'))
            self.assertNotIn('secret',Path(tmp,'cache').read_text())
            feed._last_attempt=None
            with patch('board_feed.urlopen',side_effect=[response({'board':'meshtastic','cells':[bulk]}),URLError('offline')]):
                feed.refresh()
            snapshot=feed.snapshot()
            self.assertEqual(snapshot['source'],'live')
            self.assertIn('unavailable',snapshot['data_warning'])
            self.assertNotIn('scores',snapshot['coverage'][0])

    def test_details_only_update_exact_current_square_and_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            seed=Path(tmp)/'seed';seed.write_text(json.dumps({'coverage':[cell()]}))
            feed=BoardFeed(seed,Path(tmp)/'cache')
            previous=feed.snapshot()['revision']
            detail={'capture_event':{'cell_id':'0_0','ts':100,'team':'BLUE','player':'🥓'}}
            feed.apply_cell_detail(detail)
            self.assertEqual(feed.snapshot()['coverage'][0]['captured_by'],'🥓')
            self.assertNotEqual(feed.snapshot()['revision'],previous)
            feed.apply_cell_detail({'capture_event':{'cell_id':'0_0','ts':99,'team':'BLUE','player':'Wrong'}})
            self.assertEqual(feed.snapshot()['coverage'][0]['captured_by'],'🥓')
