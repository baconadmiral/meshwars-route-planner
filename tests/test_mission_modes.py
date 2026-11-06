import unittest
from unittest.mock import Mock,patch
from mission_modes import MissionCells,mission_index
from planner import opportunity_score,search_routes,route_grid_cells,route_rank,target_value,insertion_proposals
from places import PlaceScorer,current_week
from road_blocks import route_blocked
from route_bounds import route_inside


def cell(row,col,team='RED',score=1):
    return {'cell_id':f'{row}_{col}','owner_team':team,'scores':{team:score},
            'south':row*.0027,'north':(row+1)*.0027,'west':col*.00384,'east':(col+1)*.00384}


def route(coords,duration=100):
    return {'geometry':{'type':'LineString','coordinates':coords},'duration':duration,'distance':1000,'legs':[]}


class MissionModeTests(unittest.TestCase):
    def test_offensive_weights_enemy_over_unpainted_without_changing_raw_counts(self):
        cells=MissionCells([cell(0,0)],'BLUE','offensive')
        scored=opportunity_score(route([[.001,.001],[.007,.001]]),cells)
        self.assertEqual(scored['capture_value'],3.2)
        self.assertEqual(scored['target_count'],2)
        self.assertEqual(scored['territory_value'],2)
        self.assertEqual(sum(g['priority'] for g in scored['mission_breakdown']),3.2)

    def test_fortify_scores_friendly_weakness_and_enemy_border(self):
        rows=[cell(0,0,'BLUE',0),cell(0,1,'RED'),cell(3,0,'BLUE',0),cell(6,0,'BLUE',10)]
        context=MissionCells(rows,'BLUE','fortify')
        index=mission_index(context)
        self.assertEqual(target_value(index.get('0_0')),3)
        self.assertEqual(target_value(index.get('3_0')),2)
        self.assertLess(target_value(index.get('6_0')),2)
        self.assertEqual(target_value(index.get('0_1')),0)
        self.assertEqual(target_value(index.get('99_99')),0)
        r=opportunity_score(route([[.0001,.0001],[.003,.0001]]),context)
        self.assertEqual(r['reinforcement_ids'],['0_0'])
        self.assertEqual(r['mission_target_count'],1)
        self.assertEqual(r['target_count'],0)

    def test_fortify_proposals_seek_unvisited_friendly_squares(self):
        start,end=[.0001,.0001],[.003,.0001]
        context=MissionCells([cell(0,0,'BLUE',20),cell(1,0,'BLUE',0)],'BLUE','fortify')
        proposals=insertion_proposals(start,end,route([start,end]),[],context)
        self.assertTrue(any([.00384/2,.0027*1.5] in via for via in proposals))
        from radio_coverage import annotate_routes
        scored=opportunity_score(route([start,end]),context)
        result={'baseline':scored,'routes':[scored]}
        annotate_routes(result,{'events':[],'configured':False})
        self.assertEqual(scored['radio_coverage']['targets']['unknown'],1)

    def test_frontier_favors_side_adjacency_over_remote_unpainted(self):
        index=mission_index(MissionCells([cell(0,0,'BLUE')],'BLUE','frontier'))
        self.assertEqual(target_value(index.get('0_1')),2)
        self.assertEqual(target_value(index.get('10_10')),.15)
        self.assertEqual(target_value(index.get('1_1')),.15)  # corners do not share a side

    def test_supply_penalty_and_flanking_factor_use_actual_baseline(self):
        coords=[[.001,.001],[.007,.001]]
        supply=MissionCells([],'BLUE','supply');supply.baseline_seconds=100
        cheap=opportunity_score(route(coords,100),supply)
        costly=opportunity_score(route(coords,280),supply)
        self.assertAlmostEqual(costly['capture_value'],cheap['capture_value']/2)
        flank=MissionCells([],'BLUE','flanking');flank.baseline_cells={'0_0'}
        scored=opportunity_score(route(coords),flank)
        self.assertEqual(scored['mission_multiplier'],1.375)

    def test_mode_changes_selected_road_not_just_label(self):
        start,end=[.001,.001],[.01,.001]
        direct=route([start,end],100)
        detour=route([start,[.001,.004],[.01,.004],end],120)
        rows=[cell(0,c) for c in range(3)]+[cell(1,c,'BLUE',0) for c in range(3)]
        def router(*args):return [direct,detour]
        offense=search_routes(start,end,rows,30,router,mission_mode='offensive')
        fortify=search_routes(start,end,rows,30,router,mission_mode='fortify')
        self.assertEqual(offense['routes'][0]['geometry'],direct['geometry'])
        self.assertEqual(fortify['routes'][0]['geometry'],detour['geometry'])
        self.assertGreater(fortify['routes'][0]['reinforcement_count'],0)
        distant=route(detour['geometry']['coordinates'],1000)
        rows=[cell(r,c) for r in (0,1) for c in range(3)]
        supply=search_routes(start,end,rows,1000,lambda *args:[direct,distant],mission_mode='supply')
        self.assertEqual(supply['routes'][0]['geometry'],direct['geometry'])

    def test_special_ops_uses_capped_place_points_and_requires_enabled_source(self):
        start,end=[.0001,.0001],[.001,.001]
        data={'available':True,'week_start':current_week(),'places':[{'id':1,'name':'Test landmark','type':'landmark','lat':.001,'lon':.001,'points':25,'rotates':True}],'truncated':False}
        kwargs={'mission_mode':'special_ops','places_loader':lambda *args:data,'place_options':{'remaining':10,'weight':2}}
        result=search_routes(start,end,[cell(0,0,'BLUE')],0,lambda *args:[route([start,end])],**kwargs)
        r=result['routes'][0]
        self.assertEqual(r['place_bonus'],10)
        self.assertEqual(r['capture_value'],60)
        self.assertEqual(r['mission_territory_value'],0)
        for change in ({'places_loader':None},{'place_options':{'enabled':False}},{'place_options':{'weight':0}}):
            router=Mock()
            with self.assertRaises(ValueError):search_routes(start,end,[],0,router,**{**kwargs,**change})
            router.assert_not_called()
        zero=search_routes(start,end,[],0,lambda *args:[route([start,end])],**{**kwargs,'place_options':{'remaining':0}})
        self.assertTrue(zero['no_opportunities'])

    def test_modes_keep_hard_constraints_and_waypoint_order(self):
        start,end=[-.01,0],[.01,0];manual=[[-.005,.004]]
        block={'coordinates':[[0,-.001],[0,.001]],'buffer_meters':20}
        bounds={'west':-.02,'east':.02,'south':-.02,'north':.02}
        for mode in ('offensive','fortify','frontier','flanking','supply'):
            calls=[]
            def router(points,alternatives=False):calls.append(points);return [route(points,100+10*len(points))]
            rows=[cell(0,-2,'BLUE',0)]
            result=search_routes(start,end,rows,30,router,mission_mode=mode,waypoints=manual,blocked_roads=[block],allowed_bounds=bounds)
            for points in calls:self.assertIn(manual[0],points)
            for r in result['routes']:
                self.assertTrue(route_inside(r,bounds));self.assertFalse(route_blocked(r,[block]))
                self.assertLessEqual(r['duration'],result['baseline']['duration']+30)

    def test_invalid_mode_rejected_without_provider_call(self):
        router=Mock()
        for mode in (None,[],False,'unknown'):
            with self.assertRaises(ValueError):search_routes([0,0],[.01,0],[],60,router,mission_mode=mode)
        router.assert_not_called()
