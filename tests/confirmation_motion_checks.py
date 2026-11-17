"""Local browser checks for repeating confirmation confetti; no live booking calls."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

EVENT = '11111111-1111-4111-8111-111111111111'
SLOT = '22222222-2222-4222-8222-222222222222'
slot = dict(id=SLOT, starts_at='2099-01-05T14:00:00Z', ends_at='2099-01-05T14:30:00Z',
            remaining=3, display_remaining=5, is_open=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory='dist'))
Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        for width, reduced, disabled in [(1000, False, False), (375, False, False),
                                         (375, True, False), (1000, False, True)]:
            page = browser.new_page(viewport={'width': width, 'height': 900},
                                    reduced_motion='reduce' if reduced else 'no-preference')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.clock.install()
            if disabled:
                page.add_init_script("localStorage.setItem('apptbook.animations.v1','off')")
            page.route('**/config.json', lambda route: route.fulfill(json=dict(
                url='https://supabase.test', publishableKey='sb_publishable_test', preview=False)))

            def mock(route):
                name = route.request.url.rsplit('/', 1)[-1]
                if name == 'appt_public_events':
                    data = [dict(id=EVENT, name='PGA Show', description='', location='', default_capacity=3)]
                elif name == 'appt_public_slots':
                    data = [slot]
                elif name == 'appt_book_tracked':
                    data = dict(id='mock-receipt', name='Guest', event_name='PGA Show',
                                starts_at=slot['starts_at'], location='')
                else:
                    raise AssertionError(name)
                route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

            page.route('https://supabase.test/**', mock)
            page.goto(f'http://127.0.0.1:{server.server_port}/?event={EVENT}')
            if width < 720:
                page.locator('#view-selected-times').click()
            page.locator('[data-slot]').first.click()
            page.locator('[name=name]').fill('Guest')
            page.locator('[name=email]').fill('guest@example.com')
            page.locator('#book-button').click()
            page.locator('#confirmation').wait_for(state='visible')
            layer = page.locator('.confirmation-confetti')
            if reduced or disabled:
                assert layer.count() == 0
            else:
                assert layer.locator('span').count() == (44 if width < 500 else 64)
                assert layer.get_attribute('aria-hidden') == 'true'
                assert layer.evaluate("node => getComputedStyle(node).pointerEvents") == 'none'
                assert layer.evaluate("node => node.getAnimations({subtree:true}).every(a=>a.effect.getTiming().iterations===Infinity)")
                assert layer.locator('span').evaluate_all("nodes=>nodes.some(n=>parseFloat(n.style.left)>30 && parseFloat(n.style.left)<70)")
                page.clock.run_for(10000)
                assert layer.count() == 1
                page.locator('#flame-motion-toggle').click()
                assert layer.count() == 0
                page.locator('#flame-motion-toggle').click()
                assert layer.count() == 1
            assert page.locator('#confirmation-time').is_visible()
            assert page.locator('#another-booking').is_enabled()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#another-booking').click()
            assert layer.count() == 0
            assert not errors, errors
            page.close()
        browser.close()
    print('PASS desktop/mobile repeating full-card confetti, noninteractive pieces, cleanup, reduced motion and saved animation-off preference')
finally:
    server.shutdown()
