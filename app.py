import csv
import io
import os
import secrets
import smtplib
from datetime import datetime
from email.message import EmailMessage
from functools import wraps
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from flask import Flask, Response, abort, flash, redirect, render_template, request, session, url_for
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import select, update
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()
db = SQLAlchemy()
EASTERN = ZoneInfo('America/New_York')


class Event(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(160), nullable=False)
    description = db.Column(db.Text, default='')
    location = db.Column(db.String(240), default='')
    default_capacity = db.Column(db.Integer, nullable=False, default=1)
    slots = db.relationship('Slot', backref='event', order_by='Slot.starts_at')


class Slot(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    event_id = db.Column(db.Integer, db.ForeignKey('event.id'), nullable=False)
    starts_at = db.Column(db.DateTime, nullable=False)
    ends_at = db.Column(db.DateTime, nullable=False)
    capacity = db.Column(db.Integer, nullable=False)
    reserved = db.Column(db.Integer, nullable=False, default=0)
    __table_args__ = (db.CheckConstraint('capacity > 0 AND reserved >= 0 AND reserved <= capacity'),)


class Booking(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    reference = db.Column(db.String(32), unique=True, nullable=False)
    slot_id = db.Column(db.Integer, db.ForeignKey('slot.id'), nullable=False)
    name = db.Column(db.String(160), nullable=False)
    email = db.Column(db.String(254), default='')
    phone = db.Column(db.String(40), default='')
    notes = db.Column(db.Text, default='')
    email_status = db.Column(db.String(30), default='not_requested')
    slot = db.relationship('Slot')


def create_app(config=None):
    app = Flask(__name__)
    database_url = os.getenv('DATABASE_URL', 'sqlite:///appointments.db')
    if database_url.startswith(('postgres://', 'postgresql://')):
        database_url = 'postgresql+psycopg://' + database_url.split('://', 1)[1]
    app.config.update(SECRET_KEY=os.getenv('SECRET_KEY') or secrets.token_hex(32),
                      SQLALCHEMY_DATABASE_URI=database_url,
                      SQLALCHEMY_TRACK_MODIFICATIONS=False,
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                      SESSION_COOKIE_SECURE=os.getenv('RENDER') == 'true',
                      MAX_CONTENT_LENGTH=32 * 1024)
    if config:
        app.config.update(config)
    db.init_app(app)
    admin_password = os.getenv('ADMIN_PASSWORD')
    admin_hash = generate_password_hash(admin_password) if admin_password else None

    def admin_only(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get('admin'):
                return redirect(url_for('login'))
            return fn(*args, **kwargs)
        return wrapped

    @app.before_request
    def csrf_check():
        if 'csrf' not in session:
            session['csrf'] = secrets.token_hex(32)
        if request.method == 'POST' and not secrets.compare_digest(session['csrf'], request.form.get('csrf', '')):
            abort(400, 'This form expired. Reload the page and try again.')

    @app.context_processor
    def helpers():
        return {'now': datetime.now(EASTERN).replace(tzinfo=None)}

    @app.after_request
    def security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'same-origin'
        if request.path.startswith(('/admin', '/booking/')):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/')
    def index():
        return render_template('index.html', events=db.session.scalars(select(Event).order_by(Event.name)).all())

    @app.get('/events/<int:event_id>')
    def event_page(event_id):
        event = db.get_or_404(Event, event_id)
        dates = {}
        for slot in event.slots:
            if slot.starts_at > datetime.now(EASTERN).replace(tzinfo=None):
                dates.setdefault(slot.starts_at.date(), []).append(slot)
        return render_template('event.html', event=event, dates=dates)

    @app.post('/slots/<int:slot_id>/book')
    def book(slot_id):
        slot = db.get_or_404(Slot, slot_id)
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip()
        phone = request.form.get('phone', '').strip()
        notes = request.form.get('notes', '').strip()
        if not name or len(name) > 160 or not (email or phone) or len(email) > 254 or len(phone) > 40 or len(notes) > 3000 or (email and ('@' not in email or '.' not in email.rsplit('@', 1)[-1])):
            flash('Enter your name and a valid email address or phone number. Notes must be under 3,000 characters.', 'error')
            return redirect(url_for('event_page', event_id=slot.event_id))
        result = db.session.execute(update(Slot).where(Slot.id == slot_id, Slot.reserved < Slot.capacity,
            Slot.starts_at > datetime.now(EASTERN).replace(tzinfo=None)).values(reserved=Slot.reserved + 1))
        if result.rowcount != 1:
            db.session.rollback()
            flash('That time is no longer available. Please choose another.', 'error')
            return redirect(url_for('event_page', event_id=slot.event_id))
        booking = Booking(slot_id=slot.id, reference=secrets.token_urlsafe(18), name=name, email=email, phone=phone, notes=notes)
        db.session.add(booking)
        db.session.commit()
        if email:
            booking.email_status = send_confirmation(booking, app)
            db.session.commit()
        return redirect(url_for('confirmation', reference=booking.reference))

    @app.get('/booking/<reference>')
    def confirmation(reference):
        booking = db.session.scalar(select(Booking).where(Booking.reference == reference))
        if not booking:
            abort(404)
        return render_template('confirmation.html', booking=booking)

    @app.route('/admin/login', methods=['GET', 'POST'])
    def login():
        if request.method == 'POST':
            if admin_hash and check_password_hash(admin_hash, request.form.get('password', '')):
                session.clear()
                session['admin'] = True
                return redirect(url_for('admin'))
            flash('Unable to sign in. Check your password or configure ADMIN_PASSWORD.', 'error')
        return render_template('login.html')

    @app.post('/admin/logout')
    def logout():
        session.clear()
        return redirect(url_for('index'))

    @app.get('/admin')
    @admin_only
    def admin():
        return render_template('admin.html', events=db.session.scalars(select(Event).order_by(Event.name)).all(),
            bookings=db.session.scalars(select(Booking).order_by(Booking.id.desc())).all())

    @app.post('/admin/events')
    @admin_only
    def add_event():
        try:
            name = request.form['name'].strip()
            capacity = int(request.form['capacity'])
            if not name or len(name) > 160 or not 1 <= capacity <= 10000:
                raise ValueError()
            db.session.add(Event(name=name, description=request.form.get('description', '')[:3000],
                location=request.form.get('location', '')[:240], default_capacity=capacity))
            db.session.commit()
            flash('Person or event created.', 'success')
        except (ValueError, KeyError):
            flash('Enter a name and a capacity between 1 and 10,000.', 'error')
        return redirect(url_for('admin'))

    @app.post('/admin/slots')
    @admin_only
    def add_slot():
        try:
            event = db.get_or_404(Event, int(request.form['event_id']))
            start = datetime.fromisoformat(request.form['date'] + 'T' + request.form['start'])
            end = datetime.fromisoformat(request.form['date'] + 'T' + request.form['end'])
            capacity = int(request.form.get('capacity') or event.default_capacity)
            if start <= datetime.now(EASTERN).replace(tzinfo=None) or end <= start or not 1 <= capacity <= 10000:
                raise ValueError()
            # Reject ambiguous or nonexistent local times at DST boundaries.
            if start.replace(tzinfo=EASTERN, fold=0).utcoffset() != start.replace(tzinfo=EASTERN, fold=1).utcoffset() or end.replace(tzinfo=EASTERN, fold=0).utcoffset() != end.replace(tzinfo=EASTERN, fold=1).utcoffset():
                raise ValueError()
            duplicate = db.session.scalar(select(Slot).where(Slot.event_id == event.id, Slot.starts_at == start))
            if duplicate:
                raise ValueError()
            db.session.add(Slot(event_id=event.id, starts_at=start, ends_at=end, capacity=capacity))
            db.session.commit()
            flash('Time slot added.', 'success')
        except (ValueError, KeyError):
            flash('Choose a unique future time, an end after the start, and a valid capacity. Avoid daylight saving transition hours.', 'error')
        return redirect(url_for('admin'))

    @app.get('/admin/export.csv')
    @admin_only
    def export():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['Name', 'Email', 'Phone', 'Event', 'Start (Eastern)', 'Notes', 'Email status'])
        for booking in db.session.scalars(select(Booking).order_by(Booking.id.desc())):
            values = [booking.name, booking.email, booking.phone, booking.slot.event.name,
                      str(booking.slot.starts_at), booking.notes, booking.email_status]
            writer.writerow(["'" + v if v.startswith(('=', '+', '-', '@', '\t', '\r')) else v for v in values])
        return Response(output.getvalue(), mimetype='text/csv', headers={'Content-Disposition': 'attachment; filename=bookings.csv'})

    @app.cli.command('init-db')
    def init_db():
        db.create_all()
        print('Database tables created.')

    @app.get('/health')
    def health():
        return {'status': 'ok'}

    return app


def send_confirmation(booking, app):
    if not os.getenv('SMTP_HOST') or not os.getenv('MAIL_FROM'):
        return 'not_configured'
    message = EmailMessage()
    message['Subject'] = f'Your JR & Co. appointment: {booking.slot.event.name}'
    message['From'] = os.environ['MAIL_FROM']
    message['To'] = booking.email
    message.set_content(f'Hello {booking.name},\n\nYour appointment is confirmed.\n\n{booking.slot.event.name}\n'
        f'{booking.slot.starts_at:%A, %B %d, %Y at %I:%M %p} Eastern Time\n'
        f'Location: {booking.slot.event.location or "To be arranged"}\n\nThank you,\nJR & Co.')
    try:
        with smtplib.SMTP(os.environ['SMTP_HOST'], int(os.getenv('SMTP_PORT', '587')), timeout=15) as smtp:
            smtp.starttls()
            if os.getenv('SMTP_USERNAME'):
                smtp.login(os.environ['SMTP_USERNAME'], os.environ['SMTP_PASSWORD'])
            smtp.send_message(message)
        return 'sent'
    except Exception:
        app.logger.exception('Confirmation delivery failed for booking %s', booking.id)
        return 'failed'


app = create_app()
