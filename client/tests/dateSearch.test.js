import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateQuery, matchesDateWindow, matchesSearch } from '../src/utils/dateSearch.js';

const thisYear = new Date().getFullYear();
// Windows are local-time and half-open: [start, end).
const local = (y, m, d = 1) => new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
const span = (query) => {
  const window = parseDateQuery(query);
  return window && [window.start.getTime(), window.end.getTime(), window.precision, window.label];
};

test('a day, written many ways', () => {
  const oct13 = [local(2025, 10, 13), local(2025, 10, 14), 'day', 'Oct 13, 2025'];
  for (const query of [
    'Oct 13 2025', 'October 13th, 2025', 'oct. 13, 2025', '13 Oct 2025', '13 october 25',
    '10/13/2025', '10-13-25', '2025-10-13', '2025/10/13', '  OCT 13 2025  ',
  ]) {
    assert.deepEqual(span(query), oct13, query);
  }
  assert.deepEqual(span('10/13'), [local(thisYear, 10, 13), local(thisYear, 10, 14), 'day', `Oct 13, ${thisYear}`]);
  assert.deepEqual(span('oct 13'), span('10/13'));
  assert.deepEqual(span('13 oct'), span('10/13'));
  // Two-digit years: 68 and below are 20xx.
  assert.equal(span('1/2/68')[0], local(2068, 1, 2));
  assert.equal(span('1/2/69')[0], local(1969, 1, 2));
});

test('a month or a year', () => {
  const oct = [local(2025, 10), local(2025, 11), 'month', 'October 2025'];
  for (const query of ['Oct 2025', 'october 2025', '10/2025', '2025-10']) assert.deepEqual(span(query), oct, query);
  assert.deepEqual(span('december 2025'), [local(2025, 12), local(2026, 1), 'month', 'December 2025'], 'December ends in January');
  assert.deepEqual(span('October'), [local(thisYear, 10), local(thisYear, 11), 'month', `October ${thisYear}`]);
  assert.deepEqual(span('sept 2024'), [local(2024, 9), local(2024, 10), 'month', 'September 2024']);
  assert.deepEqual(span('2025'), [local(2025, 1), local(2026, 1), 'year', '2025']);
});

test('ranges run from the earlier start to the later end', () => {
  const week = [local(2025, 10, 13), local(2025, 10, 21), 'range', 'Oct 13 – Oct 20, 2025'];
  for (const query of [
    'Oct 13 2025 - Oct 20 2025', 'Oct 13 2025 to Oct 20 2025', 'oct 13 2025 through oct 20 2025',
    '2025-10-13..2025-10-20', '10/13/2025 – 10/20/2025', '10/13/2025 until 10/20/2025',
  ]) {
    assert.deepEqual(span(query), week, query);
  }
  assert.deepEqual(span('Oct 20 2025 - Oct 13 2025'), week, 'typed backwards');
  assert.deepEqual(span('Oct 2025 to Dec 2025'), [local(2025, 10), local(2026, 1), 'range', 'October 2025 – December 2025']);
  assert.deepEqual(span('Dec 30 2025 - Jan 2 2026').slice(0, 2), [local(2025, 12, 30), local(2026, 1, 3)]);
  // The hyphens inside a date are not a range, and a half-typed range keeps the first date.
  assert.equal(span('10-13-2025')[2], 'day');
  assert.deepEqual(span('Oct 13 2025 - '), span('Oct 13 2025'));
  assert.deepEqual(span('Oct 13 2025 to'), span('Oct 13 2025'));
  assert.equal(span('Oct 13 2025 - nonsense'), null);
});

test('what is not a date is left to name search', () => {
  for (const query of [
    '', '   ', null, undefined, 'commute', 'Feb 30 2025', '13/45/2025', '2025-13-01', 'octember 2025',
    '1899', '3000', '12345', 'oct 13 2025 extra', '10/13/2025/1',
  ]) {
    assert.equal(parseDateQuery(query), null, JSON.stringify(query));
  }
  assert.equal(span('Feb 29 2024')[0], local(2024, 2, 29), 'leap day');
  assert.equal(parseDateQuery('Feb 29 2025'), null);
});

test('a journey matches every day it touches', () => {
  const oct13 = parseDateQuery('2025-10-13');
  const at = (d, h, min = 0) => new Date(2025, 9, d, h, min).toISOString();
  assert.equal(matchesDateWindow(oct13, at(13, 9), at(13, 10)), true);
  assert.equal(matchesDateWindow(oct13, at(13, 23, 30), at(14, 0, 30)), true, 'starts late on the day');
  assert.equal(matchesDateWindow(oct13, at(12, 23, 30), at(13, 0, 30)), true, 'ran past midnight into it');
  assert.equal(matchesDateWindow(oct13, at(12, 9), at(12, 10)), false);
  assert.equal(matchesDateWindow(oct13, at(14, 0), at(14, 1)), false, 'the end of the window is exclusive');
  assert.equal(matchesDateWindow(oct13, at(13, 0), null), true, 'no end time');
  assert.equal(matchesDateWindow(oct13, at(13, 9), at(13, 8)), true, 'an end before the start is ignored');
  assert.equal(matchesDateWindow(oct13, null, at(13, 9)), false);
  assert.equal(matchesDateWindow(oct13, 'not a date', null), false);
  assert.equal(matchesDateWindow(null, at(13, 9), at(13, 10)), false);
});

test('search matches on name or date', () => {
  const journey = { name: 'Drive to 2025 Expo', startTime: new Date(2024, 4, 1, 12).toISOString(), endTime: new Date(2024, 4, 1, 13).toISOString() };
  const search = (text) => matchesSearch(journey, text, parseDateQuery(text));
  assert.equal(search(''), true);
  assert.equal(search('expo'), true);
  assert.equal(search('EXPO'), true);
  assert.equal(search('commute'), false);
  assert.equal(search('2025'), true, 'a year in the name still matches by name');
  assert.equal(search('May 2024'), true, 'by date');
  assert.equal(search('June 2024'), false);
  assert.equal(matchesSearch({}, 'x', null), false);
  assert.equal(matchesSearch(null, '', null), true);
});
