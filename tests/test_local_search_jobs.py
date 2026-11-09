"""The development HTTP server exposes the same reconnectable job protocol."""
import io
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from search_jobs import SearchJobs
from server import Handler


class LocalSearchTests(unittest.TestCase):
    def request(self, server, method, path, data=None):
        body=json.dumps(data).encode() if data is not None else b''
        connection=Mock()
        connection.makefile.return_value=io.BytesIO(f'{method} {path} HTTP/1.0\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body)
        output=io.BytesIO();connection.sendall.side_effect=output.write
        Handler(connection,('127.0.0.1',0),server)
        headers,body=output.getvalue().split(b'\r\n\r\n',1)
        return headers,json.loads(body)

    def test_create_poll_and_cancel_on_local_entrypoint(self):
        server=SimpleNamespace(search_jobs=SearchJobs(),board_feed=Mock(),radio_coverage=Mock())
        server.board_feed.snapshot.return_value={'available':True,'coverage':[],'revision':'local'}
        server.radio_coverage.snapshot.return_value={'events':[],'available':False}
        payload={'start':[0,0],'end':[.01,.01],'detour_minutes':0}
        token='d'*64
        with patch('server.search_routes',return_value={'routes':[],'baseline':{'geometry':{'coordinates':[[0,0],[.01,.01]]},'target_ids':[]}}):
            headers,data=self.request(server,'POST','/api/searches/'+token,payload)
            self.assertIn(b'202 Accepted',headers)
            self.assertEqual(data['token'],token)
            for _ in range(100):
                if server.search_jobs.get(token)['state']!='running':break
                time.sleep(.01)
            self.assertEqual(server.search_jobs.get(token)['state'],'complete')
        headers,data=self.request(server,'GET','/api/searches/'+token)
        self.assertIn(b'200 OK',headers)
        self.assertIn(data['state'],('running','complete'))
        headers,data=self.request(server,'POST','/api/searches/'+'e'*64+'/cancel',{})
        self.assertEqual(data['state'],'cancelled')
