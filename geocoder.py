"""Explicit address lookup through a configurable Photon provider."""
from functools import lru_cache
import json
import math
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen

GEOCODER_URL = os.environ.get('PHOTON_URL', 'https://photon.komoot.io').rstrip('/')


def normalize_results(payload):
    results, seen = [], set()
    for feature in payload.get('features', []):
        geometry = feature.get('geometry') or {}
        coords = geometry.get('coordinates')
        if geometry.get('type') != 'Point' or not isinstance(coords, list) or len(coords) != 2:
            continue
        try:
            lon, lat = map(float, coords)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(lon) or not math.isfinite(lat) or abs(lon)>180 or abs(lat)>90:
            continue
        p = feature.get('properties') or {}
        street = ' '.join(str(p[k]) for k in ('housenumber', 'street') if p.get(k))
        parts = [p.get('name'), street, p.get('city') or p.get('town') or p.get('village'),
                 p.get('state'), p.get('postcode'), p.get('country')]
        label = ', '.join(dict.fromkeys(str(v) for v in parts if v)) or f'{lat}, {lon}'
        key = (lon, lat, label)
        if key not in seen:
            seen.add(key)
            results.append({'label': label, 'coordinates': [lon,lat]})
    return results[:5]


@lru_cache(maxsize=128)
def lookup_address(query):
    """Cache successful responses in memory only; never write addresses to disk."""
    url = GEOCODER_URL+'/api/?'+urlencode({'q':query,'limit':5,'lang':'en'})
    request = Request(url, headers={'User-Agent':'MeshWarsBluePlanner/0.1','Accept':'application/json'})
    with urlopen(request, timeout=15) as response:
        return normalize_results(json.load(response))
