import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from planner import choose, intersects, score, candidate_points, opportunity_score, exploration_points, search_routes, route_grid_cells
from server import Handler, point, SearchCancelled

CELL = dict(cell_id='test', owner_team='RED', west=0, east=1, south=0, north=1)


def route(coords, duration=100):
    return dict(geometry={'type': 'LineString', 'coordinates': coords}, duration=duration,
                distance=1000, legs=[{'steps': [{'name': 'Test road', 'distance': 1000,
                'maneuver': {'type': 'depart', 'modifier': 'straight'}}]}])


class PlannerTests(unittest.TestCase):
    def test_segment_crossing_without_vertex_inside(self):
        self.assertTrue(intersects([-1, .5], [2, .5], CELL))
        self.assertFalse(intersects([-1, 2], [2, 2], CELL))
        self.assertTrue(intersects([.5, -1], [.5, 2], CELL))

    def test_unique_squares_and_blue_exclusion(self):
        r = route([[-1,.5], [2,.5], [-1,.5]])
        blue = dict(CELL, cell_id='blue', owner_team='BLUE', west=1, east=2)
        s = score(r, [CELL, blue])
        self.assertEqual(s['square_count'], 2)
        self.assertEqual(s['target_count'], 1)

    def test_budget_and_ranking(self):
        direct = route([[-1,2], [2,2]])
        detour = route([[-1,.5], [2,.5]], 130)
        self.assertEqual(choose([direct, detour], [CELL], 29, 100)[0]['target_count'], 0)
        self.assertEqual(choose([direct, detour], [CELL], 30, 100)[0]['target_count'], 1)
        self.assertEqual(choose([direct], [], 0, 100)[0]['target_count'], 0)

    def test_no_targets_for_blue(self):
        self.assertEqual(candidate_points([0,0], [1,1], [dict(CELL, owner_team='BLUE')]), [])

    def test_invalid_coordinates(self):
        for p in ([0,91], [181,0], [float('nan'),0], [0]):
            with self.assertRaises(ValueError): point(p)


class ExplorationTests(unittest.TestCase):
    def test_unpainted_cells_are_targets_and_blue_cells_are_not(self):
        blue = dict(CELL,cell_id='0_0',west=0,east=.00384,south=0,north=.0027,owner_team='BLUE')
        r = route([[.001,.001],[.007,.001],[.001,.001]])
        scored = opportunity_score(r,[blue])
        self.assertEqual(scored['square_count'],2)
        self.assertEqual(scored['target_count'],1)
        self.assertEqual(scored['unmapped_count'],1)
        self.assertEqual(scored['enemy_count'],0)

    def test_search_leaves_all_blue_direct_corridor(self):
        blue = dict(CELL,cell_id='0_0',west=0,east=.00384,south=0,north=.0027,owner_team='BLUE')
        start,end = [.001,.001],[.002,.001]
        calls=[]
        def router(points,alternatives=False):
            calls.append(points)
            return [route(points,100 if len(points)==2 else 200)]
        result=search_routes(start,end,[blue],300,router)
        self.assertGreater(result['routes'][0]['target_count'],0)
        self.assertEqual(result['baseline']['target_count'],0)
        self.assertTrue(any(len(p)==4 for p in calls))
        self.assertTrue(all(r['duration']<=400 for r in result['routes']))

    def test_zero_gain_is_not_a_recommendation(self):
        blue = dict(CELL,cell_id='0_0',west=0,east=.00384,south=0,north=.0027,owner_team='BLUE')
        direct=route([[.001,.001],[.002,.001]])
        result=search_routes([.001,.001],[.002,.001],[blue],0,lambda *args:[direct])
        self.assertTrue(result['no_opportunities'])
        self.assertEqual(result['routes'],[])

    def test_progress_is_monotonic_and_reports_search_stages(self):
        updates=[]
        search_routes([.001,.001],[.002,.001],[],300,
                      lambda points,*args:[route(points)],updates.append)
        percents=[u['percent'] for u in updates]
        self.assertEqual(percents,sorted(percents))
        self.assertTrue(any('territory detour' in u['message'] for u in updates))
        self.assertTrue(any('extended route' in u['message'] for u in updates))
        self.assertEqual(percents[-1],95)

    def test_disconnected_search_stops_before_more_requests(self):
        router=unittest.mock.Mock()
        def disconnected(update):
            raise SearchCancelled()
        with self.assertRaises(SearchCancelled):
            search_routes([.001,.001],[.002,.001],[],300,router,disconnected)
        router.assert_not_called()

    def test_large_budget_reaches_farther(self):
        start,end=[-111.97,41.23],[-111.96,41.17]
        def max_distance(points):
            return max(abs(p[0]-start[0])+abs(p[1]-start[1]) for p in points)
        self.assertGreater(max_distance(exploration_points(start,end,[],3600)),
                           max_distance(exploration_points(start,end,[],300)))

    def test_unreachable_excursions_do_not_break_budget(self):
        start,end=[.001,.001],[.002,.001]
        def router(points,alternatives=False):
            return [route(points,100 if len(points)==2 else 99999)]
        result=search_routes(start,end,[],300,router)
        self.assertTrue(all(r['duration']==100 for r in result['routes']))


class HttpTests(unittest.TestCase):
    def test_static_board_and_plan_with_mock_router(self):
        class Connection:
            def __init__(self, request):
                self.request = io.BytesIO(request)
                self.response = bytearray()
            def makefile(self, *args):
                return self.request
            def sendall(self, data):
                self.response.extend(data)
        server = SimpleNamespace(board={'coverage': [dict(CELL, cell_id='0_0',east=.00384,north=.0027)]}, board_path=Path('fixture.json'))
        def request(method, path, body=b''):
            raw = f'{method} {path} HTTP/1.0\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body
            connection = Connection(raw)
            Handler(connection, ('127.0.0.1', 0), server)
            head, response = bytes(connection.response).split(b'\r\n\r\n', 1)
            self.assertIn(b'200 OK', head)
            return response
        self.assertIn(b'BLUE / MeshWars', request('GET', '/'))
        self.assertEqual(len(json.loads(request('GET', '/api/board'))['coverage']), 1)
        body = json.dumps({'start':[-1,.5], 'end':[2,.5], 'detour_minutes':0}).encode()
        with patch('server.fetch_routes', return_value=[route([[.0001,.0001],[.0002,.0002]])]):
            data = json.loads(request('POST', '/api/plan', body))
            self.assertEqual(data['routes'][0]['target_count'], 1)
            self.assertEqual(data['team'], 'BLUE')
            events=[json.loads(line) for line in request('POST','/api/plan-stream',body).splitlines()]
            self.assertEqual(events[0]['type'],'progress')
            self.assertEqual(events[-1]['type'],'result')
            self.assertEqual(events[-1]['team'],'BLUE')
        with patch('server.fetch_routes', side_effect=ValueError('No driving route found')):
            events=[json.loads(line) for line in request('POST','/api/plan-stream',body).splitlines()]
            self.assertEqual(events[-1]['type'],'error')
            self.assertIn('No driving route',events[-1]['error'])

if __name__ == '__main__':
    unittest.main()
