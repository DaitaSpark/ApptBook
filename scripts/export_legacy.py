"""Create a private, one-time import from the old SQLite DB; never exports into dist/."""
import argparse
from collections import Counter
from pathlib import Path
import sqlite3
import uuid

ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = uuid.UUID('adac8dc8-0484-4f7f-9339-96e7c8aee337')
def mapped(kind, value):
    return str(uuid.uuid5(NAMESPACE, f'{kind}:{value}'))
def literal(value):
    return "'" + str(value or '').replace("'", "''") + "'"
def timestamp(value):
    return f'({literal(value)}::timestamp at time zone \'America/New_York\')'

def export(source, output):
    with sqlite3.connect(f'{source.resolve().as_uri()}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        events = list(db.execute('select * from event'))
        slots = list(db.execute('select * from slot'))
        bookings = list(db.execute('select * from booking'))
    counts = Counter(row['slot_id'] for row in bookings)
    if any(row['reserved'] != counts[row['id']] for row in slots):
        raise ValueError('Legacy reserved counts differ from booking records. Resolve this before migration.')
    sql = ['-- PRIVATE: contains guest details if present. Do not commit or publish.',
        '-- Run once AFTER migration 001 and INSTEAD OF seed.sql, on an empty appointments schema.',
        'begin;', "do $$ begin if exists(select 1 from appt_private.events) then raise exception 'Import requires empty appointment tables; no data was changed.'; end if; end $$;"]
    for row in events:
        sql.append('insert into appt_private.events(id,name,description,location,default_capacity) values(' +
            ','.join([literal(mapped('event', row['id'])), literal(row['name']), literal(row['description']),
                literal(row['location']), str(row['default_capacity'])]) + ');')
    for row in slots:
        sql.append('insert into appt_private.slots(id,event_id,starts_at,ends_at,capacity,reserved) values(' +
            ','.join([literal(mapped('slot', row['id'])), literal(mapped('event', row['event_id'])),
                timestamp(row['starts_at']), timestamp(row['ends_at']), str(row['capacity']), str(row['reserved'])]) + ');')
    for row in bookings:
        sql.append('insert into appt_private.bookings(id,request_id,slot_id,name,email,phone,notes) values(' +
            ','.join([literal(mapped('booking', row['id'])), literal(mapped('request', row['id'])),
                literal(mapped('slot', row['slot_id'])), literal(row['name']), literal(row['email']),
                literal(row['phone']), literal(row['notes'])]) + ');')
    sql.append('commit;')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(sql) + '\n', encoding='utf-8')
    print(f'Private import prepared: {len(events)} events, {len(slots)} slots, {len(bookings)} bookings. No database was modified.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=ROOT / 'instance' / 'appointments.db')
    parser.add_argument('--output', type=Path, default=ROOT / 'supabase' / 'import-legacy.sql')
    args = parser.parse_args()
    export(args.source, args.output)
