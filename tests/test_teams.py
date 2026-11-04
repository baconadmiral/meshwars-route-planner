"""Team selection affects every search stage and export without changing budgets."""
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

from teams import TEAMS
from planner import search_routes, target_value, opportunity_score, insertion_proposals
from navigation import build_export, GPX_NS


def road(points, alternatives=False):
    return {'geometry': {'type': 'LineString', 'coordinates': points},
            'duration': 100, 'distance': 1000, 'legs': []}


class TeamTests(unittest.TestCase):
    def test_all_teams_exclude_friendly_squares_at_every_search_stage(self):
        start, end = [.0001, .0001], [.005, .0001]
        for index, team in enumerate(TEAMS):
            with self.subTest(team=team):
                enemy = TEAMS[(index+1) % len(TEAMS)]
                cells = [{'cell_id': '0_0', 'owner_team': team, 'scores': {team: 1}},
                         {'cell_id': '0_1', 'owner_team': enemy, 'scores': {enemy: 1}}]
                for col,cell in enumerate(cells):
                    cell.update(west=col*.00384,east=(col+1)*.00384,south=0,north=.0027)
                self.assertEqual(target_value(cells[0], team), 0)
                self.assertEqual(target_value(cells[1], team), 1)
                scored = opportunity_score(road([start, end]), cells, team)
                self.assertEqual(scored['target_ids'], ['0_1'])
                self.assertEqual(scored['capture_value'], 1)
                # Wrapping the real proposal function exercises refinement too.
                with patch('planner.insertion_proposals', wraps=insertion_proposals) as proposals:
                    result = search_routes(start, end, cells, 30,
                                           lambda points, alternatives=False: [road(points)],
                                           team=team)
                self.assertEqual(result['team'], team)
                self.assertTrue(proposals.called)
                self.assertTrue(all(call.kwargs['team'] == team for call in proposals.call_args_list))
                self.assertTrue(result['routes'])
                for route in result['routes']:
                    self.assertNotIn('0_0', route['target_ids'])
                    self.assertLessEqual(route['duration'], 130)

    def test_bad_teams_rejected_before_provider_request(self):
        router = Mock()
        for team in ('blue', 'BLACK', None, [], 1):
            with self.subTest(team=team), self.assertRaises(ValueError):
                search_routes([0, 0], [1, 1], [], 0, router, team=team)
        router.assert_not_called()

    def test_gpx_uses_selected_team_and_defaults_to_blue(self):
        for team in TEAMS:
            route = dict(road([[0, 0], [1, 1]]), team=team)
            root = ET.fromstring(build_export(route)['gpx'])
            name = root.find(f'{{{GPX_NS}}}trk/{{{GPX_NS}}}name').text
            self.assertIn(team, name)
        self.assertIn('BLUE planned route', build_export(road([[0, 0], [1, 1]]))['gpx'])
        with self.assertRaises(ValueError):
            build_export(dict(road([[0, 0], [1, 1]]), team='invalid'))
