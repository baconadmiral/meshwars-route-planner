import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from types import SimpleNamespace
from server import Handler

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from board_feed import BoardFeed, validate_board


def board(team='BLUE'):
    return {'coverage':[{'cell_id':'0_0','owner_team':team,'scores':{team:.5},
                         'south':0,'north':.0027,'west':0,'east':.00384,'captured_at':100}]}


class Response(io.BytesIO):
    def __init__(self,data,headers=None):
        super().__init__(json.dumps(data).encode())
        self.headers=headers or {}


class BoardFeedTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.root=Path(self.directory.name)
        self.seed=self.root/'nodes.json'
        self.seed.write_text(json.dumps(board()))
        self.cache=self.root/'cache'/'board.json'
        self.feed=BoardFeed(self.seed,self.cache)

    def tearDown(self):
        self.directory.cleanup()

    def refresh(self,response=None,error=None,clock=100):
        with patch('board_feed.time.monotonic',return_value=clock),patch('board_feed.urlopen',side_effect=error,return_value=response) as fetch:
            self.feed.refresh()
            return fetch

    def test_live_refresh_replaces_board_and_persists_without_modifying_seed(self):
        old=self.feed.snapshot()
        self.assertEqual(old['source'],'snapshot')
        self.assertEqual(old['refresh_interval'],1800)
        self.assertTrue(old['stale'])
        response=Response(board('RED'),{'ETag':'"v1"'})
        fetch=self.refresh(response)
        current=self.feed.snapshot()
        self.assertEqual(current['coverage'][0]['owner_team'],'RED')
        self.assertNotEqual(current['revision'],old['revision'])
        self.assertEqual(current['source'],'live')
        self.assertFalse(current['stale'])
        self.assertEqual(json.loads(self.seed.read_text()),board())
        self.assertEqual(json.loads(self.cache.read_text())['board'],board('RED'))
        self.assertNotIn('Cookie',fetch.call_args.args[0].headers)
        # Readers holding an earlier snapshot retain their original records.
        self.assertEqual(old['coverage'][0]['owner_team'],'BLUE')

    def test_not_modified_reuses_board_and_updates_success_metadata(self):
        self.refresh(Response(board(),{'ETag':'"v1"','Last-Modified':'Wed, 04 Nov 2026 12:00:00 GMT'}))
        before=self.feed.snapshot()
        error=HTTPError(self.feed.url,304,'Not Modified',{},io.BytesIO())
        fetch=self.refresh(error=error,clock=200)
        after=self.feed.snapshot()
        self.assertEqual(after['revision'],before['revision'])
        self.assertFalse(after['stale'])
        self.assertEqual(fetch.call_args.args[0].get_header('If-none-match'),'"v1"')
        self.assertIsNotNone(after['last_success'])

    def test_network_and_invalid_payload_failures_preserve_last_good_cache(self):
        self.refresh(Response(board('RED')))
        cached=self.cache.read_bytes()
        original=self.feed.snapshot()
        self.refresh(error=URLError('offline'),clock=200)
        self.assertTrue(self.feed.snapshot()['stale'])
        self.assertEqual(self.feed.snapshot()['revision'],original['revision'])
        self.refresh(Response({'coverage':[{'cell_id':'broken'}]}),clock=300)
        self.assertEqual(self.feed.snapshot()['coverage'],original['coverage'])
        self.assertEqual(self.cache.read_bytes(),cached)

    def test_cache_survives_restart_and_missing_seed_can_bootstrap(self):
        self.seed.unlink()
        self.feed=BoardFeed(self.seed,self.cache)
        self.assertFalse(self.feed.snapshot()['available'])
        self.refresh(Response(board('GREEN')))
        restarted=BoardFeed(self.seed,self.cache)
        snapshot=restarted.snapshot()
        self.assertTrue(snapshot['available'])
        self.assertEqual(snapshot['source'],'cache')
        self.assertEqual(snapshot['coverage'][0]['owner_team'],'GREEN')
        self.assertNotIn('coverage',restarted.snapshot(False))

    def test_manual_refresh_cannot_hammer_provider(self):
        with patch('board_feed.time.monotonic',return_value=100),patch('board_feed.urlopen',return_value=Response(board())) as fetch:
            self.feed.refresh()
            self.feed.refresh()
            self.assertEqual(fetch.call_count,1)

    def test_invalid_schema_and_refresh_interval_are_rejected(self):
        with self.assertRaises(ValueError):validate_board({'coverage':[board()['coverage'][0]]*2})
        bad=board();bad['coverage'][0]['north']=float('nan')
        with self.assertRaises(ValueError):validate_board(bad)
        with self.assertRaises(ValueError):BoardFeed(self.seed,self.cache,interval=1)

    def test_cache_write_failure_keeps_new_live_data_in_memory(self):
        with patch.object(self.feed,'_persist',side_effect=OSError('read only')):
            self.refresh(Response(board('RED')))
        snapshot=self.feed.snapshot()
        self.assertEqual(snapshot['coverage'][0]['owner_team'],'RED')
        self.assertFalse(snapshot['stale'])
        self.assertIsNotNone(snapshot['cache_error'])


class FeedHttpTests(unittest.TestCase):
    def request(self,server,path,method='GET',payload=None):
        class Connection:
            def __init__(self,raw):self.request=io.BytesIO(raw);self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        body=json.dumps(payload).encode() if payload is not None else b''
        raw=f'{method} {path} HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
        connection=Connection(raw)
        Handler(connection,('127.0.0.1',0),server)
        head,response=bytes(connection.response).split(b'\r\n\r\n',1)
        return head,json.loads(response)

    def test_status_and_manual_refresh_endpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            seed=root/'nodes.json';seed.write_text(json.dumps(board()))
            feed=BoardFeed(seed,root/'cache.json')
            server=SimpleNamespace(board_feed=feed)
            head,data=self.request(server,'/api/board/status')
            self.assertIn(b'200 OK',head)
            self.assertNotIn('coverage',data)
            self.assertEqual(data['coverage_count'],1)
            with patch.object(feed,'request_refresh') as refresh:
                head,data=self.request(server,'/api/board/refresh','POST',{})
                self.assertIn(b'202 Accepted',head)
                refresh.assert_called_once()

    def test_search_pins_board_revision_even_if_feed_changes_during_search(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            seed=root/'nodes.json';seed.write_text(json.dumps(board()))
            feed=BoardFeed(seed,root/'cache.json')
            initial=feed.snapshot()
            def search(start,end,coverage,*args,**kwargs):
                self.assertIs(coverage,initial['coverage'])
                feed.board=board('RED');feed.version='new-revision'
                self.assertEqual(coverage[0]['owner_team'],'BLUE')
                return {'routes':[]}
            with patch('server.search_routes',side_effect=search):
                head,data=self.request(SimpleNamespace(board_feed=feed),'/api/plan','POST',
                                       {'start':[0,0],'end':[.01,.01],'detour_minutes':0})
            self.assertIn(b'200 OK',head)
            self.assertEqual(data['board_revision'],initial['revision'])
            self.assertNotEqual(feed.snapshot()['revision'],data['board_revision'])


if __name__=='__main__':unittest.main()
