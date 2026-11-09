"""Build identity must match CI metadata without exposing arbitrary environment values."""
import os
import unittest
from unittest.mock import patch

from app_version import build_version, recent_changes


class AppVersionTests(unittest.TestCase):
    def test_change_notes_are_bounded_and_invalid_metadata_is_ignored(self):
        with patch.dict(os.environ, {'APP_CHANGES': '[" Phone searches ", "<b>Text only</b>", 123, "", "One", "Two", "Three", "Four"]'}):
            self.assertEqual(build_version()['changes'], ['Phone searches','<b>Text only</b>','One','Two','Three'])
        for value in ('invalid JSON', '{"not":"a list"}', 'null'):
            with self.subTest(value=value), patch.dict(os.environ, {'APP_CHANGES':value}):
                self.assertEqual(build_version()['changes'], [])

    def test_recent_changes_use_merge_pr_titles_and_squash_subjects(self):
        history='Merge pull request #20 from user/feature\n\nKeep searches running when phones sleep\n\0\nAdd territory reports (#19)\n\0\nAdd territory reports (#19)\n\0'
        with patch('app_version.subprocess.check_output',return_value=history):
            self.assertEqual(recent_changes(), ['Keep searches running when phones sleep','Add territory reports (#19)'])

    def test_production_commit(self):
        revision = '303c9597cabbd714332efc804f33e96084c19f35'
        with patch.dict(os.environ, {'APP_REVISION': revision.upper(), 'APP_CHANGES': '[]'}):
            self.assertEqual(build_version(), {'version': revision[:12], 'revision': revision, 'changes': []})

    def test_missing_or_invalid_metadata_is_development(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(build_version(), {'version': 'development', 'revision': None, 'changes': []})
        for value in ('development', 'latest', 'abc123', '<script>', 'a'*41):
            with self.subTest(value=value), patch.dict(os.environ, {'APP_REVISION': value, 'APP_CHANGES': '[]'}):
                self.assertEqual(build_version(), {'version': 'development', 'revision': None, 'changes': []})
