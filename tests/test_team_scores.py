import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from team_scores import TeamScores, validate_scores, score_history
from teams import TEAMS


def payload():
    return {'season_id':3,'teams':[{'team':team,'tiles':i,'checkin_points':10.5,
             'explorer_points':20,'total':i+30.5} for i,team in enumerate(TEAMS)]}


class TeamScoreTests(unittest.TestCase):
    def test_full_score_breakdown_is_preserved(self):
        result=validate_scores(payload())
        self.assertEqual(len(result['teams']),7)
        self.assertEqual(result['teams'][0]['total'],30.5)
        self.assertEqual(result['teams'][0]['tiles'],0)
        self.assertEqual(result['teams'][0]['explorer_points'],20)

    def test_invalid_or_partial_totals_are_not_presented_as_zero(self):
        for field,value in (('total',float('nan')),('tiles',1.5),('total',True),('checkin_points',None),('explorer_points',-1)):
            data=payload();data['teams'][0][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):validate_scores(data)
        data=payload();data['teams'].pop()
        with self.assertRaises(ValueError):validate_scores(data)
        data=payload();data['teams'][-1]=data['teams'][0]
        with self.assertRaises(ValueError):validate_scores(data)

    def test_fetch_cache_restore_and_failure_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'scores.json'
            feed=TeamScores(path)
            self.assertFalse(feed.snapshot()['available'])
            with patch('team_scores.urlopen',return_value=io.BytesIO(json.dumps(payload()).encode())) as fetch:
                feed.refresh()
            self.assertTrue(feed.snapshot()['available'])
            self.assertFalse(feed.snapshot()['stale'])
            self.assertEqual(fetch.call_args.args[0].full_url,'https://meshwars.com/scores')
            restored=TeamScores(path)
            self.assertTrue(restored.snapshot()['stale'])
            with patch('team_scores.urlopen',side_effect=URLError('offline')):
                restored.refresh()
            self.assertEqual(restored.snapshot()['teams'],feed.snapshot()['teams'])
            self.assertTrue(restored.snapshot()['error'])
            with patch('team_scores.urlopen',return_value=io.BytesIO(b'{"teams":[]}')):
                feed.refresh()
            self.assertEqual(len(feed.snapshot()['teams']),7)
            self.assertTrue(feed.snapshot()['stale'])

    def test_recorded_history_persists_real_changes_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'scores.json';feed=TeamScores(path)
            first=payload();second=payload();second['teams'][0]['total']+=5;second['teams'][0]['explorer_points']+=5
            for at,data in [(1000000,first),(1001800,second)]:
                with patch('team_scores.time.time',return_value=at),patch('team_scores.urlopen',return_value=io.BytesIO(json.dumps(data).encode())):feed.refresh()
            self.assertEqual([r['teams'][0]['total'] for r in feed.snapshot()['history']],[30.5,35.5])
            with patch('team_scores.time.time',return_value=1001900):restored=TeamScores(path)
            self.assertEqual(restored.snapshot()['history'],feed.snapshot()['history'])
            snapshot=restored.snapshot();snapshot['history'][0]['teams'][0]['total']=999
            self.assertEqual(restored.snapshot()['history'][0]['teams'][0]['total'],30.5)
            with patch('team_scores.urlopen',side_effect=URLError('offline')):restored.refresh()
            self.assertEqual(len(restored.snapshot()['history']),2)

    def test_history_prunes_old_rows_bounds_size_and_separates_seasons(self):
        now=1000000
        rows=[dict(payload(),at=now-6*86400),dict(payload(),at=now-5*86400),dict(payload(),at=now-2*86400),dict(payload(),at=now)]
        self.assertEqual(len(score_history(rows,now,3)),3)
        self.assertEqual(score_history(rows,now,4),[])
        self.assertEqual(len(score_history([dict(payload(),at=now-i) for i in range(700)],now,3)),512)
        self.assertEqual(score_history([dict(payload(),at=float('nan')),dict(payload(),at=now+1),{}],now,3),[])

    def test_legacy_cache_becomes_a_real_history_anchor(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'scores.json';path.write_text(json.dumps({'data':payload(),'last_success':1000000}))
            with patch('team_scores.time.time',return_value=1000100):feed=TeamScores(path)
            self.assertEqual(feed.snapshot()['history'][0]['at'],1000000)
