"""Build identity must match CI metadata without exposing arbitrary environment values."""
import os
import unittest
from unittest.mock import patch

from app_version import build_version


class AppVersionTests(unittest.TestCase):
    def test_production_commit(self):
        revision = '303c9597cabbd714332efc804f33e96084c19f35'
        with patch.dict(os.environ, {'APP_REVISION': revision.upper()}):
            self.assertEqual(build_version(), {'version': revision[:12], 'revision': revision})

    def test_missing_or_invalid_metadata_is_development(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(build_version(), {'version': 'development', 'revision': None})
        for value in ('development', 'latest', 'abc123', '<script>', 'a'*41):
            with self.subTest(value=value), patch.dict(os.environ, {'APP_REVISION': value}):
                self.assertEqual(build_version(), {'version': 'development', 'revision': None})
