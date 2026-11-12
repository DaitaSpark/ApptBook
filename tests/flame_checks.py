"""Flame motion regression: local preview server, mocked Supabase, Edge or --webkit."""
import os
import sys
from playwright.sync_api import sync_playwright

URL = os.environ.get('APPTBOOK_TEST_URL', 'http://127.0.0.1:5000')
DEFAULT = '11111111-1111-4111-8111-111111111111'
PGA = '22222222-2222-4222-8222-222222222222'
EVENTS = [{'id': DEFAULT, 'name': 'JR & Co. Appointments', 'description': '', 'location': ''},
          {'id': PGA, 'name': 'PGA Show', 'description': '', 'location': ''}]
SLOTS = [dict(id=str(index), starts_at=f'2099-01-27T{14+index:02d}:00:00Z',
              ends_at=f'2099-01-27T{14+index:02d}:30:00Z', remaining=count, is_open=opened)
         for index, (count, opened) in enumerate([(1, True), (2, True), (1, False), (0, False)])]

def mock(page):
    page.route('**/config.json', lambda route: route.fulfill(json={
        'url': 'https://supabase.test', 'publishableKey': 'sb_publishable_test', 'preview': False}))
    def rpc(route):
        name = route.request.url.rsplit('/', 1)[-1]
        assert name in ('appt_public_events', 'appt_public_slots'), name
        route.fulfill(json=EVENTS if name == 'appt_public_events' else SLOTS,
                      headers={'Access-Control-Allow-Origin': '*'})
    page.route('https://supabase.test/**', rpc)

def open_times(page, width, event=PGA):
    page.goto(f'{URL}/?event={event}')
    page.locator('.has-availability').first.wait_for()
    if width <= 720:
        page.locator('#view-selected-times').click()

def animated_frame(page):
    first = page.locator('.slot-panel').screenshot()
    page.wait_for_timeout(400)
    assert first != page.locator('.slot-panel').screenshot(), 'Flame should visibly animate'

with sync_playwright() as p:
    webkit = '--webkit' in sys.argv
    browser = p.webkit.launch(headless=True) if webkit else p.chromium.launch(channel='msedge', headless=True)
    engine = 'WebKit' if webkit else 'Edge'
    for width, height in [(1366, 768), (390, 844), (320, 568)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce',
                                is_mobile=width < 720, has_touch=width < 720)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        mock(page)
        open_times(page, width)
        page.locator('.last-place-fire svg').wait_for()
        assert page.locator('.last-place-fire').count() == 1
        assert page.locator('#flame-motion-toggle').inner_text() == 'Animation: On'
        assert page.locator('.flame-motion').evaluate('(e) => getComputedStyle(e).display') == 'inline'
        assert not page.locator('.last-place-fire svg').evaluate('(e) => e.animationsPaused()')
        assert page.locator('.last-place-label').evaluate('(e) => getComputedStyle(e).color') == 'rgb(180, 35, 24)'
        animated_frame(page)
        page.locator('#flame-motion-toggle').click()
        assert page.locator('.last-place-fire svg').evaluate('(e) => e.animationsPaused()')
        assert page.locator('.flame-motion').evaluate('(e) => getComputedStyle(e).display') == 'none'
        still = page.locator('.slot-panel').screenshot()
        page.wait_for_timeout(400)
        assert still == page.locator('.slot-panel').screenshot(), 'Off must stop visible motion'
        open_times(page, width)
        page.locator('.last-place-fire svg').wait_for()
        assert page.locator('#flame-motion-toggle').inner_text() == 'Animation: Off'
        assert page.locator('.last-place-fire svg').evaluate('(e) => e.animationsPaused()')
        page.locator('#flame-motion-toggle').click()
        animated_frame(page)
        page.evaluate("document.querySelector('.last-place-fire svg').pauseAnimations(); window.dispatchEvent(new Event('pageshow'))")
        assert not page.locator('.last-place-fire svg').evaluate('(e) => e.animationsPaused()')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        open_times(page, width, DEFAULT)
        assert page.locator('.last-place-fire').count() == 0
        assert not page.locator('#flame-motion-toggle').is_visible()
        assert not errors, errors
        page.close()
        print(f'PASS {engine} {width}x{height}: reduced-motion system still animates by default; app Off persists; On resumes; default excluded')
    page = browser.new_page(reduced_motion='reduce')
    mock(page)
    page.add_init_script("Object.defineProperty(window, 'localStorage', {get() { throw new Error('Storage blocked'); }});")
    open_times(page, 1366)
    page.locator('.last-place-fire svg').wait_for()
    assert not page.locator('.last-place-fire svg').evaluate('(e) => e.animationsPaused()')
    page.close()
    page = browser.new_page()
    mock(page)
    page.route('**/flame.svg*', lambda route: route.abort())
    open_times(page, 1366)
    assert page.locator('.flame-fallback').is_visible()
    page.locator('[data-slot]').first.click()
    assert page.locator('#booking-form').is_visible()
    page.close()
    browser.close()
    print(f'PASS {engine}: storage restrictions and missing artwork do not break booking')
