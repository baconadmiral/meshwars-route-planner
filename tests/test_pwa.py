"""Public install metadata, build-specific workers, and both HTTP entry points."""
import io
import json
import struct
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from hosting import create_app
from pwa import PWA_ASSETS, service_worker
from server import Handler


ROOT = Path(__file__).resolve().parents[1]


class PwaTests(unittest.TestCase):
    def test_manifest_scope_and_real_icon_dimensions(self):
        manifest = json.loads((ROOT/'static/manifest.webmanifest').read_text())
        self.assertEqual(manifest['start_url'], '/')
        self.assertEqual(manifest['scope'], '/')
        self.assertEqual(manifest['id'], '/')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['shortcuts'][0]['url'], '/reports')
        for icon in manifest['icons']:
            data = (ROOT/'static'/icon['src'].lstrip('/')).read_bytes()
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            width, height = struct.unpack('>II', data[16:24])
            self.assertEqual(icon['sizes'], f'{width}x{height}')
        self.assertEqual(struct.unpack('>II', (ROOT/'static/icons/apple-touch-icon.png').read_bytes()[16:24]), (180, 180))

    def test_worker_changes_with_build_and_never_embeds_invalid_metadata(self):
        with patch.dict('os.environ', {'APP_REVISION': 'a'*40}):
            first = service_worker()
        with patch.dict('os.environ', {'APP_REVISION': 'b'*40}):
            second = service_worker()
        self.assertNotEqual(first, second)
        self.assertNotIn('__BUILD_REVISION__', first)
        with patch.dict('os.environ', {'APP_REVISION': "untrusted'input"}):
            self.assertNotIn("untrusted'input", service_worker())

    def test_hosted_assets_have_explicit_types_and_worker_is_not_cached(self):
        client = create_app(SimpleNamespace(board=Mock()), 1).test_client()
        for path, (_, content_type) in PWA_ASSETS.items():
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, content_type)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                if path == '/sw.js':
                    self.assertNotIn(b'__BUILD_REVISION__', response.data)
                response.close()
        for path in ('/', '/reports'):
            response = client.get(path)
            self.assertIn(b'rel="manifest"', response.data)
            self.assertIn(b'/pwa.js', response.data)
            self.assertIn(b'data-install-app hidden', response.data)
            response.close()

    def test_development_server_serves_manifest_and_worker(self):
        for path, content_type in [('/manifest.webmanifest', 'application/manifest+json'), ('/sw.js', 'text/javascript')]:
            with self.subTest(path=path):
                connection = Mock()
                connection.makefile.return_value = io.BytesIO(f'GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
                output = io.BytesIO()
                connection.sendall.side_effect = output.write
                Handler(connection, ('127.0.0.1', 0), SimpleNamespace())
                response = output.getvalue()
                self.assertIn(b'200 OK', response)
                self.assertIn(f'Content-Type: {content_type}'.encode(), response)
                self.assertIn(b'Cache-Control: no-store', response)
