import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs,urlparse

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from capture_users import CaptureUsers,enrich_board
from board_feed import BoardFeed


def event(player='Test player',ts=100,team='BLUE'):
    return {'cell_id':'0_0','ts':ts,'player':player,'team':team}


def board():
    return {'coverage':[{'cell_id':'0_0','owner_team':'BLUE','captured_at':100,
                         'south':0,'north':.0027,'west':0,'east':.00384}]}


class CaptureUsersTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.cache=self.root/'users.json'
        self.client=CaptureUsers(self.cache,key='test-only-key')

    def tearDown(self):self.temp.cleanup()

    def refresh(self,rows):
        with patch('capture_users.urlopen',return_value=io.BytesIO(json.dumps({'board':'meshtastic','captures':rows}).encode())) as fetch:
            self.client.refresh()
            return fetch

    def test_only_exact_current_capture_is_attributed(self):
        original=board()
        self.assertEqual(enrich_board(original,{'0_0':event()})['coverage'][0]['captured_by'],'Test player')
        for row in (event(ts=99),event(team='RED')):
            self.assertNotIn('captured_by',enrich_board(original,{'0_0':row})['coverage'][0])
        self.assertNotIn('captured_by',original['coverage'][0])
        original['coverage'][0]['captured_by']='Stale name'
        self.assertNotIn('captured_by',enrich_board(original,{})['coverage'][0])

    def test_old_meshcore_cache_is_ignored_and_wrong_board_is_rejected(self):
        self.cache.write_text(json.dumps({'board':'meshcore','events':[event()]}))
        self.assertEqual(CaptureUsers(self.cache).events,{})
        with patch('capture_users.urlopen',return_value=io.BytesIO(json.dumps({'board':'meshcore','captures':[event()]}).encode())):
            self.client.refresh()
        self.assertEqual(self.client.events,{})
        self.assertIsNotNone(self.client.status()['error'])

    def test_no_key_makes_no_outbound_requests(self):
        client=CaptureUsers(self.cache)
        with patch('capture_users.urlopen') as fetch:
            client.refresh();fetch.assert_not_called()
        self.assertFalse(client.status()['configured'])

    def test_authenticated_feed_caches_names_without_key(self):
        fetch=self.refresh([event()])
        request=fetch.call_args.args[0]
        self.assertEqual(request.get_header('X-api-key'),'test-only-key')
        params=parse_qs(urlparse(request.full_url).query)
        self.assertEqual(params['board'],['meshtastic'])
        self.assertEqual(params['limit'],['500'])
        self.assertNotIn('test-only-key',self.cache.read_text())
        restarted=CaptureUsers(self.cache)
        self.assertEqual(restarted.enrich(board())['coverage'][0]['captured_by'],'Test player')
        self.assertTrue(self.client.status()['partial'])

    def test_older_events_cannot_overwrite_newer_and_cursor_overlaps_last_second(self):
        self.refresh([event(ts=100)])
        fetch=self.refresh([event(player='New player',ts=110),event(player='Old player',ts=90)])
        params=parse_qs(urlparse(fetch.call_args.args[0].full_url).query)
        self.assertEqual(params['since'],['99'])
        self.assertEqual(self.client.events['0_0']['player'],'New player')
        self.assertEqual(self.client.since,110)
        self.assertNotIn('captured_by',self.client.enrich(board())['coverage'][0])

    def test_rejected_key_keeps_cached_events_and_is_reported(self):
        self.refresh([event()])
        error=HTTPError('https://example.test',401,'Unauthorized',{},io.BytesIO())
        with patch('capture_users.urlopen',side_effect=error):self.client.refresh()
        self.assertEqual(self.client.events['0_0']['player'],'Test player')
        self.assertIn('rejected',self.client.status()['error'])
        self.assertNotIn('test-only-key',json.dumps(self.client.status()))

    def test_board_refresh_joins_player_metadata_and_updates_revision(self):
        seed=self.root/'nodes.json';seed.write_text(json.dumps(board()))
        feed=BoardFeed(seed,self.root/'board.json',capture_users=self.client)
        previous=feed.snapshot()['revision']
        response=io.BytesIO(json.dumps(board()).encode());response.headers={}
        captures=io.BytesIO(json.dumps({'board':'meshtastic','captures':[event()]}).encode())
        with patch('board_feed.urlopen',return_value=response),patch('capture_users.urlopen',return_value=captures):
            feed.refresh()
        snapshot=feed.snapshot()
        self.assertEqual(snapshot['coverage'][0]['captured_by'],'Test player')
        self.assertNotEqual(snapshot['revision'],previous)
        self.assertTrue(snapshot['attribution']['configured'])

if __name__=='__main__':unittest.main()
