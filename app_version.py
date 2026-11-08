"""Public build identity, injected into production images by CI."""
import os
import re


def build_version():
    revision = os.environ.get('APP_REVISION', '')
    if re.fullmatch(r'[0-9a-fA-F]{40}', revision):
        revision = revision.lower()
        return {'version': revision[:12], 'revision': revision}
    return {'version': 'development', 'revision': None}
