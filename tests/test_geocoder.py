import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.error import URLError
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from geocoder import lookup_address, normalize_results
from server import Handler

FEATURE = {'geometry':{'type':'Point','coordinates':[-111.9738,41.223]},
           'properties':{'name':'Library','housenumber':'2464','street':'Jefferson Avenue',
                         'city':'Ogden','state':'Utah','country':'United States'}}


class GeocoderTests(unittest.TestCase):
    def tearDown(self):
        lookup_address.cache_clear()

    def test_label_coordinates_and_duplicate_results(self):
        results=normalize_results({'features':[FEATURE,FEATURE]})
        self.assertEqual(len(results),1)
        self.assertEqual(results[0]['coordinates'],[-111.9738,41.223])
        self.assertIn('2464 Jefferson Avenue, Ogden, Utah',results[0]['label'])

    def test_empty_and_invalid_features(self):
        invalid=[{'geometry':{'type':'Point','coordinates':[0,91]}},
                 {'geometry':{'type':'Point','coordinates':[float('nan'),0]}},
                 {'geometry':{'type':'Point','coordinates':['bad',0]}},
                 {'geometry':{'type':'LineString','coordinates':[1,2]}}]
        self.assertEqual(normalize_results({'features':invalid}),[])
        self.assertEqual(normalize_results({}),[])

    def test_lookup_encodes_query_and_caches_response(self):
        with patch('geocoder.urlopen',return_value=io.BytesIO(json.dumps({'features':[FEATURE]}).encode())) as fetch:
            first=lookup_address('Main & 25th, Ogden')
            self.assertEqual(lookup_address('Main & 25th, Ogden'),first)
            self.assertEqual(fetch.call_count,1)
            params=parse_qs(urlparse(fetch.call_args.args[0].full_url).query)
            self.assertEqual(params['q'],['Main & 25th, Ogden'])
            self.assertEqual(params['limit'],['5'])

    def request(self,payload):
        class Connection:
            def __init__(self,raw):self.request=io.BytesIO(raw);self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        body=json.dumps(payload).encode()
        raw=f'POST /api/geocode HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
        connection=Connection(raw)
        Handler(connection,('127.0.0.1',0),SimpleNamespace())
        head,response=bytes(connection.response).split(b'\r\n\r\n',1)
        return head,json.loads(response)

    def test_endpoint_results_and_bad_queries(self):
        with patch('server.lookup_address',return_value=[{'label':'Ogden','coordinates':[-111.97,41.22]}]) as lookup:
            head,response=self.request({'query':' Ogden, UT '})
            self.assertIn(b'200 OK',head)
            self.assertEqual(response['results'][0]['label'],'Ogden')
            lookup.assert_called_once_with('Ogden, UT')
            for payload in ({'query':'a'},{'query':123},{'query':'a'*301},[]):
                head,response=self.request(payload)
                self.assertIn(b'400 Bad Request',head)

    def test_endpoint_provider_failure_has_coordinate_fallback(self):
        with patch('server.lookup_address',side_effect=URLError('offline')):
            head,response=self.request({'query':'Ogden, UT'})
            self.assertIn(b'502 Bad Gateway',head)
            self.assertIn('latitude, longitude',response['error'])

if __name__=='__main__':unittest.main()
