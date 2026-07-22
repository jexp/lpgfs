/**
 * Tests for the pure /log.md rendering logic.
 */

import { describe, it, expect } from 'vitest';
import { renderRootLog, EMPTY_LOG_STUB, type LogSourceEntry } from './log.js';

describe('renderRootLog', () => {
  it('groups entries under ## YYYY-MM-DD headings, newest date first', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'penelope', timestamp: '2026-01-05T00:00:00.000Z' },
      { label: 'Character', name: 'odysseus', timestamp: '2026-03-10T12:00:00.000Z' },
      { label: 'Location', name: 'ithaca', timestamp: '2026-02-01T00:00:00.000Z' },
    ];

    const content = renderRootLog(entries, 'wikilink');

    const headingIndexes = ['## 2026-03-10', '## 2026-02-01', '## 2026-01-05'].map((h) =>
      content.indexOf(h)
    );
    expect(headingIndexes.every((i) => i !== -1)).toBe(true);
    expect(headingIndexes[0]).toBeLessThan(headingIndexes[1]!);
    expect(headingIndexes[1]).toBeLessThan(headingIndexes[2]!);
  });

  it('orders entries within a date deterministically (label, then name)', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'zeus', timestamp: '2026-01-05T00:00:00.000Z' },
      { label: 'Character', name: 'athena', timestamp: '2026-01-05T09:00:00.000Z' },
      { label: 'Artifact', name: 'trident', timestamp: '2026-01-05T03:00:00.000Z' },
    ];

    const content = renderRootLog(entries, 'wikilink');
    const section = content.split('## 2026-01-05')[1]!;

    const artifactIdx = section.indexOf('Artifact/trident');
    const athenaIdx = section.indexOf('Character/athena');
    const zeusIdx = section.indexOf('Character/zeus');

    expect(artifactIdx).toBeGreaterThan(-1);
    expect(artifactIdx).toBeLessThan(athenaIdx);
    expect(athenaIdx).toBeLessThan(zeusIdx);
  });

  it('renders bullets as "- **Update** <link>"', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const content = renderRootLog(entries, 'wikilink');
    expect(content).toContain('- **Update** [[Character/odysseus]]');
  });

  it('is a no-op regarding nodes without a resolvable timestamp: the caller omits them before calling', () => {
    // renderRootLog only ever receives entries that already have a
    // timestamp; other entries in the graph without one are excluded
    // upstream and never appear here, without affecting the entries that do.
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const content = renderRootLog(entries, 'wikilink');
    expect(content).toContain('odysseus');
    expect(content.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('renders the documented stub when there are zero entries anywhere in the graph', () => {
    const content = renderRootLog([], 'wikilink');
    expect(content).toBe(EMPTY_LOG_STUB);
    expect(content).not.toContain('##');
  });

  it('supports the markdown link style', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const content = renderRootLog(entries, 'markdown');
    expect(content).toContain('- **Update** /Character/odysseus.md');
    expect(content).not.toContain('[[');
  });

  it('supports the wikilink link style', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const content = renderRootLog(entries, 'wikilink');
    expect(content).toContain('[[Character/odysseus]]');
  });

  it('groups by date-only, ignoring the time-of-day portion of the timestamp', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'a', timestamp: '2026-01-05T01:00:00.000Z' },
      { label: 'Character', name: 'b', timestamp: '2026-01-05T23:59:59.000Z' },
    ];
    const content = renderRootLog(entries, 'wikilink');
    expect(content.match(/## 2026-01-05/g)).toHaveLength(1);
  });

  it('handles a bare date-only timestamp (no time component)', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-05' },
    ];
    const content = renderRootLog(entries, 'wikilink');
    expect(content).toContain('## 2026-01-05');
  });

  it('ends with a trailing newline', () => {
    const entries: LogSourceEntry[] = [
      { label: 'Character', name: 'odysseus', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const content = renderRootLog(entries, 'wikilink');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });
});
