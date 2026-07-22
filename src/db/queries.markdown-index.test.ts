/**
 * Unit tests for listNodesForMarkdownIndex and its pure helpers
 * (buildMarkdownIndexQuery, truncateDescription): the single-query
 * title/timestamp/description projection used by index.md/log.md
 * generation (REQ-F-064) so no additional per-node query is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildMarkdownIndexQuery,
  truncateDescription,
  listNodesForMarkdownIndex,
} from './queries.js';
import type { DatabaseConnection } from './connection.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_MARKDOWN_MODE_CONFIG,
  type ConfigSchema,
  type MarkdownFieldsConfig,
  type TextPropertiesConfig,
} from '../types/index.js';

function config(overrides: Partial<ConfigSchema> = {}): ConfigSchema {
  return { ...DEFAULT_CONFIG, mode: { type: 'markdown' }, ...overrides };
}

function fieldsConfig(overrides: Partial<MarkdownFieldsConfig> = {}): MarkdownFieldsConfig {
  return {
    title: ['title', 'name'],
    timestamp: ['updated', 'lastUpdated'],
    tags: ['tags'],
    ...overrides,
  };
}

function textPropertiesConfig(overrides: Partial<TextPropertiesConfig> = {}): TextPropertiesConfig {
  return {
    default: ['summary', 'description', 'text'],
    ...overrides,
  };
}

function mockDb(records: Array<Record<string, unknown>>): DatabaseConnection {
  const executeQuery = vi.fn().mockResolvedValue({ records });
  return {
    executeQuery,
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseConnection;
}

describe('buildMarkdownIndexQuery', () => {
  it('emits COALESCE clauses in the exact configured fallback order', () => {
    const cypher = buildMarkdownIndexQuery('Person', ['title', 'name'], ['updated', 'lastUpdated'], [
      'summary',
      'text',
    ]);

    expect(cypher).toContain('coalesce(n.`title`, n.`name`) AS title');
    expect(cypher).toContain('coalesce(n.`updated`, n.`lastUpdated`) AS timestamp');
    expect(cypher).toContain('coalesce(n.`summary`, n.`text`) AS rawDescription');
  });

  it('reflects a reordered fallback list textually, not just in results', () => {
    const cypher = buildMarkdownIndexQuery('Person', ['name', 'title'], [], []);
    expect(cypher).toContain('coalesce(n.`name`, n.`title`) AS title');
  });

  it('emits a literal null for an empty fallback list ([] disables the mapping)', () => {
    const cypher = buildMarkdownIndexQuery('Person', [], ['updated'], ['summary']);
    expect(cypher).toContain('null AS title');
  });

  it('backtick-escapes the label', () => {
    const cypher = buildMarkdownIndexQuery('Person', ['title'], ['updated'], ['summary']);
    expect(cypher).toContain('MATCH (n:`Person`)');
  });
});

describe('truncateDescription', () => {
  it('returns short text unchanged', () => {
    expect(truncateDescription('a short description')).toBe('a short description');
  });

  it('trims surrounding whitespace even when under the limit', () => {
    expect(truncateDescription('  padded  ')).toBe('padded');
  });

  it('truncates long text and appends an ellipsis at the configured max length', () => {
    const text = 'x'.repeat(200);
    const result = truncateDescription(text, 10);
    expect(result).toBe(`${'x'.repeat(10)}…`);
  });

  it('does not truncate text exactly at the max length', () => {
    const text = 'x'.repeat(10);
    expect(truncateDescription(text, 10)).toBe(text);
  });
});

describe('listNodesForMarkdownIndex', () => {
  it('resolves title/timestamp/description per node from the projected columns', async () => {
    const db = mockDb([
      {
        elementId: '4:a:0',
        properties: { title: 'The Odyssey', summary: 'A long journey home.' },
        title: 'The Odyssey',
        timestamp: null,
        rawDescription: 'A long journey home.',
      },
      {
        elementId: '4:a:1',
        properties: { name: 'Ithaca' },
        title: 'Ithaca',
        timestamp: { year: 2026, month: 1, day: 2 },
        rawDescription: null,
      },
    ]);

    const results = await listNodesForMarkdownIndex(
      db,
      'Place',
      fieldsConfig(),
      textPropertiesConfig(),
      config()
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'The Odyssey',
      timestamp: undefined,
      description: 'A long journey home.',
    });
    expect(results[1]).toMatchObject({
      title: 'Ithaca',
      timestamp: '2026-01-02',
      description: null,
    });
  });

  it('omits title/timestamp and nulls description when nothing in the fallback lists is present', async () => {
    const db = mockDb([
      { elementId: '4:a:2', properties: {}, title: null, timestamp: null, rawDescription: null },
    ]);

    const [result] = await listNodesForMarkdownIndex(
      db,
      'Place',
      fieldsConfig(),
      textPropertiesConfig(),
      config()
    );

    expect(result).toMatchObject({ title: undefined, timestamp: undefined, description: null });
  });

  it('truncates a long description column', async () => {
    const db = mockDb([
      {
        elementId: '4:a:3',
        properties: {},
        title: null,
        timestamp: null,
        rawDescription: 'y'.repeat(300),
      },
    ]);

    const [result] = await listNodesForMarkdownIndex(
      db,
      'Place',
      fieldsConfig(),
      textPropertiesConfig(),
      config()
    );

    expect(result!.description).toHaveLength(161); // 160 chars + ellipsis
    expect(result!.description!.endsWith('…')).toBe(true);
  });

  it('resolves display names via the configured naming strategy and property override', async () => {
    const db = mockDb([
      {
        elementId: '4:a:4',
        properties: { name: 'Ithaca' },
        title: null,
        timestamp: null,
        rawDescription: null,
      },
    ]);
    const cfg = config({
      naming: { default: 'elementId', overrides: { nodes: { Place: { property: 'name' } } } },
    });

    const [result] = await listNodesForMarkdownIndex(db, 'Place', fieldsConfig(), textPropertiesConfig(), cfg);

    expect(result!.name).toBe('Ithaca');
  });

  it('resolves colliding display names using the standard collision strategy', async () => {
    const db = mockDb([
      { elementId: '4:a:5', properties: { name: 'dup' }, title: null, timestamp: null, rawDescription: null },
      { elementId: '4:a:6', properties: { name: 'dup' }, title: null, timestamp: null, rawDescription: null },
    ]);
    const cfg = config({
      naming: { default: 'elementId', overrides: { nodes: { Place: { property: 'name' } } } },
    });

    const results = await listNodesForMarkdownIndex(db, 'Place', fieldsConfig(), textPropertiesConfig(), cfg);

    expect(new Set(results.map((r) => r.name)).size).toBe(2);
  });

  it('issues exactly one query per label, with no additional per-node query', async () => {
    const db = mockDb([
      { elementId: '4:a:7', properties: {}, title: null, timestamp: null, rawDescription: null },
      { elementId: '4:a:8', properties: {}, title: null, timestamp: null, rawDescription: null },
    ]);

    await listNodesForMarkdownIndex(db, 'Place', fieldsConfig(), textPropertiesConfig(), config());

    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for a label with no nodes', async () => {
    const db = mockDb([]);

    const results = await listNodesForMarkdownIndex(db, 'Empty', fieldsConfig(), textPropertiesConfig(), config());

    expect(results).toEqual([]);
  });

  it('serves cached results without issuing a query on the second call', async () => {
    const db = mockDb([
      { elementId: '4:a:9', properties: {}, title: null, timestamp: null, rawDescription: null },
    ]);
    const { Cache } = await import('../cache/index.js');
    const cache = new Cache();

    await listNodesForMarkdownIndex(db, 'Place', fieldsConfig(), textPropertiesConfig(), config(), cache);
    await listNodesForMarkdownIndex(db, 'Place', fieldsConfig(), textPropertiesConfig(), config(), cache);

    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it('honors per-label field overrides when building the query', async () => {
    const db = mockDb([]);
    const fields = fieldsConfig({ overrides: { title: { Hero: ['epithet'] } } });

    await listNodesForMarkdownIndex(db, 'Hero', fields, textPropertiesConfig(), config());

    const cypher = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cypher).toContain('coalesce(n.`epithet`) AS title');
  });

  it('excludes a multi-label node whose chosen label is not the queried one', async () => {
    const db = mockDb([
      {
        elementId: '4:a:10',
        properties: { name: 'odysseus' },
        labels: ['Hero', 'Character'],
        title: null,
        timestamp: null,
        rawDescription: null,
      },
    ]);

    const results = await listNodesForMarkdownIndex(db, 'Hero', fieldsConfig(), textPropertiesConfig(), config());

    // Alphabetically, 'Character' < 'Hero', so this node's chosen label is
    // 'Character' and it must not be counted under 'Hero'.
    expect(results).toEqual([]);
  });

  it('includes a multi-label node under its chosen label', async () => {
    const db = mockDb([
      {
        elementId: '4:a:11',
        properties: { name: 'odysseus' },
        labels: ['Hero', 'Character'],
        title: null,
        timestamp: null,
        rawDescription: null,
      },
    ]);

    const results = await listNodesForMarkdownIndex(db, 'Character', fieldsConfig(), textPropertiesConfig(), config());

    expect(results).toHaveLength(1);
  });

  it('respects mode.markdown.labels ordering for the chosen label when listing', async () => {
    const db = mockDb([
      {
        elementId: '4:a:12',
        properties: { name: 'odysseus' },
        labels: ['Character', 'Hero'],
        title: null,
        timestamp: null,
        rawDescription: null,
      },
    ]);
    const cfg = config({
      mode: { type: 'markdown', markdown: { ...DEFAULT_MARKDOWN_MODE_CONFIG, labels: ['Hero', 'Character'] } },
    });

    const underHero = await listNodesForMarkdownIndex(db, 'Hero', fieldsConfig(), textPropertiesConfig(), cfg);
    const underCharacter = await listNodesForMarkdownIndex(
      db,
      'Character',
      fieldsConfig(),
      textPropertiesConfig(),
      cfg
    );

    expect(underHero).toHaveLength(1);
    expect(underCharacter).toHaveLength(0);
  });

  it('prefers the configured label order even when the alphabetically-first label is excluded from mode.markdown.labels', async () => {
    // Alphabetically, 'Character' < 'Hero', so an unconfigured lookup would
    // pick 'Character'. Here mode.markdown.labels only mounts 'Hero', so the
    // node must resolve to 'Hero' — the configured order wins outright, not
    // merely as a tie-breaker among mounted labels only.
    const db = mockDb([
      {
        elementId: '4:a:13',
        properties: { name: 'odysseus' },
        labels: ['Character', 'Hero'],
        title: null,
        timestamp: null,
        rawDescription: null,
      },
    ]);
    const cfg = config({
      mode: { type: 'markdown', markdown: { ...DEFAULT_MARKDOWN_MODE_CONFIG, labels: ['Hero'] } },
    });

    const underHero = await listNodesForMarkdownIndex(db, 'Hero', fieldsConfig(), textPropertiesConfig(), cfg);
    const underCharacter = await listNodesForMarkdownIndex(
      db,
      'Character',
      fieldsConfig(),
      textPropertiesConfig(),
      cfg
    );

    expect(underHero).toHaveLength(1);
    expect(underCharacter).toHaveLength(0);
  });
});
