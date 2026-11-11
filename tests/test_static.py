import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build_static import ROOT, build, configuration, preview_schedule


class StaticBuildTests(unittest.TestCase):
    def env(self, **values):
        return patch.dict(os.environ, {'SUPABASE_URL': '', 'SUPABASE_PUBLISHABLE_KEY': '', 'RENDER': '', **values})

    def test_production_build_contains_no_preview_data(self):
        with tempfile.TemporaryDirectory() as directory, self.env():
            target = Path(directory)
            (target / 'preview-data.json').write_text('{"stale":true}')
            build(output=target)
            self.assertFalse((target / 'preview-data.json').exists())
            self.assertFalse(json.loads((target / 'config.json').read_text())['preview'])
            self.assertIn('booking.js', (target / 'index.html').read_text(encoding='utf-8'))
            self.assertTrue((target / 'admin.html').exists())
            self.assertFalse((target / '.env').exists())
            self.assertFalse((target / 'app.py').exists())
            self.assertNotIn('{{', (target / 'index.html').read_text(encoding='utf-8'))

    def test_private_keys_cannot_be_published(self):
        encoded = base64.urlsafe_b64encode(json.dumps({'role': 'service_role'}).encode()).decode().rstrip('=')
        for key in ['sb_secret_never_publish', f'eyJheader.{encoded}.signature']:
            with self.env(SUPABASE_URL='https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY=key):
                with self.assertRaises(ValueError):
                    configuration()

    def test_render_requires_config_and_disallows_preview(self):
        with self.env(RENDER='true'):
            with self.assertRaises(ValueError):
                configuration()
        with self.env(RENDER='true', SUPABASE_URL='https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY='sb_publishable_test'):
            with self.assertRaises(ValueError):
                configuration(preview=True)

    def test_preview_exports_only_public_availability(self):
        data = preview_schedule()
        self.assertEqual(set(data), {'events', 'slots'})
        for slot in data['slots']:
            self.assertNotIn('name', slot)
            self.assertNotIn('email', slot)
            self.assertNotIn('phone', slot)
            self.assertNotIn('notes', slot)

    def test_render_is_static(self):
        config = (ROOT / 'render.yaml').read_text()
        self.assertIn('runtime: static', config)
        self.assertIn('staticPublishPath: dist', config)
        for text in ['gunicorn', 'startCommand', 'preDeployCommand', 'DATABASE_URL', 'ADMIN_PASSWORD']:
            self.assertNotIn(text, config)


if __name__ == '__main__':
    unittest.main()
