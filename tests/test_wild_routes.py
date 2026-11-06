"""Deterministic budget, geography and preservation checks for the wild slots."""
import unittest
from unittest.mock import patch
from planner import wild_detours, search_routes, distance_meters, route_grid_cells
from route_bounds import point_inside

START=[.001,.001]
END=[.025,.001]


def router(points,alternatives=False):
    distance=sum(distance_meters(a,b) for a,b in zip(points,points[1:]))
    return [{'geometry':{'type':'LineString','coordinates':points},
             'duration':distance/8,'distance':distance,'legs':[]}]


class WildRoutesTests(unittest.TestCase):
    def test_directional_loops_scale_with_budget_and_preserve_waypoints(self):
        required=[[.01,.005],[.02,.003]]
        small=wild_detours(START,END,required,300)
        large=wild_detours(START,END,required,900)
        self.assertEqual(len(large),12)
        self.assertEqual(large,wild_detours(START,END,required,900))
        self.assertTrue(any(via[0][0]<START[0] for via,label in large if label=='Starts away from destination'))
        self.assertGreater(distance_meters(START,large[0][0][0]),distance_meters(START,small[0][0][0])*2.9)
        for via,label in large:
            self.assertLess(via.index(required[0]),via.index(required[1]))
        box={'west':-.002,'south':-.002,'east':.028,'north':.008}
        for via,label in wild_detours(START,END,required,900,box):
            self.assertTrue(all(point_inside(p,box) for p in via))
        self.assertEqual(wild_detours(START,END,[],0),[])

    def test_first_three_unchanged_and_wild_routes_add_new_territory(self):
        with patch('planner.wild_detours',return_value=[]):
            classic=search_routes(START,END,[],900,router)
        combined=search_routes(START,END,[],900,router)
        standard=combined['routes'][:3]
        wild=combined['routes'][3:]
        self.assertEqual(len(standard),3)
        self.assertEqual(len(wild),3)
        self.assertEqual([r['geometry'] for r in standard],[r['geometry'] for r in classic['routes']])
        self.assertTrue(all(r['route_kind']=='standard' for r in standard))
        self.assertTrue(all(r['route_kind']=='wild' for r in wild))
        references=list(standard)
        for r in wild:
            self.assertLessEqual(r['duration'],combined['baseline']['duration']+900+1e-6)
            self.assertTrue(0<=r['budget_used_fraction']<=1)
            footprint=route_grid_cells(r['geometry']['coordinates'])
            self.assertTrue(set(r['target_ids'])-set().union(*(set(ref['target_ids']) for ref in references)))
            for ref in references:
                other=route_grid_cells(ref['geometry']['coordinates'])
                self.assertGreaterEqual(len(footprint^other)/len(footprint|other),.35)
            references.append(r)
        self.assertTrue(any(r['wild_direction']=='Starts away from destination' and r['via_points'][0][0]<START[0] for r in wild))
        self.assertGreater(max(r['budget_used_fraction'] for r in wild),.8)
        self.assertLessEqual(combined['stats']['wild_search_requests'],12)
        self.assertLessEqual(combined['total_provider_requests'],101)

    def test_increasing_budget_reaches_further_and_uses_extra_time(self):
        short=search_routes(START,END,[],300,router)
        long=search_routes(START,END,[],900,router)
        def max_extra(result):
            return max(r['duration']-result['baseline']['duration'] for r in result['routes'] if r['route_kind']=='wild')
        self.assertGreater(max_extra(long),max_extra(short)*2)

    def test_no_wild_padding_when_roads_recalculate_to_the_same_path(self):
        def same_road(points,alternatives=False):return router([START,END])
        result=search_routes(START,END,[],900,same_road)
        self.assertEqual(len(result['routes']),1)
        self.assertFalse(any(r['route_kind']=='wild' for r in result['routes']))

    def test_provider_rejects_loops_without_losing_standard_routes(self):
        def reject_loops(points,alternatives=False):
            if len(points)>2:raise ValueError('No drivable road')
            return router(points)
        result=search_routes(START,END,[],900,reject_loops)
        self.assertEqual(result['routes'][0]['geometry'],router([START,END])[0]['geometry'])
        self.assertFalse(any(r['route_kind']=='wild' for r in result['routes']))
