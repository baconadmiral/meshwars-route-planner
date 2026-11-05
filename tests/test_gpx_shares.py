import io
import json
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

from gpx_shares import GPXShares, ShareCapacityError
from hosting import create_app
from navigation import build_export
from server import Handler

ROUTE={'team':'ORANGE','geometry':{'type':'LineString','coordinates':[[0,0],[.01,.01],[.02,.01]]},
       'via_points':[[.01,.01]],'stop_labels':['Detour']}


def token_for(share):
    return share['download_path'].rsplit('/',1)[1][:-4]


class GPXShareTests(unittest.TestCase):
    def test_download_is_exact_track_and_token_is_unguessable(self):
        store=GPXShares()
        first,second=store.create(ROUTE),store.create(ROUTE)
        token=token_for(first)
        self.assertEqual(len(token),32)
        self.assertNotEqual(token,token_for(second))
        self.assertNotIn('longitude',first['download_path'])
        item=store.get(token)
        self.assertEqual(item['body'].decode(),build_export(ROUTE)['gpx'])
        self.assertEqual(item['filename'],'orange-route.gpx')
        ET.fromstring(item['body'])
        self.assertEqual(first['expires_in_seconds'],3600)
        self.assertIsNone(store.get('unknown'))

    def test_expiry_prunes_bytes_and_restart_discards_tracks(self):
        now=[100.]
        store=GPXShares(ttl_seconds=10,clock=lambda:now[0])
        share=store.create(ROUTE)
        self.assertEqual(share['expires_at'],110)
        self.assertIsNotNone(store.get(token_for(share)))
        self.assertIsNone(GPXShares().get(token_for(share)))
        now[0]=110
        self.assertIsNone(store.get(token_for(share)))
        self.assertEqual(store._bytes,0)

    def test_capacity_does_not_invalidate_existing_links(self):
        now=[0.]
        store=GPXShares(ttl_seconds=10,max_items=1,clock=lambda:now[0])
        first=store.create(ROUTE)
        with self.assertRaises(ShareCapacityError):store.create(ROUTE)
        self.assertIsNotNone(store.get(token_for(first)))
        now[0]=10
        self.assertIsNotNone(store.create(ROUTE))
        with self.assertRaises(ShareCapacityError):GPXShares(max_bytes=1).create(ROUTE)

    def test_invalid_routes_are_not_saved(self):
        store=GPXShares()
        for route in (None,{},dict(ROUTE,team='INVALID')):
            with self.assertRaises(ValueError):store.create(route)
        self.assertEqual(store._bytes,0)

    def test_hosted_create_download_expire_and_response_headers(self):
        now=[0.]
        store=GPXShares(ttl_seconds=10,clock=lambda:now[0])
        with patch('hosting.GPXShares',return_value=store):
            app=create_app(SimpleNamespace())
        client=app.test_client()
        response=client.post('/api/gpx-shares',json={'route':ROUTE})
        self.assertEqual(response.status_code,201)
        path=response.get_json()['download_path']
        download=client.get(path)
        self.assertEqual(download.status_code,200)
        self.assertEqual(download.data.decode(),build_export(ROUTE)['gpx'])
        self.assertTrue(download.headers['Content-Type'].startswith('application/gpx+xml'))
        self.assertEqual(download.headers['Content-Disposition'],'attachment; filename="orange-route.gpx"')
        self.assertEqual(download.headers['Cache-Control'],'no-store')
        self.assertEqual(download.headers['Referrer-Policy'],'no-referrer')
        with client.get('/') as response:
            response.get_data()
            self.assertEqual(response.headers['Referrer-Policy'],'strict-origin-when-cross-origin')
        now[0]=10
        self.assertEqual(client.get(path).status_code,404)
        self.assertEqual(client.post('/api/gpx-shares',json={}).status_code,400)

    def test_hosted_capacity_and_body_limit(self):
        with patch('hosting.GPXShares',return_value=GPXShares(max_items=1)):
            client=create_app(SimpleNamespace()).test_client()
        self.assertEqual(client.post('/api/gpx-shares',json={'route':ROUTE}).status_code,201)
        busy=client.post('/api/gpx-shares',json={'route':ROUTE})
        self.assertEqual(busy.status_code,429)
        self.assertIn('Retry-After',busy.headers)
        self.assertEqual(client.post('/api/gpx-shares',data=' '*(5*1024*1024+1),
                                     content_type='application/json').status_code,413)

    def test_local_server_has_same_download_contract(self):
        class Connection:
            def __init__(self,raw):self.request=io.BytesIO(raw);self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        def request(method,path,data=None):
            body=json.dumps(data).encode() if data is not None else b''
            raw=f'{method} {path} HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
            connection=Connection(raw)
            Handler(connection,('127.0.0.1',0),SimpleNamespace())
            return bytes(connection.response).split(b'\r\n\r\n',1)
        head,body=request('POST','/api/gpx-shares',{'route':ROUTE})
        self.assertIn(b'201 Created',head)
        path=json.loads(body)['download_path']
        head,body=request('GET',path)
        self.assertIn(b'200 OK',head)
        self.assertIn(b'attachment; filename="orange-route.gpx"',head)
        self.assertEqual(body.decode(),build_export(ROUTE)['gpx'])
        head,_=request('GET','/api/gpx-shares/missing.gpx')
        self.assertIn(b'404 Not Found',head)
