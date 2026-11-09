import unittest
from unittest.mock import Mock
from planner import search_routes
from road_blocks import validate_blocked_roads, route_blocked, validate_blocked_stops, hits_road, find_bypass_routes, StopsOnBlockedRoad
from route_bounds import route_inside

START=[-.01,0]
END=[.01,0]
BLOCK={'coordinates':[[0,-.001],[0,.001]],'buffer_meters':20}


def road(points,duration=100):
    return {'geometry':{'type':'LineString','coordinates':points},'duration':duration,'distance':1000,'legs':[]}


class RoadBlockTests(unittest.TestCase):
    def test_crossing_and_buffer_are_detected_without_matching_vertices(self):
        self.assertTrue(route_blocked(road([START,END]),[BLOCK]))
        self.assertFalse(route_blocked(road([START,[-.002,.003],[.002,.003],END]),[BLOCK]))
        self.assertTrue(hits_road([[.0001,-.0005],[.0001,.0005]],BLOCK))
        self.assertFalse(hits_road([[.001,-.0005],[.001,.0005]],BLOCK))
        self.assertTrue(hits_road([[0,0]],BLOCK))

    def test_invalid_and_excessive_marks_are_rejected(self):
        for value in ({},[{}],[{'coordinates':[[0,0],[0,0]]}],
                      [{'coordinates':[[0,0],[1,1]],'buffer_meters':True}],
                      [{'coordinates':[[0,0],[1,1]],'buffer_meters':1000}],
                      [{'coordinates':[[0,0],[float('nan'),1]]}], [BLOCK]*11):
            with self.subTest(value=value),self.assertRaises(ValueError):validate_blocked_roads(value)
        self.assertEqual(validate_blocked_roads([BLOCK]),[BLOCK])

    def test_blocked_stops_are_named_before_routing(self):
        for start,end,via,label in (([0,0],END,[],'Start'),(START,[0,0],[],'Destination'),(START,END,[[0,0]],'Waypoint W1')):
            router=Mock()
            with self.assertRaisesRegex(ValueError,label):search_routes(start,end,[],0,router,waypoints=via,blocked_roads=[BLOCK])
            router.assert_not_called()

    def test_unblocked_provider_alternative_is_selected(self):
        safe=road([START,[-.002,.003],[.002,.003],END],130)
        result=search_routes(START,END,[],0,lambda *args:[road([START,END]),safe],blocked_roads=[BLOCK])
        self.assertEqual(result['baseline']['duration'],130)
        self.assertEqual(result['total_provider_requests'],1)
        self.assertTrue(all(not route_blocked(r,[BLOCK]) for r in result['routes']))

    def test_bypass_preserves_waypoint_order_budget_and_export_stops(self):
        required=[[-.005,0],[.005,0]]
        calls=[]
        def router(points,alternatives=False):
            calls.append(points)
            return [road(points,100+20*(len(points)-2))]
        bounds={'west':-.02,'east':.02,'south':-.02,'north':.02}
        result=search_routes(START,END,[],30,router,waypoints=required,blocked_roads=[BLOCK],allowed_bounds=bounds,strategy='greedy')
        self.assertGreater(result['baseline']['duration'],140)
        for r in [result['baseline'],*result['routes']]:
            self.assertFalse(route_blocked(r,[BLOCK]))
            self.assertTrue(route_inside(r,bounds))
            self.assertLessEqual(r['duration'],result['baseline']['duration']+30)
        for points in calls:
            self.assertLess(points.index(required[0]),points.index(required[1]))
        self.assertTrue(any(label=='road avoidance' for label in result['baseline']['stop_labels']))
        self.assertEqual(result['total_provider_requests'],len(calls))
        self.assertEqual(result['blocked_roads'],[BLOCK])

    def test_no_bypass_fails_clearly_with_bounded_requests(self):
        calls=[]
        def router(points,alternatives=False):
            calls.append(points);return [road([START,END])]
        with self.assertRaisesRegex(ValueError,'No accessible road route'):
            search_routes(START,END,[],600,router,blocked_roads=[BLOCK])
        self.assertLessEqual(len(calls),13)

    def test_tight_allowed_area_does_not_relax_either_constraint(self):
        bounds={'west':-.02,'east':.02,'south':-.0005,'north':.0005}
        with self.assertRaisesRegex(ValueError,'No accessible road route'):
            search_routes(START,END,[],600,lambda *args:[road([START,END])],blocked_roads=[BLOCK],allowed_bounds=bounds)

    def test_curved_waypoint_leg_gets_bypass_instead_of_nearest_chord(self):
        waypoint=[-.005,.01]
        points=[START,waypoint,END]
        crossing=[START,[0,0],waypoint]
        safe_second=[waypoint,[.005,.01],END]
        rejected=road(crossing+safe_second[1:])
        rejected['legs']=[{'steps':[{'geometry':{'coordinates':crossing}}]},
                          {'steps':[{'geometry':{'coordinates':safe_second}}]}]
        calls=[]
        def router(chain,alternatives=False):
            calls.append(chain)
            if chain.index(waypoint)==1:return [rejected]
            return [road(chain)]
        routes=find_bypass_routes(points,[rejected],[BLOCK],router)
        self.assertTrue(routes)
        self.assertLessEqual(len(calls),12)
        self.assertEqual(calls[0].index(waypoint),3)
        self.assertTrue(all(chain.index(waypoint)>=3 for chain in calls))
        self.assertTrue(all(not route_blocked(r,[BLOCK]) for r in routes))
        self.assertTrue(all(waypoint in r['_avoidance_via'] for r in routes))

    def test_blocked_waypoint_has_machine_readable_stop_identity(self):
        with self.assertRaises(StopsOnBlockedRoad) as caught:
            validate_blocked_stops(START,END,[[0,0]],[BLOCK])
        self.assertEqual(caught.exception.stop_keys,['W1'])

    def test_unreachable_waypoint_error_explains_mandatory_stops(self):
        with self.assertRaisesRegex(ValueError,'Required waypoints W1 must still be visited'):
            search_routes(START,END,[],600,lambda *args:[road([START,END])],
                          waypoints=[[-.005,0]],blocked_roads=[BLOCK])
