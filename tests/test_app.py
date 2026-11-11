import os
import unittest
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from unittest.mock import patch

from app import Booking, EASTERN, Event, Slot, create_app, db


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


if __name__ == '__main__':
    unittest.main()
