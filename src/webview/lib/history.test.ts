import { describe, expect, it } from 'vitest';
import type { HistoryEntry, HttpMethod } from '../../shared/model';
import { dayLabel, groupByDay, matchesEndpoint } from './history';

const entry = (method: HttpMethod, url: string, timestamp = 0): HistoryEntry => ({
  id: `${method} ${url} ${timestamp}`,
  requestId: 'r',
  timestamp,
  environment: null,
  request: { method, url, headers: [], body: { type: 'none' } },
});

describe('matchesEndpoint', () => {
  it('matches same method and path, ignoring query and trailing slash', () => {
    expect(matchesEndpoint(entry('GET', 'https://a.test/users/?page=2'), 'GET', 'https://a.test/users')).toBe(true);
    expect(matchesEndpoint(entry('POST', 'https://a.test/users'), 'GET', 'https://a.test/users')).toBe(false);
    expect(matchesEndpoint(entry('GET', 'http://localhost:3000/health'), 'GET', 'https://api.test/gst')).toBe(false);
  });
  it('treats {{variables}} as wildcards', () => {
    expect(matchesEndpoint(entry('GET', 'http://localhost:3000/users/42'), 'GET', '{{baseUrl}}/users/{{id}}')).toBe(true);
    expect(matchesEndpoint(entry('GET', 'http://localhost:3000/orders/42'), 'GET', '{{baseUrl}}/users/{{id}}')).toBe(false);
  });
});

describe('day grouping', () => {
  const now = new Date(2026, 8, 14, 15, 0).getTime();
  it('labels today and yesterday', () => {
    expect(dayLabel(new Date(2026, 8, 14, 0, 5).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 13, 23, 59).getTime(), now)).toBe('Yesterday');
  });
  it('groups consecutive entries per day', () => {
    const groups = groupByDay(
      [entry('GET', 'x', new Date(2026, 8, 14, 10).getTime()), entry('GET', 'x', new Date(2026, 8, 14, 9).getTime()), entry('GET', 'x', new Date(2026, 8, 12, 9).getTime())],
      now,
    );
    expect(groups.map((g) => [g.label === 'Today', g.entries.length])).toEqual([
      [true, 2],
      [false, 1],
    ]);
  });
});
