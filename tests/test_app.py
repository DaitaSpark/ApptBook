import os
import unittest
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from unittest.mock import patch

from app import Booking, EASTERN, Event, Slot, add_workday_slots, create_app, db


class BookingTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, {'ADMIN_PASSWORD': 'test-password'}):
            self.app = create_app({'TESTING': True, 'SECRET_KEY': 'test', 'SQLALCHEMY_DATABASE_URI': 'sqlite://'})
        self.client = self.app.test_client()
        with self.app.app_context():
            db.create_all()
            event = Event(name='Meet JR & Co.', default_capacity=2)
            db.session.add(event)
            db.session.flush()
            start = datetime.now(EASTERN).replace(tzinfo=None) + timedelta(days=5)
            slot = Slot(event_id=event.id, starts_at=start, ends_at=start + timedelta(minutes=30), capacity=2)
            db.session.add(slot)
            db.session.commit()
            self.slot_id, self.event_id = slot.id, event.id

    def token(self):
        self.client.get('/')
        with self.client.session_transaction() as session:
            return session['csrf']

    def book(self, **kwargs):
        data = {'name': 'A Guest', 'phone': '555-0100', 'csrf': self.token()}
        data.update(kwargs)
        return self.client.post(f'/slots/{self.slot_id}/book', data=data)

    def test_capacity_cannot_be_exceeded(self):
        self.book()
        self.book()
        response = self.book()
        self.assertIn('/events/', response.location)
        with self.app.app_context():
            self.assertEqual(db.session.get(Slot, self.slot_id).reserved, 2)
            self.assertEqual(db.session.query(Booking).count(), 2)

    def test_contact_required(self):
        self.book(phone='', email='')
        self.book(email='invalid')
        with self.app.app_context():
            self.assertEqual(db.session.query(Booking).count(), 0)
            self.assertEqual(db.session.get(Slot, self.slot_id).reserved, 0)

    def test_phone_only_confirmation(self):
        response = self.book()
        page = self.client.get(response.location)
        self.assertIn(b'Your appointment is saved.', page.data)
        self.assertNotIn(b'email has been sent', page.data)

    def test_failed_email_preserves_booking(self):
        with patch('app.send_confirmation', return_value='failed'):
            response = self.book(email='guest@example.com', phone='')
        self.assertIn(b'Email confirmation is currently unavailable', self.client.get(response.location).data)
        with self.app.app_context():
            self.assertEqual(db.session.query(Booking).one().email_status, 'failed')

    def test_csrf_and_admin_access(self):
        self.assertEqual(self.client.post(f'/slots/{self.slot_id}/book', data={'name': 'X'}).status_code, 400)
        self.assertIn('/admin/login', self.client.get('/admin').location)
        self.assertIn('/admin/login', self.client.get('/admin/export.csv').location)

    def test_public_and_admin_pages(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get(f'/events/{self.event_id}').status_code, 200)
        self.client.post('/admin/login', data={'password': 'test-password', 'csrf': self.token()})
        self.assertEqual(self.client.get('/admin').status_code, 200)
        self.assertEqual(self.client.get('/admin/export.csv').status_code, 200)
        self.client.post('/admin/events', data={'name': 'Consultation', 'capacity': '3', 'csrf': self.token()})
        with self.app.app_context():
            self.assertEqual(db.session.query(Event).count(), 2)

    def test_past_slot_cannot_be_booked(self):
        with self.app.app_context():
            db.session.get(Slot, self.slot_id).starts_at = datetime.now(EASTERN).replace(tzinfo=None) - timedelta(hours=1)
            db.session.commit()
        self.book()
        with self.app.app_context():
            self.assertEqual(db.session.query(Booking).count(), 0)

    def test_concurrent_requests_respect_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app({'TESTING': True, 'SECRET_KEY': 'test',
                'SQLALCHEMY_DATABASE_URI': 'sqlite:///' + directory.replace('\\', '/') + '/race.db'})
            with app.app_context():
                db.create_all()
                event = Event(name='Concurrent event')
                db.session.add(event)
                db.session.flush()
                start = datetime.now(EASTERN).replace(tzinfo=None) + timedelta(days=1)
                slot = Slot(event_id=event.id, starts_at=start, ends_at=start + timedelta(minutes=30), capacity=2)
                db.session.add(slot)
                db.session.commit()
                slot_id = slot.id

            def reserve(index):
                with app.test_client() as client:
                    client.get('/')
                    with client.session_transaction() as session:
                        token = session['csrf']
                    return client.post(f'/slots/{slot_id}/book', data={
                        'csrf': token, 'name': f'Guest {index}', 'phone': '555-0100'}).status_code

            with ThreadPoolExecutor(max_workers=6) as pool:
                self.assertEqual(list(pool.map(reserve, range(6))), [302] * 6)
            with app.app_context():
                self.assertEqual(db.session.query(Booking).count(), 2)
                self.assertEqual(db.session.get(Slot, slot_id).reserved, 2)
                db.session.remove()
                db.engine.dispose()

    def test_weekday_generation_boundaries_and_rerun(self):
        with self.app.app_context():
            event = Event(name='Weekdays', default_capacity=1)
            db.session.add(event)
            db.session.flush()
            # Friday through Monday includes two workdays and skips the weekend.
            first, last = date(2030, 1, 4), date(2030, 1, 7)
            self.assertEqual(add_workday_slots(event, first, last, datetime(2030, 1, 1)), 28)
            db.session.commit()
            slots = db.session.query(Slot).filter_by(event_id=event.id).order_by(Slot.starts_at).all()
            self.assertEqual(slots[0].starts_at, datetime(2030, 1, 4, 9))
            self.assertEqual(slots[-1].starts_at, datetime(2030, 1, 7, 15, 30))
            self.assertEqual(slots[-1].ends_at, datetime(2030, 1, 7, 16))
            self.assertTrue(all(s.starts_at.weekday() < 5 and s.capacity == 1 for s in slots))
            slots[0].reserved = 1
            db.session.commit()
            self.assertEqual(add_workday_slots(event, first, last, datetime(2030, 1, 1)), 0)
            self.assertEqual(slots[0].reserved, 1)

    def test_weekday_generation_skips_past_and_overlaps(self):
        with self.app.app_context():
            event = Event(name='Custom availability', default_capacity=1)
            db.session.add(event)
            db.session.flush()
            db.session.add(Slot(event_id=event.id, starts_at=datetime(2030, 1, 7, 10, 15),
                ends_at=datetime(2030, 1, 7, 11, 15), capacity=5))
            db.session.commit()
            count = add_workday_slots(event, date(2030, 1, 7), date(2030, 1, 7), datetime(2030, 1, 7, 9, 10))
            self.assertEqual(count, 10)  # 14 less one past slot and three overlapping slots.
            with self.assertRaises(ValueError):
                add_workday_slots(event, date(2030, 1, 8), date(2030, 1, 7))

    def test_admin_weekday_generation_requires_login(self):
        response = self.client.post('/admin/workdays', data={'csrf': self.token()})
        self.assertIn('/admin/login', response.location)
        self.client.post('/admin/login', data={'password': 'test-password', 'csrf': self.token()})
        response = self.client.post('/admin/workdays', data={'csrf': self.token(),
            'event_id': str(self.event_id), 'first_date': '2030-01-07', 'last_date': '2030-01-07'})
        self.assertEqual(response.status_code, 302)
        with self.app.app_context():
            self.assertEqual(db.session.query(Slot).filter_by(event_id=self.event_id).count(), 15)

    def test_homepage_calendar_and_event_selection(self):
        with self.app.app_context():
            other = Event(name='Another person', default_capacity=1)
            db.session.add(other)
            db.session.flush()
            start = datetime.now(EASTERN).replace(tzinfo=None) + timedelta(days=10)
            slot = Slot(event_id=other.id, starts_at=start, ends_at=start + timedelta(minutes=30), capacity=1)
            db.session.add(slot)
            db.session.commit()
            other_id, other_slot = other.id, slot.id
        first = self.client.get(f'/?event={self.event_id}').get_data(as_text=True)
        self.assertIn('class="calendar-grid"', first)
        self.assertIn(f'data-slot="{self.slot_id}"', first)
        self.assertNotIn(f'data-slot="{other_slot}"', first)
        second = self.client.get(f'/?event={other_id}').get_data(as_text=True)
        self.assertIn(f'data-slot="{other_slot}"', second)
        self.assertNotIn(f'data-slot="{self.slot_id}"', second)
        with self.app.app_context():
            db.session.get(Slot, other_slot).reserved = 1
            db.session.commit()
        full = self.client.get(f'/?event={other_id}').get_data(as_text=True)
        self.assertNotIn(f'data-slot="{other_slot}"', full)


if __name__ == '__main__':
    unittest.main()
