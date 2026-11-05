import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from planner import search_routes
from route_bounds import validate_bounds, route_inside, point_inside
from server import Handler

BOX={'west':0,'south':0,'east':.02,'north':.02}
START,END=[.001,.001],[.019,.001]


def road(points,duration=100):
    return {'geometry':{'type':'LineString','coordinates':points},
            'duration':duration,'distance':1000,'legs':[]}


class RouteBoundsTests(unittest.TestCase):
    def test_bad_boxes_and_outside_stops_rejected_before_routing(self):
        for box in ({}, dict(BOX,east=0),dict(BOX,north=float('nan')),
                    dict(BOX,west=True),dict(BOX,east=181),dict(BOX,extra=1)):
            with self.subTest(box=box),self.assertRaises(ValueError):
                validate_bounds(box)
        for start,end,waypoints in (([-1,0],END,[]),(START,[1,1],[]),(START,END,[[1,1]])):
            router=Mock()
            with self.assertRaisesRegex(ValueError,'inside the route area'):
                search_routes(start,end,[],0,router,waypoints=waypoints,allowed_bounds=BOX)
            router.assert_not_called()

    def test_full_geometry_and_boundaries_are_checked(self):
        self.assertTrue(route_inside(road([[0,0],[.02,.02]]),BOX))
        self.assertFalse(route_inside(road([START,[.01,.03],END]),BOX))
        self.assertTrue(route_inside(road([START,[.01,.03],END]),None))

    def test_baseline_and_detours_enforce_box_and_constrained_budget(self):
        baseline=road([START,[.01,.003],END],200)
        outside=road([START,[.01,.03],END],100)
        requested=[]
        def router(points,alternatives=False):
            requested.append(points)
            if len(points)==2:return [outside,baseline]
            if points[1][1]==.009:return [outside]
            return [road(points,230 if points[1][1]==.01 else 210)]
        with patch('planner.exploration_points',return_value=[[.01,.008],[.01,.009],[.01,.01],[1,1]]), \
             patch('planner.insertion_proposals',return_value=[]):
            result=search_routes(START,END,[],20,router,allowed_bounds=BOX,strategy='compare')
        self.assertEqual(result['baseline']['duration'],200)
        self.assertEqual(result['allowed_bounds'],BOX)
        self.assertTrue(any(r['duration']==210 for r in result['routes']))
        self.assertFalse(any([1,1] in points for points in requested))
        for entry in result['strategy_results'].values():
            for route in entry['routes']:
                self.assertTrue(route_inside(route,BOX))
                self.assertLessEqual(route['duration'],220)

    def test_no_contained_baseline_reports_actionable_error(self):
        with self.assertRaisesRegex(ValueError,'Enlarge or clear'):
            search_routes(START,END,[],30,lambda *args:[road([START,[.01,.03],END])],allowed_bounds=BOX)

    def test_refinement_cannot_return_escaping_geometry(self):
        baseline=road([START,END])
        outside=road([START,[.01,.03],END])
        def router(points,alternatives=False):return [baseline] if len(points)==2 else [outside]
        with patch('planner.exploration_points',return_value=[]), \
             patch('planner.insertion_proposals',return_value=[[[.01,.01]]]):
            result=search_routes(START,END,[],30,router,allowed_bounds=BOX)
        self.assertTrue(result['routes'])
        self.assertTrue(all(route_inside(r,BOX) for r in result['routes']))
        self.assertGreater(result['failed_candidates'],0)

    def polygon(self):
        return {'type':'Polygon','coordinates':[[[0,0],[.02,0],[.02,.02],
                [.014,.02],[.014,.006],[.006,.006],[.006,.02],[0,.02],[0,0]]]}

    def test_concave_polygon_rejects_shortcut_between_contained_vertices(self):
        polygon=validate_bounds(self.polygon())
        start,end=[.003,.016],[.017,.016]
        self.assertTrue(point_inside(start,polygon))
        self.assertTrue(point_inside(end,polygon))
        self.assertFalse(route_inside(road([start,end]),polygon))
        detour=road([start,[.003,.003],[.017,.003],end],150)
        self.assertTrue(route_inside(detour,polygon))
        self.assertTrue(route_inside(road([[.006,.006],[.006,.018]]),polygon))
        self.assertFalse(point_inside([.01,.015],polygon))
        reverse={'type':'Polygon','coordinates':[list(reversed(polygon['coordinates'][0]))]}
        self.assertTrue(route_inside(detour,validate_bounds(reverse)))
        result=search_routes(start,end,[],0,lambda *args:[road([start,end]),detour],allowed_bounds=polygon)
        self.assertEqual(result['baseline']['duration'],150)
        self.assertEqual(result['allowed_bounds'],polygon)
        self.assertTrue(all(route_inside(r,polygon) for r in result['routes']))

    def test_polygon_validation_rejects_crossings_holes_and_degenerate_shapes(self):
        rings=[[[0,0],[1,1],[0,1],[1,0],[0,0]],
               [[0,0],[1,1],[2,2],[0,0]],
               [[0,0],[1,0],[1,1]],
               [[0,0],[1,0],[1,1],[1,0],[0,0]],
               [[0,0],[1,0],[float('nan'),1],[0,0]],
               [[0,0],[1,0],[True,1],[0,0]],
               [[-179,0],[179,0],[179,1],[-179,0]],
               [[0,0],[2,0],[1,0],[1,1],[0,0]]]
        for ring in rings:
            with self.subTest(ring=ring),self.assertRaises(ValueError):
                validate_bounds({'type':'Polygon','coordinates':[ring]})
        polygon=self.polygon()
        polygon['coordinates'].append(polygon['coordinates'][0])
        with self.assertRaises(ValueError):validate_bounds(polygon)

    def test_both_http_search_endpoints_forward_area(self):
        class Connection:
            def __init__(self,raw):self.request=io.BytesIO(raw);self.response=bytearray()
            def makefile(self,*args):return self.request
            def sendall(self,data):self.response.extend(data)
        for path,area in (('/api/plan',BOX),('/api/plan-stream',BOX),('/api/plan',self.polygon()),('/api/plan-stream',self.polygon()),('/api/validate-route-area',self.polygon())):
            body=json.dumps({'start':START,'end':END,'detour_minutes':0,'allowed_bounds':area}).encode()
            raw=f'POST {path} HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
            connection=Connection(raw)
            server=SimpleNamespace(board={'coverage':[]},board_path=Path('fixture.json'))
            with patch('server.fetch_routes',return_value=[road([START,END])]):
                Handler(connection,('127.0.0.1',0),server)
            head,response=bytes(connection.response).split(b'\r\n\r\n',1)
            self.assertIn(b'200 OK',head)
            data=json.loads(response.splitlines()[-1])
            self.assertEqual(data['allowed_bounds'],area)
