// A day that is not on the calendar must not be planned as a date. Pure: no database.
// Run: node --test tests/navigate-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {planQuestion} from '../lib/navigate-plan.mjs';

const noon = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));

test('an impossible day is not kept as a date', () => {
  const feb = planQuestion('notes from February 30 and 30 February', {now: noon(2026, 3, 1), year: 2026});
  assert.equal(feb.dates.includes('2026-02-30'), false);
  const apr = planQuestion('what about April 31st and 31 April', {now: noon(2026, 5, 1), year: 2026});
  assert.equal(apr.dates.includes('2026-04-31'), false);
  const iso = planQuestion('open 2026-02-30 and 2026-04-31 and 2026-11-31', {now: noon(2026, 1, 15)});
  assert.deepEqual(iso.dates, []);
});

test('a real day stays, including 29 February in a leap year, and today stays today', () => {
  const leap = planQuestion('notes from 29 February and February 29', {now: noon(2024, 3, 1), year: 2024});
  assert.deepEqual(leap.dates, ['2024-02-29']);
  const common = planQuestion('notes from 29 February', {now: noon(2026, 3, 1), year: 2026});
  assert.equal(common.dates.includes('2026-02-29'), false);
  const kept = planQuestion('March 1 and February 30 and 2026-11-30', {now: noon(2026, 3, 2), year: 2026});
  assert.deepEqual([...kept.dates].sort(), ['2026-03-01', '2026-11-30']);
  const today = planQuestion('what changed today', {now: noon(2026, 11, 23)});
  assert.deepEqual(today.dates, ['2026-11-23']);
});
