import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs,urlparse
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from navigation import build_export,GPX_NS
from server import Handler


class NavigationTests(unittest.TestCase):
    def route(self,via=None):
        via=via or []
        return {'geometry':{'type':'LineString','coordinates':[[-111.97,41.22],[-111.96,41.21],[-111.95,41.20]]},
                'via_points':via,'stop_labels':[f'W{i+1}' for i in range(len(via))]}

    def test_direct_google_link_uses_latitude_longitude(self):
        route=self.route()
        route['geometry']['coordinates']=[[-111.97,41.22],[-111.969,41.219]]
        exported=build_export(route)
        self.assertEqual(len(exported['sections']),1)
        params=parse_qs(urlparse(exported['sections'][0]['url']).query)
        self.assertEqual(params['api'],['1'])
        self.assertEqual(params['origin'],['41.220000,-111.970000'])
        self.assertEqual(params['destination'],['41.219000,-111.969000'])
        self.assertEqual(params['travelmode'],['driving'])
        self.assertEqual(params['dir_action'],['navigate'])
        self.assertNotIn('waypoints',params)

    def test_long_route_sections_preserve_every_stop_in_order(self):
        via=[[-111.97+i*.001,41.21] for i in range(11)]
        route=self.route(via);exported=build_export(route)
        recovered=list(exported['sections'][0]['stops'])
        for previous,current in zip(exported['sections'],exported['sections'][1:]):
            self.assertEqual(previous['stops'][-1],current['stops'][0])
            recovered.extend(current['stops'][1:])
        self.assertEqual(recovered,[route['geometry']['coordinates'][0],*via,route['geometry']['coordinates'][-1]])
        for section in exported['sections']:
            params=parse_qs(urlparse(section['url']).query)
            self.assertLessEqual(len(section['stops'])-2,3)
            self.assertLessEqual(len(params.get('waypoints',[''])[0].split('|')),3)
            self.assertLessEqual(len(section['url']),2048)

    def test_gpx_retains_all_track_coordinates_and_escapes_labels(self):
        route=self.route([[-111.96,41.21]])
        route['stop_labels']=['W1 & <park>']
        exported=build_export(route)
        root=ET.fromstring(exported['gpx'])
        ns={'g':GPX_NS}
        actual=[[float(p.attrib['lon']),float(p.attrib['lat'])] for p in root.findall('.//g:trkpt',ns)]
        self.assertEqual(actual,route['geometry']['coordinates'])
        self.assertEqual(root.findall('g:wpt/g:name',ns)[1].text,'W1 & <park>')
        self.assertEqual(exported['trackpoint_count'],3)

    def test_long_geometry_keeps_single_link_without_added_stops(self):
        route={'geometry':{'coordinates':[[0,0],[.01,.01],[0,.03]]}}
        exported=build_export(route)
        self.assertEqual(len(exported['sections']),1)
        self.assertEqual(exported['sections'][0]['stops'],[[0,0],[0,.03]])

    def test_short_uturn_retains_bend_and_repeat_stop_labels(self):
        route={'geometry':{'coordinates':[[0,0],[0,.001],[0,0]]},
               'via_points':[[0,.001],[0,0]],'stop_labels':['Out','Return']}
        exported=build_export(route)
        section=exported['sections'][0]
        self.assertIn([0,.001],section['stops'])
        self.assertEqual([label for label in section['labels'] if label in ('Out','Return')],['Out','Return'])

    def test_invalid_routes_rejected(self):
        for route in (None,{}, {'geometry':{'coordinates':[]}},
                      {'geometry':{'coordinates':[[0,0],[181,0]]}},
                      {'geometry':{'coordinates':[[0,0],[float('nan'),0]]}},
                      {'geometry':{'coordinates':[[0,0],[True,0]]}}):
            with self.assertRaises(ValueError):build_export(route)
        route=self.route([[0,0]]*33)
        with self.assertRaises(ValueError):build_export(route)

    def test_export_http_endpoint_needs_no_board_or_external_request(self):
        class Connection:
            def __init__(self,raw):self.request=io.BytesIO(raw);self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        body=json.dumps({'route':self.route()}).encode()
        raw=f'POST /api/route-export HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
        connection=Connection(raw)
        Handler(connection,('127.0.0.1',0),SimpleNamespace())
        head,response=bytes(connection.response).split(b'\r\n\r\n',1)
        self.assertIn(b'200 OK',head)
        data=json.loads(response)
        self.assertEqual(len(data['sections']),1)
        ET.fromstring(data['gpx'])

if __name__=='__main__':unittest.main()
