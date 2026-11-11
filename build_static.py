"""Build the Render static site using only Python's standard library."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent


def configuration(preview=False):
    source = ROOT / 'supabase-public.json'
    settings = json.loads(source.read_text(encoding='utf-8')) if source.exists() else {}
    url = os.getenv('SUPABASE_URL', settings.get('url', '')).strip().rstrip('/')
    key = os.getenv('SUPABASE_PUBLISHABLE_KEY', settings.get('publishableKey', '')).strip()
    if key.startswith('sb_secret_'):
        raise ValueError('Use a publishable key, never a Supabase secret key.')
    if key.startswith('eyJ'):
        import base64
        try:
            payload = json.loads(base64.urlsafe_b64decode(key.split('.')[1] + '==='))
        except (ValueError, IndexError) as error:
            raise ValueError('Invalid legacy Supabase key.') from error
        if payload.get('role') != 'anon':
            raise ValueError('Only a legacy anon key may be published.')
    elif key and not key.startswith('sb_publishable_'):
        raise ValueError('Expected a Supabase publishable or legacy anon key.')
    if url and (urlparse(url).scheme != 'https' or not urlparse(url).netloc):
        raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
    if bool(url) != bool(key):
        raise ValueError('Configure both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.')
    if os.getenv('RENDER') and not (url and key):
        raise ValueError('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Render before building.')
    if preview and os.getenv('RENDER'):
        raise ValueError('Read-only preview data cannot be deployed on Render.')
    return {'url': url, 'publishableKey': key, 'preview': preview}


def preview_schedule():
    """Export only public availability from the old local database, never guests."""
    source = ROOT / 'instance' / 'appointments.db'
    if not source.exists():
        return {'events': [], 'slots': []}
    with sqlite3.connect(f'{source.as_uri()}?mode=ro', uri=True) as connection:
        connection.row_factory = sqlite3.Row
        events = [dict(row) for row in connection.execute(
            'SELECT id, name, description, location, default_capacity FROM event ORDER BY name')]
        slots = [dict(row) for row in connection.execute(
            'SELECT id, event_id, starts_at, ends_at, capacity - reserved AS remaining FROM slot ORDER BY starts_at')]
    # Legacy timestamps are explicitly Eastern local time, not browser-local time.
    for slot in slots:
        slot['local_start'] = slot.pop('starts_at').replace(' ', 'T')[:19]
        slot['local_end'] = slot.pop('ends_at').replace(' ', 'T')[:19]
    return {'events': events, 'slots': slots}


def build(preview=False, output=None):
    settings = configuration(preview)
    target = Path(output) if output else ROOT / 'dist'
    target.mkdir(parents=True, exist_ok=True)
    for filename in ['index.html', 'admin.html', 'api.js', 'booking.js', 'admin.js']:
        shutil.copyfile(ROOT / 'web' / filename, target / filename)
    shutil.copyfile(ROOT / 'static' / 'style.css', target / 'style.css')
    shutil.copyfile(ROOT / 'static' / 'booking-compact.css', target / 'booking-compact.css')
    shutil.copyfile(ROOT / 'static' / 'favicon.svg', target / 'favicon.svg')
    shutil.copytree(ROOT / 'static' / 'brand', target / 'brand', dirs_exist_ok=True)
    (target / 'config.json').write_text(json.dumps(settings), encoding='utf-8')
    if preview:
        (target / 'preview-data.json').write_text(json.dumps(preview_schedule()), encoding='utf-8')
    else:
        (target / 'preview-data.json').unlink(missing_ok=True)
    (target / 'robots.txt').write_text('User-agent: *\nDisallow: /admin\n', encoding='utf-8')
    print(f'Static site built: {target} ({"read-only local preview" if preview else "Supabase mode"})')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', action='store_true', help='Read-only local preview using public legacy availability.')
    args = parser.parse_args()
    build(args.preview)
