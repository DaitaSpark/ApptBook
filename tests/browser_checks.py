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
    state = {'full': False, 'refs': [], 'limit': None, 'booking_deleted': False}
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
            data = [EVENTS[0], dict(EVENTS[1], name='PGA Show', open_times_per_day=3 if mode == 'staged' else None)] if mode in ['pga', 'staged'] else EVENTS
            if mode == 'single-event':
                data = [EVENTS[0]]
        elif path == 'appt_public_slots':
            data = [dict(slot, remaining=0 if state['full'] and slot['id'] == SLOT else slot['remaining']) for slot in SLOTS]
            if body['p_event_id'] == OTHER:
                data = PGA_SLOTS if mode in ['pga', 'staged'] else [dict(SLOTS[0], id=OTHER)]
                if mode == 'staged':
                    data = [dict(slot, is_open=(index in [1, 5, 10])) for index, slot in enumerate(PGA_SLOTS)]
            if mode == 'unordered':
                data = list(reversed(data))
            elif mode == 'next-available':
                data = [dict(slot, remaining=0 if slot['id'] in [SLOT, NEXT] else 1) for slot in data]
            elif mode == 'all-full':
                data = [dict(slot, remaining=0) for slot in data]
        elif path in ['appt_book', 'appt_book_tracked', 'appt_book_company']:
            attempts.append(body)
            if mode == 'network' and len(attempts) == 1:
                route.abort('failed')
                return
            if mode == 'legacy-db' and path == 'appt_book_tracked':
                status = 404
                data = {'code': 'PGRST202', 'message': 'Booking function not installed yet.'}
            elif mode == 'full':
                state['full'] = True
                status = 400
                data = {'message': 'That time is no longer available.'}
            else:
                data = {'id': '66666666-6666-4666-8666-666666666666', 'name': body['p_name'],
                        'event_name': EVENTS[0]['name'], 'starts_at': SLOTS[0]['starts_at'],
                        'ends_at': SLOTS[0]['ends_at'], 'location': ''}
        elif path == 'appt_ref_valid':
            data = mode != 'invalid-ref' and body['p_token'] == 'a' * 32
        elif path == 'appt_admin_dashboard':
            if mode == 'denied':
                status, data = 403, {'message': 'An authorized admin account is required.'}
            else:
                data = {'events': [dict(event, open_times_per_day=state['limit']) for event in EVENTS], 'slots': [dict(slot, capacity=1, reserved=0) for slot in SLOTS],
                        'bookings': [{'id': SLOT, 'name': '=1+1', 'email': 'guest@example.com', 'phone': '',
                                      'notes': '<img src=x onerror=alert(1)>', 'event_name': EVENTS[0]['name'],
                                      'starts_at': SLOTS[0]['starts_at'], 'source_label': 'Jeff', 'source_kind': 'salesperson',
                                      'email_status': 'queued', 'calendar_status': 'queued'}],
                        'booking_count': 1, 'referral_links': state['refs']}
                if state['booking_deleted']:
                    data['bookings'] = []
                    data['booking_count'] = 0
        elif path == 'appt_admin_calendar_audit':
            data = {'last_checked': '2026-11-12T15:00:00Z', 'cancellation_sync': {'last_polled': '2026-11-12T15:01:00Z', 'last_error': None}, 'pending': 0, 'issues': [
                {'id': SLOT, 'name': '<img src=x onerror=alert(1)>', 'event_name': 'PGA Show',
                 'starts_at': SLOTS[0]['starts_at'], 'checked_at': '2026-11-12T15:00:00Z',
                 'outcome': 'changed', 'differences': ['Start differs: app 9 AM; Google 10 AM.']},
                {'id': NEXT, 'name': 'Cancelled guest', 'event_name': 'PGA Show',
                 'starts_at': SLOTS[0]['starts_at'], 'checked_at': '2026-11-12T15:00:00Z',
                 'outcome': 'cancelled', 'differences': ['Cancelled in Google Calendar.']}]}
        elif path == 'appt_admin_bookings':
            data = [{'name': '=1+1', 'email': 'guest@example.com', 'event_name': EVENTS[0]['name'], 'source_label': 'Jeff', 'source_kind': 'salesperson',
                     'starts_at': SLOTS[0]['starts_at']}]
        elif path == 'appt_admin_create_event':
            data = OTHER
        elif path == 'appt_admin_add_workdays':
            data = 14
        elif path == 'appt_admin_add_slot':
            data = NEXT
        elif path == 'appt_admin_generate_slots':
            data = {'added': 28, 'removed': 2, 'preserved': 0, 'conflicts': 0}
        elif path == 'appt_admin_set_release':
            state['limit'] = body['p_limit']
            data = None
        elif path == 'appt_admin_create_referral':
            data = {'id': 'ref1', 'event_id': body['p_event_id'], 'label': body['p_label'], 'kind': body['p_kind'],
                    'token': 'a' * 32, 'active': True, 'booking_count': 1}
            state['refs'].append(data)
        elif path == 'appt_admin_set_referral':
            state['refs'][0]['active'] = body['p_active']
            data = None
        elif path == 'appt_admin_delete_referral':
            state['refs'] = [link for link in state['refs'] if link['id'] != body['p_id']]
            data = None
        elif path == 'appt_admin_delete_booking':
            state['booking_deleted'] = True
            data = None
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
        if width <= 720:
            assert not page.locator('#day-times').is_visible()
            assert page.locator('#view-selected-times').is_visible()
            page.locator('#view-selected-times').click()
            assert page.locator('#day-times').is_visible()
            assert not page.locator('.calendar-panel').is_visible()
            page.locator('#change-date').click()
        else:
            assert page.locator('#day-times').is_visible()
        assert page.locator('.calendar-panel').is_visible()
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
        page.locator('[name=company]').fill('Pine Valley Golf Club')
        page.locator('#book-button').click()
        page.locator('#confirmation').wait_for(state='visible')
        assert 'appointment is saved' in page.locator('#confirmation-email').inner_text()
        assert attempts[0]['p_company'] == 'Pine Valley Golf Club'
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
            assert 'no longer available' in page.locator('#message').inner_text()
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
        assert page.locator('#day-times').is_visible() == (width > 720)
        assert page.locator('.calendar-day.selected').get_attribute('data-date') == '2099-01-27'
        assert page.locator('[data-slot]').count() == 14
        assert not page.locator('#booking-form').is_visible()
        assert not page.locator('#event-picker').is_visible()
        assert page.locator('#event-choice').is_disabled()
        assert page.locator('#event-choice option').count() == 1
        assert page.locator('#event-name').inner_text() == 'PGA Show'
        assert page.locator('#event-name').evaluate('(node) => node.tagName') == 'H1'
        title_size = page.locator('#event-name').evaluate('(node) => parseFloat(getComputedStyle(node).fontSize)')
        kicker_size = page.locator('.booking-kicker').evaluate('(node) => parseFloat(getComputedStyle(node).fontSize)')
        assert title_size >= kicker_size * 2.5
        assert page.locator('.calendar-panel').is_visible()
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
        if width > 720:
            assert times['y'] + times['height'] < height - 10, (width, 'times', times)
        else:
            assert not page.locator('.calendar-panel').is_visible()
            assert page.locator('#change-date').is_visible()
            page.locator('#change-date').click()
            assert page.locator('.calendar-panel').is_visible()
            page.locator('.calendar-day[data-date="2099-01-29"]').click()
            assert not page.locator('.calendar-panel').is_visible()
            assert page.locator('#day-times').is_visible()
            assert 'January 29' in page.locator('#chosen-date').inner_text()
            assert page.locator('[data-slot]').count() == 6
            assert page.locator('.calendar-day.selected').get_attribute('data-date') == '2099-01-29'
            page.locator('#change-date').click()
            page.locator('.calendar-day[data-date="2099-01-27"]').click()
            assert page.locator('[data-slot]').count() == 14
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
        print(f'PASS {width}x{height}: prominent event heading, mobile date-to-times transition, change-date navigation, scoped links')
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

    for width in [1366, 390]:
        page = browser.new_page(viewport={'width': width, 'height': 844})
        mocked(page, 'single-event')
        page.goto(f'{URL}/?showEvents=true')
        page.locator('#event-picker').wait_for(state='visible')
        assert page.locator('#event-choice').is_enabled()
        assert page.locator('#event-choice option').count() == 1
        print('PASS explicit showEvents=true always displays the selector, including a single calendar')
        page.close()
    page = browser.new_page()
    mocked(page)
    page.goto(f'{URL}/?event={OTHER}?showEvents=true')
    page.locator('#event-picker').wait_for(state='visible')
    assert page.locator('#event-choice').input_value() == OTHER
    assert f'event={OTHER}&showEvents=true' in page.url
    print('PASS an accidental second question mark before showEvents is corrected')
    page.close()

    for width, height in [(1366, 768), (390, 844)]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.clock.install()
        mocked(page, 'staged')
        page.goto(f'{URL}/?event={OTHER}')
        page.locator('.has-availability').first.wait_for(state='attached')
        if width <= 720:
            page.locator('#view-selected-times').click()
        assert page.locator('#day-times .time').count() == 14
        assert page.locator('#day-times button:not(:disabled)').count() == 3
        assert page.locator('#day-times button:disabled').count() == 11
        assert 'Not available' in page.locator('#day-times button:disabled').first.inner_text()
        assert [button.get_attribute('data-slot') for button in page.locator('[data-slot]').all()] == [PGA_SLOTS[index]['id'] for index in [1, 5, 10]]
        assert page.locator('#release-hint').is_visible()
        updated = [dict(slot, remaining=0 if index == 1 else 3, is_open=index in [5, 7, 10])
                   for index, slot in enumerate(PGA_SLOTS)]
        page.route('https://supabase.test/rest/v1/rpc/appt_public_slots', lambda route: route.fulfill(json=updated, headers={'Access-Control-Allow-Origin': '*'}))
        page.clock.run_for(30010)
        page.wait_for_function('(id) => Boolean(document.querySelector(`[data-slot="${id}"]`))', arg=PGA_SLOTS[7]['id'])
        assert page.locator('#day-times button:not(:disabled)').count() == 3
        assert 'Fully booked' in page.locator(f'[data-time-id="{PGA_SLOTS[1]["id"]}"]').inner_text()
        assert page.locator('#booking-form').is_hidden()
        print('PASS staged release: three selectable times, accurate grey labels, automatic refresh opens next time')
        page.close()

    page = browser.new_page()
    calls, attempts = mocked(page)
    page.goto(f'{URL}/?event={EVENT}&ref={"a" * 32}&showEvents=true')
    page.locator('#day-times').wait_for(state='visible')
    assert 'ref=' in page.locator('[data-booking-home]').first.get_attribute('href')
    assert 'Jeff' not in page.locator('main').inner_text()
    page.locator('#event-choice').select_option(OTHER)
    page.wait_for_function("!location.search.includes('ref=')")
    page.locator('#event-choice').select_option(EVENT)
    page.wait_for_function("location.search.includes('ref=') && document.getElementById('booking-workspace').getAttribute('aria-busy') === 'false'")
    page.reload()
    page.locator('#day-times').wait_for(state='visible')
    select_time(page)
    fill_guest(page)
    page.locator('#book-button').click()
    page.locator('#confirmation').wait_for(state='visible')
    assert attempts[0]['p_ref'] == 'a' * 32
    print('PASS tracked links preserve attribution through navigation/refresh and submit it privately')
    page.close()
    page = browser.new_page()
    calls, attempts = mocked(page, 'invalid-ref')
    page.goto(f'{URL}/?event={EVENT}&ref=disabled-token')
    page.wait_for_function("document.getElementById('availability-status').textContent.includes('no longer active')")
    assert not page.locator('[data-slot]').count()
    assert not attempts
    print('PASS disabled or invalid tracking links cannot silently submit untracked bookings')
    page.close()

    for tracked in [False, True]:
        page = browser.new_page()
        calls, attempts = mocked(page, 'legacy-db')
        suffix = f'/?event={EVENT}&ref={"a" * 32}' if tracked else '/'
        page.goto(URL + suffix)
        page.locator('#day-times').wait_for(state='visible')
        select_time(page)
        fill_guest(page)
        page.locator('#book-button').click()
        if tracked:
            page.wait_for_function("document.getElementById('message').textContent.includes('setup is being updated')")
            assert not any(path == 'appt_book' for path, body in calls)
        else:
            page.locator('#confirmation').wait_for(state='visible')
            assert any(path == 'appt_book' for path, body in calls)
        print('PASS migration rollout: ordinary bookings retain compatibility, tracked bookings never drop attribution')
        page.close()

    page = browser.new_page()
    calls, attempts = mocked(page)
    page.goto(f'{URL}/admin.html')
    page.locator('[name="email"]').fill('admin@example.com')
    page.locator('[name="password"]').fill('test-only')
    page.locator('#sign-in').click()
    page.locator('#admin-workspace').wait_for(state='visible')
    page.get_by_text('Start differs: app 9 AM; Google 10 AM.', exact=True).wait_for()
    assert 'Last cancellation check:' in page.locator('#calendar-audit-status').inner_text()
    assert 'Last detail audit:' in page.locator('#calendar-audit-status').inner_text()
    assert page.locator('#calendar-audit-issues img').count() == 0
    assert 'place released' in page.locator('#calendar-audit-issues').inner_text()
    assert page.locator('#all-calendars-link').get_attribute('href') == '/?showEvents=true'
    assert page.locator('#bookings-table img').count() == 0
    assert '<img' in page.locator('#bookings-table').inner_text()
    assert 'Jeff' in page.locator('#bookings-table').inner_text()
    page.locator('#release-event').select_option(EVENT)
    page.locator('#release-form [name="limit"]').fill('3')
    page.locator('#release-form button').click()
    page.wait_for_function("document.getElementById('message').textContent.includes('3 open time choices')")
    page.locator('#referral-form [name="event_id"]').select_option(EVENT)
    page.locator('#referral-form [name="label"]').fill('Jeff')
    page.locator('#referral-form button').click()
    page.wait_for_function("document.querySelectorAll('#referral-links input').length === 1")
    assert f'event={EVENT}&ref=' in page.locator('#referral-links input').input_value()
    assert '1 bookings' in page.locator('#referral-links').inner_text()
    page.locator('#referral-links').get_by_role('button', name='Disable link').click()
    page.locator('#referral-links').get_by_role('button', name='Enable link').wait_for()
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
    assert 'Jeff' in csv and 'salesperson' in csv
    def dismiss_delete(dialog):
        dialog.dismiss()
    page.once('dialog', dismiss_delete)
    page.locator('#referral-links').get_by_role('button', name='Delete link').click()
    assert page.locator('#referral-links input').count() == 1
    assert not any(path == 'appt_admin_delete_referral' for path, body in calls)
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#referral-links').get_by_role('button', name='Delete link').click()
    page.wait_for_function("document.querySelectorAll('#referral-links input').length === 0")
    assert 'Jeff' in page.locator('#bookings-table').inner_text()
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.locator('#bookings-table').get_by_role('button', name='Delete booking').click()
    assert not any(path == 'appt_admin_delete_booking' for path, body in calls)
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#bookings-table').get_by_role('button', name='Delete booking').click()
    page.wait_for_function("document.getElementById('bookings-table').textContent.includes('No bookings yet')")
    assert page.locator('#bookings-heading').inner_text() == 'Bookings (0)'
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
