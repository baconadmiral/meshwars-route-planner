import io
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from planner import choose, intersects, score, candidate_points, opportunity_score, exploration_points, search_routes, route_grid_cells, insertion_proposals, route_anchors, routing_batch, target_value, owner_score, route_rank, LAT_STEP, LON_STEP
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


class LocalRefinementTests(unittest.TestCase):
    def test_samples_middle_of_long_straight_road(self):
        anchors=route_anchors([[0,0],[.05,0]])
        self.assertTrue(any(.02 < p[0] < .03 for p in anchors))
        self.assertLessEqual(len(anchors),102)

    def test_preserves_existing_waypoints_when_inserting(self):
        start,end=[.001,.001],[.012,.001]
        via=[[.006,.004]]
        proposals=insertion_proposals(start,end,route([start,*via,end]),via,[])
        self.assertTrue(proposals)
        self.assertTrue(all(via[0] in points and len(points)==2 for points in proposals))

    def test_iterative_refinement_gains_missed_squares_without_more_seed_routes(self):
        start,end=[.001,.001],[.014,.001]
        calls=[]
        def router(points,alternatives=False):
            calls.append(points)
            return [route(points,100+20*(len(points)-2))]
        with patch('planner.exploration_points',return_value=[]):
            result=search_routes(start,end,[],60,router,strategy='greedy')
        self.assertGreater(result['routes'][0]['target_count'],result['baseline']['target_count'])
        self.assertTrue(any(len(points)>=4 for points in calls))
        self.assertLessEqual(len(calls),13)  # one baseline + at most 12 refinements
        self.assertTrue(all(r['duration']<=160 for r in result['routes']))
        self.assertEqual(calls[0],[start,end])
        self.assertTrue(all(points[0]==start and points[-1]==end for points in calls))

    def test_no_refinement_can_replace_incumbent_with_worse_route(self):
        start,end=[.001,.001],[.014,.001]
        direct=route([start,end])
        def router(points,alternatives=False):
            return [direct if len(points)==2 else route([start,end],110)]
        with patch('planner.exploration_points',return_value=[]):
            result=search_routes(start,end,[],60,router,strategy='greedy')
        self.assertEqual(result['routes'][0]['duration'],100)
        self.assertEqual(result['routes'][0]['target_count'],result['baseline']['target_count'])


class BeamSearchTests(unittest.TestCase):
    def branching_fixture(self):
        start,end=[.0001,.0001],[.001,.0001]
        a,b,c,d=[1.,1.],[2.,2.],[3.,3.],[4.,4.]
        calls=[]
        def make_route(count,via):
            r=route([start,[(count-.5)*LON_STEP,.0001],end],100+20*len(via))
            r['branch']=via
            return r
        def router(points,alternatives=False):
            calls.append((points,alternatives))
            via=points[1:-1]
            if via==[a]:count=4
            elif via==[b]:count=3
            elif via==[a,c]:count=4
            elif via==[b,c]:count=2  # temporarily worse; greedy cannot follow it
            elif via==[b,c,d]:count=9
            else:count=1
            return [make_route(count,via)]
        def proposals(start,end,r,via,cells,limit=4):
            if via in ([a],[b]):return [via+[c]]
            if via==[b,c]:return [via+[d]]
            return []
        return start,end,a,b,calls,router,proposals

    def test_comparison_escapes_greedy_local_optimum_and_reuses_requests(self):
        start,end,a,b,calls,router,proposals=self.branching_fixture()
        updates=[]
        with patch('planner.exploration_points',return_value=[a,b]),patch('planner.insertion_proposals',side_effect=proposals):
            result=search_routes(start,end,[],100,router,updates.append,strategy='compare')
        strategies=result['strategy_results']
        self.assertEqual(strategies['greedy']['routes'][0]['target_count'],4)
        self.assertEqual(strategies['beam']['routes'][0]['target_count'],9)
        self.assertTrue(all(r['duration']<=200 for m in strategies.values() for r in m['routes']))
        self.assertEqual(len(calls),len({str(call) for call in calls}))
        self.assertEqual(result['total_provider_requests'],len(calls))
        self.assertEqual(result['shared_provider_requests'],3)
        self.assertEqual(result['strategy'],'beam')
        self.assertEqual(strategies['beam']['stats']['beam_width'],6)
        self.assertEqual(strategies['greedy']['stats']['beam_width'],1)
        self.assertEqual([u['percent'] for u in updates],sorted(u['percent'] for u in updates))

    def test_beam_request_limit_and_no_initial_route_regression(self):
        calls=[]
        def router(points,alternatives=False):
            calls.append(points)
            return [route(points,100+10*(len(points)-2))]
        with patch('planner.exploration_points',return_value=[]):
            result=search_routes([.001,.001],[.014,.001],[],100,router,strategy='beam')
        self.assertLessEqual(result['stats']['refinement_requests'],72)
        self.assertLessEqual(len(calls),73)
        self.assertGreaterEqual(result['routes'][0]['target_count'],result['baseline']['target_count'])

    def test_zero_budget_comparison_makes_one_shared_request(self):
        calls=[]
        def router(points,alternatives=False):
            calls.append(points)
            return [route(points)]
        result=search_routes([.001,.001],[.014,.001],[],0,router,strategy='compare')
        self.assertEqual(len(calls),1)
        self.assertEqual(result['strategy_results']['beam']['stats']['refinement_requests'],0)
        self.assertEqual(result['strategy_results']['beam']['stats']['beam_width'],6)
        self.assertEqual(result['strategy_results']['greedy']['stats']['refinement_requests'],0)

    def test_beam_returns_six_distinct_routes_and_greedy_stays_at_three(self):
        start,end=[.0001,.0001],[.001,.0001]
        candidates=[route([start,[(n+.5)*LON_STEP,.0001],end]) for n in range(1,7)]
        result=search_routes(start,end,[],0,lambda *args:candidates,strategy='compare')
        beam=result['strategy_results']['beam']['routes']
        greedy=result['strategy_results']['greedy']['routes']
        self.assertEqual(len(beam),6)
        self.assertEqual(len(greedy),3)
        self.assertEqual(len({str(r['geometry']) for r in beam}),6)

    def test_invalid_strategy_rejected_before_routing(self):
        router=unittest.mock.Mock()
        with self.assertRaises(ValueError):
            search_routes([0,0],[1,1],[],60,router,strategy='invalid')
        router.assert_not_called()


class ParallelRoutingTests(unittest.TestCase):
    def test_parallel_batch_is_bounded_and_returns_original_order(self):
        barrier=threading.Barrier(4)
        lock=threading.Lock()
        active=peak=0
        def router(points):
            nonlocal active,peak
            with lock:
                active+=1
                peak=max(peak,active)
            barrier.wait(timeout=2)
            with lock:active-=1
            return [points[0]]
        updates=[]
        outcomes=routing_batch([[i] for i in range(8)],router,4,lambda done,total:updates.append(done))
        self.assertEqual([r for r,error in outcomes],[[i] for i in range(8)])
        self.assertTrue(all(error is None for _,error in outcomes))
        self.assertEqual(peak,4)
        self.assertEqual(updates,list(range(1,9)))

    def test_parallel_and_serial_search_have_identical_results(self):
        signatures=[]
        for workers in (1,4):
            start,end,a,b,calls,router,proposals=BeamSearchTests().branching_fixture()
            with patch('planner.exploration_points',return_value=[a,b]),patch('planner.insertion_proposals',side_effect=proposals):
                result=search_routes(start,end,[],100,router,strategy='compare',workers=workers)
            signatures.append({mode:[(r['target_count'],r['capture_value'],r['duration'],r['geometry']) for r in value['routes']]
                               for mode,value in result['strategy_results'].items()})
        self.assertEqual(signatures[0],signatures[1])

    def test_duplicate_concurrent_requests_share_one_provider_call(self):
        lock=threading.Lock()
        calls=[]
        start,end,target=[.001,.001],[.014,.001],[.007,.005]
        def router(points,alternatives=False):
            with lock:calls.append(points)
            if len(points)>2:time.sleep(.02)
            return [route(points)]
        with patch('planner.exploration_points',return_value=[target]*4),patch('planner.insertion_proposals',return_value=[]):
            result=search_routes(start,end,[],60,router,workers=4)
        self.assertEqual(len(calls),2)
        self.assertEqual(result['total_provider_requests'],2)

    def test_failed_request_does_not_discard_successful_batch_results(self):
        def router(points):
            if points==[1]:raise ValueError('No route')
            return points
        outcomes=routing_batch([[0],[1],[2]],router,3,lambda *args:None)
        self.assertEqual(outcomes[0],([0],None))
        self.assertIsInstance(outcomes[1][1],ValueError)
        self.assertEqual(outcomes[2],([2],None))

    def test_public_provider_request_starts_are_spaced(self):
        from server import routing_response
        with patch('server.ROUTING_INTERVAL',1),patch('server._LAST_REQUEST_START',100), \
             patch('server.time.monotonic',side_effect=[100.25,101]),patch('server.time.sleep') as sleep, \
             patch('server.urlopen',return_value=io.BytesIO(b'{"code":"Ok"}')):
            self.assertEqual(routing_response('https://example.test/route')['code'],'Ok')
            sleep.assert_called_once_with(.75)

    def test_invalid_worker_count_rejected_before_routing(self):
        for workers in (0,17,True,1.5):
            with self.assertRaises(ValueError):
                search_routes([0,0],[1,1],[],60,lambda *args:[],workers=workers)


class CaptureDifficultyTests(unittest.TestCase):
    def cell(self,row,col,points,owner='RED'):
        return dict(cell_id=f'{row}_{col}',owner_team=owner,scores={owner:points,'GREEN':99},
                    south=row*LAT_STEP,north=(row+1)*LAT_STEP,
                    west=col*LON_STEP,east=(col+1)*LON_STEP)

    def test_uses_owner_score_and_strongly_discounts_defended_squares(self):
        self.assertEqual(target_value(self.cell(0,0,.9)),1)
        self.assertEqual(target_value(self.cell(0,0,1)),1)
        self.assertAlmostEqual(target_value(self.cell(0,0,2)),.25)
        self.assertAlmostEqual(target_value(self.cell(0,0,50)),.0004)
        self.assertEqual(target_value(self.cell(0,0,0,owner='BLUE')),0)

    def test_missing_or_invalid_scores_are_unknown_not_zero(self):
        for value in (None,'50',-1,True,float('nan'),float('inf')):
            cell=self.cell(0,0,value)
            self.assertIsNone(owner_score(cell))
            self.assertEqual(target_value(cell),.5)
        self.assertEqual(target_value(None),1)

    def test_easy_route_beats_more_fifty_point_squares(self):
        cells=[self.cell(0,0,.9)]+[self.cell(1,col,50) for col in range(5)]
        easy=opportunity_score(route([[.0001,.001],[.003,.001]]),cells)
        hard=opportunity_score(route([[.0001,.004],[4.9*LON_STEP,.004]]),cells)
        self.assertEqual(easy['target_count'],1)
        self.assertEqual(hard['target_count'],5)
        self.assertLess(route_rank(easy),route_rank(hard))
        self.assertEqual(easy['easy_enemy_count'],1)
        self.assertEqual(hard['hard_enemy_count'],5)
        self.assertAlmostEqual(hard['capture_value'],.002)

    def test_unique_visits_and_unpainted_values_are_separate(self):
        cells=[self.cell(0,0,.5),self.cell(0,1,None)]
        scored=opportunity_score(route([[.0001,.001],[2.9*LON_STEP,.001],[.0001,.001]]),cells)
        self.assertEqual(scored['target_count'],3)
        self.assertEqual(scored['easy_enemy_count'],1)
        self.assertEqual(scored['unknown_score_count'],1)
        self.assertEqual(scored['unmapped_count'],1)
        self.assertEqual(scored['capture_value'],2.5)

    def test_candidate_selection_prefers_low_score_targets(self):
        hard=self.cell(0,0,50)
        easy=self.cell(0,1,.5)
        selected=candidate_points([.0001,.001],[.01,.001],[hard,easy],limit=1)
        self.assertEqual(selected,[[(easy['west']+easy['east'])/2,(easy['south']+easy['north'])/2]])


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
        body = json.dumps({'start':[-1,.5], 'end':[2,.5], 'detour_minutes':0, 'strategy':'compare'}).encode()
        with patch('server.fetch_routes', return_value=[route([[.0001,.0001],[.0002,.0002]])]):
            data = json.loads(request('POST', '/api/plan', body))
            self.assertEqual(data['routes'][0]['target_count'], 1)
            self.assertEqual(data['team'], 'BLUE')
            self.assertIn('greedy',data['strategy_results'])
            self.assertIn('beam',data['strategy_results'])
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
