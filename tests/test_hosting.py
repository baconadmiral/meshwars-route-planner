"""Hosted API validation and streaming behavior without live service requests."""
import json
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from hosting import create_app


def route(points):
    return {'geometry':{'type':'LineString','coordinates':points},
            'duration':100,'distance':1000,'legs':[]}


class HostingTests(unittest.TestCase):
    def setUp(self):
        self.snapshot={'available':True,'coverage':[],'revision':'fixed'}
        self.runtime=SimpleNamespace(board=Mock(),radio=Mock(),stopping=threading.Event())
        self.runtime.board.snapshot.side_effect=lambda *args:self.snapshot
        self.runtime.radio.snapshot.return_value={
            'events':[],'configured':False,'available':False,'revision':'no-evidence'}
        self.app=create_app(self.runtime,search_limit=1)
        self.client=self.app.test_client()
        self.payload={'start':[.001,.001],'end':[.01,.001],'detour_minutes':0,'team':'ORANGE'}

    def test_health_readiness_and_explicit_static_assets(self):
        self.assertEqual(self.client.get('/healthz').status_code,200)
        self.assertEqual(self.client.get('/readyz').status_code,200)
        self.snapshot={'available':False,'coverage':[]}
        self.assertEqual(self.client.get('/readyz').status_code,503)
        for asset in ('/','/app.js'):
            with self.client.get(asset) as response:
                self.assertEqual(response.status_code,200)
                response.get_data()
        self.assertEqual(self.client.get('/.env').status_code,404)
        self.assertEqual(self.client.get('/../server.py').status_code,404)
        response=self.client.get('/healthz')
        self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertEqual(response.headers['Referrer-Policy'],'strict-origin-when-cross-origin')

    def test_json_limits_bad_bodies_and_cross_origin(self):
        self.assertEqual(self.client.post('/api/plan',data='{}').status_code,415)
        for value in ([],None,{'start':[0,0]}):
            response=self.client.post('/api/plan',data=json.dumps(value),content_type='application/json')
            self.assertEqual(response.status_code,400)
        self.assertEqual(self.client.post('/api/plan',data='{',content_type='application/json').status_code,400)
        self.assertEqual(self.client.post('/api/plan',json=self.payload,
                                         headers={'Origin':'https://unrelated.example'}).status_code,403)
        self.assertEqual(self.client.post('/api/plan',data=' '*17000,
                                         content_type='application/json').status_code,413)
        self.assertEqual(self.client.post('/api/route-export',data=' '* (5*1024*1024+1),
                                         content_type='application/json').status_code,413)

    def test_both_search_endpoints_keep_team_area_revision_and_evidence(self):
        self.payload['allowed_bounds']={'west':0,'south':0,'east':.02,'north':.02}
        for endpoint in ('/api/plan','/api/plan-stream'):
            with patch('hosting.fetch_routes',side_effect=lambda points,*args:[route(points)]):
                response=self.client.post(endpoint,json=self.payload)
            self.assertEqual(response.status_code,200)
            if endpoint.endswith('stream'):
                events=[json.loads(line) for line in response.data.splitlines() if line]
                self.assertEqual(events[0]['type'],'progress')
                self.assertEqual(events[-1]['type'],'result')
                data=events[-1]
                self.assertEqual(response.headers['X-Accel-Buffering'],'no')
            else:
                data=response.get_json()
            self.assertEqual(data['team'],'ORANGE')
            self.assertEqual(data['allowed_bounds'],self.payload['allowed_bounds'])
            self.assertEqual(data['board_revision'],'fixed')
            self.assertIn('radio_coverage',data['routes'][0])

    def test_board_export_area_and_geocoder_endpoints(self):
        self.assertEqual(self.client.get('/api/board').get_json()['revision'],'fixed')
        self.assertFalse(self.client.get('/api/radio-coverage').get_json()['configured'])
        self.assertEqual(self.client.post('/api/board/refresh',json={}).status_code,202)
        self.runtime.board.request_refresh.assert_called_once()
        self.assertEqual(self.client.post('/api/validate-route-area',json={'allowed_bounds':None}).status_code,200)
        response=self.client.post('/api/route-export',json={'route':route([[0,0],[1,1]])})
        self.assertIn('gpx',response.get_json())
        with patch('hosting.lookup_address',return_value=[{'label':'Test','coordinates':[0,0]}]):
            self.assertEqual(len(self.client.post('/api/geocode',json={'query':'Test'}).get_json()['results']),1)

    def test_full_capacity_returns_429_and_stream_close_stops_worker(self):
        began,finished=threading.Event(),threading.Event()
        def searching(*args,progress,**kwargs):
            began.set()
            try:
                while True:
                    progress({'percent':10,'message':'Checking routes'})
            finally:
                finished.set()
        with patch('hosting.search_routes',side_effect=searching):
            response=self.client.post('/api/plan-stream',json=self.payload,buffered=False)
            self.assertTrue(began.wait(1))
            busy=self.client.post('/api/plan',json=self.payload)
            self.assertEqual(busy.status_code,429)
            self.assertEqual(busy.headers['Retry-After'],'10')
            response.close()
            self.assertTrue(finished.wait(2))
        with patch('hosting.fetch_routes',side_effect=lambda points,*args:[route(points)]):
            # Worker releases its slot immediately after cancellation unwinds.
            for _ in range(10):
                response=self.client.post('/api/plan',json=self.payload)
                if response.status_code!=429:break
                time.sleep(.01)
            self.assertEqual(response.status_code,200)

    def test_place_options_reach_both_search_endpoints(self):
        from places import current_week
        self.runtime.places=Mock()
        self.runtime.places.load.return_value={'available':True,'week_start':current_week(),
            'truncated':False,'park_boundaries':{'type':'FeatureCollection','features':[]},
            'places':[{'id':1,'type':'landmark','name':'Test landmark','lat':.001,'lon':.001,'points':25,'rotates':True}]}
        self.payload['place_options']={'remaining':3,'weight':1.5}
        for endpoint in ('/api/plan','/api/plan-stream'):
            with patch('hosting.fetch_routes',side_effect=lambda points,*args:[route(points)]):
                response=self.client.post(endpoint,json=self.payload)
                data=json.loads(response.data.splitlines()[-1]) if endpoint.endswith('stream') else response.get_json()
            self.assertEqual(response.status_code,200)
            self.assertEqual(data['routes'][0]['place_bonus'],3)
            self.assertAlmostEqual(data['routes'][0]['capture_value'],data['routes'][0]['territory_value']+4.5)
            self.assertTrue(data['places']['enabled'])
        self.assertEqual(self.runtime.places.load.call_count,2)
        self.payload['place_options']={'remaining':101}
        self.assertEqual(self.client.post('/api/plan',json=self.payload).status_code,400)

    def test_outside_stops_return_named_errors_before_any_routing(self):
        body={'start':[-1,0],'end':[1,1],'waypoints':[[.01,.01],[2,2]],
              'allowed_bounds':{'west':0,'south':0,'east':.02,'north':.02}}
        for endpoint in ('/api/plan','/api/plan-stream','/api/validate-route-area'):
            with patch('hosting.fetch_routes') as router:
                response=self.client.post(endpoint,json=body)
            self.assertEqual(response.status_code,400)
            data=response.get_json()
            self.assertEqual(data['outside_stops'],['start','W2','end'])
            self.assertIn('Start (A)',data['error'])
            self.assertIn('Waypoint W2',data['error'])
            self.assertIn('Destination (B)',data['error'])
            router.assert_not_called()

    def test_upstream_error_is_stream_event_and_releases_slot(self):
        with patch('hosting.fetch_routes',side_effect=OSError('private upstream detail')):
            response=self.client.post('/api/plan-stream',json=self.payload)
            events=[json.loads(line) for line in response.data.splitlines() if line]
            self.assertEqual(events[-1]['type'],'error')
            self.assertNotIn('private upstream detail',response.data.decode())
            response=self.client.post('/api/plan',json=self.payload)
            self.assertEqual(response.status_code,502)
