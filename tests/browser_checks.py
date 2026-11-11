"""Optional static UI QA: pip install playwright; uses installed Edge, not live Supabase."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:5000'
EVENT = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
SLOT = '33333333-3333-4333-8333-333333333333'
NEXT = '44444444-4444-4444-8444-444444444444'
LATER = '55555555-5555-4555-8555-555555555555'
EVENTS = [{'id': EVENT, 'name': 'JR & Co. Appointments', 'description': 'Book a 30-minute meeting with JR & Co.',
           'location': '', 'default_capacity': 1},
          {'id': OTHER, 'name': 'Another person', 'description': '', 'location': 'Office', 'default_capacity': 1}]
SLOTS = [{'id': SLOT, 'event_id': EVENT, 'starts_at': '2099-01-05T14:00:00Z', 'ends_at': '2099-01-05T14:30:00Z', 'remaining': 1},
         {'id': NEXT, 'event_id': EVENT, 'starts_at': '2099-01-05T14:30:00Z', 'ends_at': '2099-01-05T15:00:00Z', 'remaining': 1},
         {'id': LATER, 'event_id': EVENT, 'starts_at': '2099-02-05T14:00:00Z', 'ends_at': '2099-02-05T14:30:00Z', 'remaining': 1}]
PGA_SLOTS = []
for day, count in [(27, 14), (28, 14), (29, 6)]:
    for index in range(count):
        start = datetime(2099, 1, day, 14, tzinfo=timezone.utc) + timedelta(minutes=30 * index)
        PGA_SLOTS.append({'id': f'70000000-0000-4000-8000-{day * 100 + index:012d}', 'event_id': OTHER,
                          'starts_at': start.isoformat(), 'ends_at': (start + timedelta(minutes=30)).isoformat(), 'remaining': 3})


def mocked(page, mode='success'):
    calls = []
    attempts = []
    state = {'full': False}
    def respond(route):
        request = route.request
        path = request.url.split('/rest/v1/rpc/')[-1]
        body = request.post_data_json or {}
        calls.append((path, body))
        status = 200
        if '/auth/v1/token' in request.url:
            data = {'access_token': 'fake-admin-token', 'refresh_token': 'fake-refresh', 'expires_in': 3600}
        elif '/auth/v1/logout' in request.url:
            data = {}
        elif path == 'appt_public_events':
            data = [EVENTS[0], dict(EVENTS[1], name='PGA Show')] if mode == 'pga' else EVENTS
        elif path == 'appt_public_slots':
            data = [dict(slot, remaining=0 if state['full'] and slot['id'] == SLOT else slot['remaining']) for slot in SLOTS]
            if body['p_event_id'] == OTHER:
                data = PGA_SLOTS if mode == 'pga' else [dict(SLOTS[0], id=OTHER)]
            if mode == 'unordered':
                data = list(reversed(data))
            elif mode == 'next-available':
                data = [dict(slot, remaining=0 if slot['id'] in [SLOT, NEXT] else 1) for slot in data]
            elif mode == 'all-full':
                data = [dict(slot, remaining=0) for slot in data]
        elif path == 'appt_book':
            attempts.append(body)
            if mode == 'network' and len(attempts) == 1:
                route.abort('failed')
                return
            if mode == 'full':
                state['full'] = True
                status = 400
                data = {'message': 'That time is no longer available.'}
            else:
                data = {'id': '66666666-6666-4666-8666-666666666666', 'name': body['p_name'],
                        'event_name': EVENTS[0]['name'], 'starts_at': SLOTS[0]['starts_at'],
                        'ends_at': SLOTS[0]['ends_at'], 'location': ''}
        elif path == 'appt_admin_dashboard':
            if mode == 'denied':
                status, data = 403, {'message': 'An authorized admin account is required.'}
            else:
                data = {'events': EVENTS, 'slots': [dict(slot, capacity=1, reserved=0) for slot in SLOTS],
                        'bookings': [{'id': SLOT, 'name': '=1+1', 'email': 'guest@example.com', 'phone': '',
                                      'notes': '<img src=x onerror=alert(1)>', 'event_name': EVENTS[0]['name'],
                                      'starts_at': SLOTS[0]['starts_at'], 'email_status': 'queued', 'calendar_status': 'queued'}],
                        'booking_count': 1}
        elif path == 'appt_admin_bookings':
            data = [{'name': '=1+1', 'email': 'guest@example.com', 'event_name': EVENTS[0]['name'],
                     'starts_at': SLOTS[0]['starts_at']}]
        elif path == 'appt_admin_create_event':
            data = OTHER
        elif path == 'appt_admin_add_workdays':
            data = 14
        elif path == 'appt_admin_add_slot':
            data = NEXT
        elif path == 'appt_admin_generate_slots':
            data = {'added': 28, 'removed': 2, 'preserved': 0, 'conflicts': 0}
        else:
            raise AssertionError(f'Unexpected request: {request.url}')
        route.fulfill(status=status, json=data, headers={'Access-Control-Allow-Origin': '*'})
    page.route('**/config.json', lambda route: route.fulfill(json={
        'url': 'https://supabase.test', 'publishableKey': 'sb_publishable_test', 'preview': False}))
    page.route('https://supabase.test/**', respond)
    return calls, attempts


def select_time(page):
    if not page.locator('.calendar-panel').is_visible():
        page.locator('[data-step="date"]').click()
    page.locator('.has-availability').first.click()
    page.locator('[data-slot]').first.click()
    assert page.locator('#booking-form').is_visible()


def fill_guest(page):
    page.locator('[name="name"]').fill('Preview Guest')
    page.locator('[name="phone"]').fill('555-0100')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    for width, height in [(1366, 768), (390, 844), (375, 667), (320, 568)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        calls, attempts = mocked(page)
        page.goto(URL)
        page.locator('.has-availability').first.wait_for(state='attached')
        assert page.locator('#day-times').is_visible()
        assert page.locator('.calendar-day.selected').get_attribute('data-date') == '2099-01-05'
        assert not page.locator('#booking-form').is_visible()
        page.locator('[data-step="date"]').click()
        calendar = page.locator('.calendar-panel').bounding_box()
        assert calendar['y'] + calendar['height'] <= height, (width, 'calendar', calendar)
        month = page.locator('#month-label').inner_text()
        page.locator('#next-month').click()
        assert page.locator('#month-label').inner_text() != month
        page.locator('#previous-month').click()
        select_time(page)
        assert '9:00 AM' in page.locator('#selection').inner_text()  # Eastern, even in Tokyo.
        button = page.locator('#book-button').bounding_box()
        assert button['y'] + button['height'] <= height, (width, 'confirm', button)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        fill_guest(page)
        page.locator('#book-button').click()
        page.locator('#confirmation').wait_for(state='visible')
        assert 'appointment is saved' in page.locator('#confirmation-email').inner_text()
        assert len(attempts) == 1
        assert not errors, errors
        print(f'PASS {width}x{height}: calendar, month navigation, Eastern time, above-fold controls, successful booking')
        page.close()

    for mode in ['full', 'network']:
        page = browser.new_page()
        calls, attempts = mocked(page, mode)
        page.goto(URL)
        page.locator('.has-availability').first.wait_for(state='attached')
        select_time(page)
        fill_guest(page)
        page.locator('#book-button').click()
        page.locator('#message').wait_for(state='visible')
        if mode == 'full':
            assert not page.locator('#booking-form').is_visible()
            assert 'just booked' in page.locator('#message').inner_text()
            page.locator('.has-availability').first.click()
            assert not page.locator(f'[data-slot="{SLOT}"]').count()
        else:
            page.locator('#book-button').click()
            page.locator('#confirmation').wait_for(state='visible')
            assert len(attempts) == 2
            assert attempts[0]['p_request_id'] == attempts[1]['p_request_id']
        print(f'PASS {mode}: safe capacity/network failure recovery')
        page.close()

    page = browser.new_page()
    calls, attempts = mocked(page)
    page.goto(URL)
    page.locator('.has-availability').first.wait_for(state='attached')
    page.locator('#event-choice').select_option(OTHER)
    page.wait_for_function("document.getElementById('event-name').textContent === 'Another person'")
    page.locator('.has-availability').first.click()
    page.locator(f'[data-slot="{OTHER}"]').wait_for()
    select_time(page)
    page.locator('[data-step="date"]').click()
    page.locator('.has-availability').first.click()
    assert not page.locator('#booking-form').is_visible()
    print('PASS event switching and date changes reset the selected time')
    page.close()

    for mode, expected_date in [('unordered', '2099-01-05'), ('next-available', '2099-02-05')]:
        page = browser.new_page()
        mocked(page, mode)
        page.goto(URL)
        page.locator('#day-times').wait_for(state='visible')
        assert page.locator('.calendar-day.selected').get_attribute('data-date') == expected_date
        assert not page.locator('#booking-form').is_visible()
        assert page.locator('[data-slot].selected').count() == 0
        assert not page.evaluate("document.activeElement.matches('[data-slot]')")
        print(f'PASS {mode}: earliest date with capacity selected automatically, no meeting preselected or focus stolen')
        page.close()
    page = browser.new_page()
    mocked(page, 'all-full')
    page.goto(URL)
    page.wait_for_function("document.getElementById('availability-status').textContent.includes('No upcoming times')")
    assert page.locator('.calendar-day.selected').count() == 0
    assert not page.locator('#day-times').is_visible()
    assert not page.locator('#booking-form').is_visible()
    print('PASS fully booked schedules do not preselect an unavailable date')
    page.close()

    for width, height in [(1366, 768), (1280, 600), (1024, 600), (768, 600), (390, 844), (375, 667), (320, 568)]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        calls, attempts = mocked(page, 'pga')
        page.goto(f'{URL}/?event={OTHER}')
        page.locator('.has-availability').first.wait_for(state='attached')
        assert page.locator('#day-times').is_visible()
        assert page.locator('.calendar-day.selected').get_attribute('data-date') == '2099-01-27'
        assert page.locator('[data-slot]').count() == 14
        assert not page.locator('#booking-form').is_visible()
        assert not page.locator('#event-picker').is_visible()
        assert page.locator('#event-choice').is_disabled()
        assert page.locator('#event-choice option').count() == 1
        assert page.locator('#event-name').inner_text() == 'PGA Show'
        assert page.locator('.has-availability').count() == 3
        assert page.locator('#month-label').inner_text() == 'January 2099'
        assert page.locator('#next-month').is_disabled()
        for link in page.locator('[data-booking-home]').all():
            assert link.get_attribute('href') == f'/?event={OTHER}'
        page.locator('[data-step="date"]').click()
        calendar = page.locator('.calendar-panel').bounding_box()
        assert calendar['y'] + calendar['height'] < height - 10, (width, 'calendar', calendar)
        page.locator('.has-availability').first.click()
        assert page.locator('[data-slot]').count() == 14
        times = page.locator('#day-times').bounding_box()
        assert times['y'] + times['height'] < height - 10, (width, 'times', times)
        assert page.locator('#day-times').evaluate('(node) => node.scrollHeight <= node.clientHeight + 1')
        page.locator('[data-slot]').first.click()
        button = page.locator('#book-button').bounding_box()
        assert button['y'] + button['height'] < height - 10, (width, 'details', button)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        fill_guest(page)
        page.locator('#book-button').click()
        page.locator('#confirmation').wait_for(state='visible')
        assert page.locator('#event-choice').is_disabled()
        page.locator('#another-booking').click()
        page.locator('.has-availability').first.wait_for(state='attached')
        assert not page.locator('#event-picker').is_visible()
        assert all(body['p_event_id'] == OTHER for path, body in calls if path == 'appt_public_slots')
        page.locator('[data-booking-home]').first.click()
        page.locator('.has-availability').first.wait_for(state='attached')
        assert page.locator('#event-name').inner_text() == 'PGA Show'
        assert not page.locator('#event-picker').is_visible()
        print(f'PASS {width}x{height}: scoped PGA link, all 14 times and confirmation above fold, no default-calendar navigation')
        page.close()

    for event_id in ['missing-event', '']:
        page = browser.new_page()
        calls, attempts = mocked(page)
        page.goto(f'{URL}/?event={event_id}')
        page.wait_for_function("document.getElementById('availability-status').textContent.includes('event link is unavailable')")
        assert not page.locator('#event-picker').is_visible()
        assert not any(path == 'appt_public_slots' for path, body in calls)
        print('PASS invalid event links do not fall back to the default calendar')
        page.close()

    for suffix, initial in [('showEvents=true', EVENT), (f'event={OTHER}&showEvents=true', OTHER)]:
        page = browser.new_page()
        calls, attempts = mocked(page)
        page.goto(f'{URL}/?{suffix}')
        page.locator('#day-times').wait_for(state='visible')
        assert page.locator('#event-picker').is_visible()
        assert page.locator('#event-choice').is_enabled()
        assert page.locator('#event-choice option').count() == 2
        assert page.locator('#event-choice').input_value() == initial
        target = OTHER if initial == EVENT else EVENT
        page.locator('#event-choice').select_option(target)
        page.wait_for_function('(id) => document.querySelector("#event-choice").value === id && document.querySelector("#booking-workspace").getAttribute("aria-busy") === "false"', arg=target)
        assert 'showEvents=true' in page.url
        for link in page.locator('[data-booking-home]').all():
            assert link.get_attribute('href') == f'/?event={target}&showEvents=true'
        page.reload()
        page.locator('#day-times').wait_for(state='visible')
        assert page.locator('#event-choice').is_enabled()
        assert page.locator('#event-choice').input_value() == target
        page.locator('[data-slot]').first.click()
        fill_guest(page)
        page.locator('#book-button').click()
        page.locator('#confirmation').wait_for(state='visible')
        assert page.locator('#event-choice').is_enabled()
        page.locator('#another-booking').click()
        page.locator('#day-times').wait_for(state='visible')
        assert page.locator('#event-picker').is_visible()
        page.locator('[data-booking-home]').first.click()
        page.locator('#day-times').wait_for(state='visible')
        assert page.locator('#event-choice').is_enabled()
        assert page.locator('#event-choice').input_value() == target
        print('PASS showEvents=true: dropdown available, chosen event retained across selection, refresh, booking, and home links')
        page.close()
    for flag in ['false', '1']:
        page = browser.new_page()
        mocked(page)
        page.goto(f'{URL}/?event={OTHER}&showEvents={flag}')
        page.locator('#day-times').wait_for(state='visible')
        assert not page.locator('#event-picker').is_visible()
        assert page.locator('#event-choice').is_disabled()
        print('PASS only explicit showEvents=true unlocks an event link')
        page.close()

    page = browser.new_page()
    calls, attempts = mocked(page)
    page.goto(f'{URL}/admin.html')
    page.locator('[name="email"]').fill('admin@example.com')
    page.locator('[name="password"]').fill('test-only')
    page.locator('#sign-in').click()
    page.locator('#admin-workspace').wait_for(state='visible')
    assert page.locator('#bookings-table img').count() == 0
    assert '<img' in page.locator('#bookings-table').inner_text()
    page.locator('#event-form [name="name"]').fill('New event')
    page.locator('#event-form button').click()
    page.wait_for_function("document.getElementById('message').textContent.includes('created')")
    creation = next(body for path, body in calls if path == 'appt_admin_create_event')
    assert creation['p_workdays'] and creation['p_capacity'] == 1
    page.locator('#range-form [name="event_id"]').select_option(EVENT)
    page.locator('#range-form [name="first_date"]').fill('2027-01-27')
    page.locator('#range-form [name="last_date"]').fill('2027-01-28')
    page.locator('#range-form [name="last_start"]').fill('15:30')
    assert '14 meetings per selected day' in page.locator('#range-summary').inner_text()
    assert '4:00 PM' in page.locator('#range-summary').inner_text()
    page.locator('#range-form [name="replace"]').check()
    page.locator('#range-form button').click()
    page.wait_for_function("document.getElementById('message').textContent.includes('Created 28')")
    generated = next(body for path, body in calls if path == 'appt_admin_generate_slots')
    assert generated['p_last_start'] == '15:30' and generated['p_replace'] is True
    assert generated['p_capacity'] is None
    assert not page.locator('#range-form [name="replace"]').is_checked()
    page.locator('#admin-availability details').first.locator('summary').click()
    assert '9:30 AM' in page.locator('#admin-availability').inner_text()
    with page.expect_download() as download:
        page.locator('#export').click()
    csv = Path(download.value.path()).read_text(encoding='utf-8-sig')
    assert "'=1+1" in csv
    page.locator('#sign-out').click()
    page.locator('#login-panel').wait_for(state='visible')
    assert page.evaluate("sessionStorage.getItem('jrco-admin-session')") is None
    print('PASS admin Auth, creation defaults, safe text rendering, CSV formula escaping, and sign-out')
    page.close()

    page = browser.new_page()
    mocked(page, 'denied')
    page.goto(f'{URL}/admin.html')
    page.locator('[name="email"]').fill('ordinary@example.com')
    page.locator('[name="password"]').fill('test-only')
    page.locator('#sign-in').click()
    page.wait_for_function("document.getElementById('message').textContent.includes('authorized admin')")
    assert not page.locator('#admin-workspace').is_visible()
    assert page.evaluate("sessionStorage.getItem('jrco-admin-session')") is None
    print('PASS non-admin sign-in cannot open the admin workspace')
    page.close()

    page = browser.new_page()
    page.goto(URL)
    page.locator('.has-availability').first.wait_for(state='attached')
    select_time(page)
    assert page.locator('#book-button').is_disabled()
    assert page.locator('#preview-label').is_visible()
    print('PASS real local preview is explicitly read-only; no pretend booking is accepted')
    browser.close()
