"""Explicit public PWA assets shared by the development and production servers."""
from pathlib import Path

from app_version import build_version


PWA_ASSETS = {
    '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'),
    '/pwa.js': ('pwa.js', 'text/javascript'),
    '/sw.js': ('sw.js', 'text/javascript'),
    '/offline.html': ('offline.html', 'text/html'),
    '/icons/icon.svg': ('icons/icon.svg', 'image/svg+xml'),
    '/icons/icon-192.png': ('icons/icon-192.png', 'image/png'),
    '/icons/icon-512.png': ('icons/icon-512.png', 'image/png'),
    '/icons/apple-touch-icon.png': ('icons/apple-touch-icon.png', 'image/png'),
}


def service_worker():
    source = (Path(__file__).resolve().parent/'static'/'sw.js').read_text()
    revision = build_version()['revision'] or 'development'
    return source.replace('__BUILD_REVISION__', revision)
