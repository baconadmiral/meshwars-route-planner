"""Public build identity, injected into production images by CI."""
import os
import re
import json
import subprocess
from pathlib import Path


def build_version():
    try:
        raw = json.loads(os.environ.get('APP_CHANGES', '[]'))
        changes = [' '.join(item.split())[:200] for item in raw if isinstance(item, str) and item.strip()][:5] if isinstance(raw, list) else []
    except (ValueError, TypeError):
        changes = []
    revision = os.environ.get('APP_REVISION', '')
    if re.fullmatch(r'[0-9a-fA-F]{40}', revision):
        revision = revision.lower()
        return {'version': revision[:12], 'revision': revision, 'changes': changes}
    return {'version': 'development', 'revision': None, 'changes': changes}


def recent_changes():
    """Use PR titles for GitHub merge commits and subjects for squash/direct commits."""
    history = subprocess.check_output(
        ['git', 'log', '--first-parent', '-20', '--format=%s%n%b%x00'],
        cwd=Path(__file__).resolve().parent, text=True)
    changes = []
    for entry in history.split('\0'):
        lines = [line.strip() for line in entry.splitlines() if line.strip()]
        if not lines:
            continue
        title = lines[1] if lines[0].startswith('Merge pull request #') and len(lines)>1 else lines[0]
        if title[:200] not in changes:
            changes.append(title[:200])
        if len(changes)==5:
            break
    return changes[:5]


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Write recent merged changes for a production build.')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(recent_changes()))
