import io
import json
import unittest
from unittest.mock import patch
from urllib.error import URLError

from places import PlaceScorer, PlacesFeed, current_week, place_options, validate_places
from planner import LAT_STEP,LON_STEP,opportunity_score,search_routes


def place(identity=1,kind='landmark',row=0,col=0,points=5,rotates=True):
    return {'id':identity,'type':kind,'name':f'Place {identity}',
            'lat':(row+.5)*LAT_STEP,'lon':(col+.5)*LON_STEP,'points':points,'rotates':rotates}


def feed(*items,features=()):
    return {'available':True,'places':list(items),'week_start':current_week(),'truncated':False,
            'park_boundaries':{'type':'FeatureCollection','features':list(features)}}


def road(points,duration=100):
    return {'geometry':{'type':'LineString','coordinates':points},'duration':duration,'distance':1000,'legs':[]}


class PlaceTests(unittest.TestCase):
    def test_landmark_ring_revisits_and_cap(self):
        scorer=PlaceScorer(feed(place(1),place(2,row=8,points=25)),remaining=20)
        result=scorer.score({'0_0','0_1','1_1','8_0'})
        self.assertEqual(result['place_count'],2)
        self.assertEqual(result['place_bonus_uncapped'],30)
        self.assertEqual(result['place_bonus'],20)
        self.assertEqual(scorer.score({'2_0'})['place_bonus'],0)
        self.assertEqual(PlaceScorer(feed(place()),remaining=0).score({'0_0'})['place_bonus'],0)

    def test_highest_place_wins_and_used_winner_blocks_runner_up(self):
        data=feed(place(1,points=5),place(2,points=25))
        self.assertEqual(PlaceScorer(data).score({'0_0'})['place_bonus'],25)
        self.assertEqual(PlaceScorer(data,excluded=[2]).score({'0_0'})['place_bonus'],0)
        ties=PlaceScorer(feed(place(10),place(20))).score({'0_0'})
        expected=min((10,20),key=lambda i:(i*2654435761)%1000000007)
        self.assertEqual(ties['bonus_places'][0]['id'],expected)

    def test_summit_is_peak_cell_only_without_elevation_cells(self):
        scorer=PlaceScorer(feed(place(kind='summit',points=100,rotates=False)))
        self.assertEqual(scorer.score({'0_0'})['place_bonus'],100)
        self.assertEqual(scorer.score({'1_0'})['place_bonus'],0)

    def test_large_park_uses_perimeter_not_bbox_or_deep_interior(self):
        feature={'type':'Feature','properties':{'id':1,'name':'Forest','points':25},'geometry':{
            'type':'Polygon','coordinates':[[[0,0],[20*LON_STEP,0],[20*LON_STEP,20*LAT_STEP],[0,20*LAT_STEP],[0,0]]]}}
        scorer=PlaceScorer(feed(place(kind='park',rotates=False,points=25),features=[feature]))
        self.assertEqual(scorer.score({'0_5'})['place_bonus'],25)
        self.assertEqual(scorer.score({'10_10'})['place_bonus'],0)
        self.assertEqual(scorer.score({'-1_5'})['place_bonus'],25)
        unknown=PlaceScorer(feed(place(kind='park',rotates=False)))
        self.assertEqual(unknown.score({'0_0'})['place_bonus'],0)

    def test_friendly_territory_can_still_earn_place_bonus(self):
        candidate=road([[.0001,.0001],[.001,.001]])
        cells=[{'cell_id':'0_0','owner_team':'BLUE','scores':{'BLUE':1}}]
        result=opportunity_score(candidate,cells,place_scorer=PlaceScorer(feed(place()),weight=2))
        self.assertEqual(result['target_count'],0)
        self.assertEqual(result['territory_value'],0)
        self.assertEqual(result['capture_value'],10)
        self.assertEqual(result['place_bonus'],5)

    def test_bonus_detour_wins_without_breaking_budget_or_required_stop(self):
        start,end=[.0001,.0001],[.01,.0001]
        required=[.005,.0001]
        data=feed(place(1,row=4,col=1,points=25))
        cells=[{'cell_id':f'{r}_{c}','owner_team':'BLUE','scores':{'BLUE':1}} for r in range(-2,9) for c in range(-2,8)]
        def router(points,alternatives=False):return [road(points,100 if len(points)==3 else 120)]
        with patch('planner.exploration_points',return_value=[]),patch('planner.insertion_proposals',return_value=[]):
            result=search_routes(start,end,cells,30,router,waypoints=[required],places_loader=lambda *args:data)
        self.assertFalse(result['no_opportunities'])
        self.assertGreater(result['routes'][0]['place_bonus'],0)
        self.assertEqual(result['routes'][0]['target_count'],0)
        self.assertIn(required,result['routes'][0]['via_points'])
        self.assertLessEqual(result['routes'][0]['duration'],130)
        with patch('planner.exploration_points',return_value=[]),patch('planner.insertion_proposals',return_value=[]):
            capped=search_routes(start,end,cells,5,router,waypoints=[required],places_loader=lambda *args:data)
        self.assertTrue(capped['no_opportunities'])

    def test_disabled_weight_zero_and_week_change(self):
        loader=lambda *args:feed(place())
        candidate=road([[.0001,.0001],[.001,.001]])
        cells=[{'cell_id':'0_0','owner_team':'BLUE','scores':{'BLUE':1}}]
        result=search_routes([.0001,.0001],[.001,.001],cells,0,lambda *args:[candidate],places_loader=loader,
                             place_options={'remaining':0,'excluded':[1],'week':'2020-01-01'})
        self.assertEqual(result['routes'][0]['place_bonus'],5)
        self.assertEqual(result['places']['remaining'],100)
        for options in ({'enabled':False},{'weight':0}):
            result=search_routes([.0001,.0001],[.001,.001],cells,0,lambda *args:[candidate],places_loader=loader,place_options=options)
            self.assertTrue(result['no_opportunities'])

    def test_feed_cache_failure_rotation_and_bad_payload(self):
        provider=PlacesFeed()
        data=feed(place())
        with patch('places.urlopen',return_value=io.BytesIO(json.dumps(data).encode())) as fetch:
            first=provider.load([[0,0],[.01,.01]],60)
            again=provider.load([[0,0],[.01,.01]],60)
        self.assertEqual(fetch.call_count,1)
        self.assertTrue(first['available'])
        self.assertEqual(again['week_start'],current_week())
        with patch('places.time.time',return_value=first['last_success']+1801),patch('places.urlopen',side_effect=URLError('offline')):
            self.assertTrue(provider.load([[0,0],[.01,.01]],60)['stale'])
        with patch('places.current_week',return_value='2099-01-07'),patch('places.urlopen',side_effect=URLError('offline')):
            self.assertFalse(provider.load([[0,0],[.01,.01]],60)['available'])
        with self.assertRaises(ValueError):validate_places(dict(data,week_start='2020-01-01'))
        for item in ({'weight':True},{'remaining':101},{'excluded':[True]},{'week':'bad'}):
            with self.assertRaises(ValueError):place_options(item)
