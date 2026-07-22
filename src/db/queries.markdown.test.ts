/**
 * Unit tests for groupRelationshipsForMarkdown — the pure grouping/sorting/
 * naming-resolution helper for getNodeForMarkdown's raw query rows.
 *
 * No live DB needed: rows are constructed by hand to stand in for what
 * getNodeForMarkdown's Cypher query would return.
 */

import { describe, it, expect } from 'vitest';
import { groupRelationshipsForMarkdown, chooseNodeLabel, type MarkdownRelationshipRow } from './queries.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema } from '../types/index.js';

function config(overrides: Partial<ConfigSchema> = {}): ConfigSchema {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function row(overrides: Partial<MarkdownRelationshipRow> = {}): MarkdownRelationshipRow {
  return {
    relType: 'KNOWS',
    direction: 'OUT',
    targetLabels: ['Person'],
    targetElementId: '4:abc:0',
    targetProperties: {},
    ...overrides,
  };
}

describe('groupRelationshipsForMarkdown', () => {
  it('returns an empty array for a node with no relationships', () => {
    expect(groupRelationshipsForMarkdown([], config())).toEqual([]);
  });

  it('groups one-directional-only relationships under the bare type key', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ relType: 'KNOWS', direction: 'OUT', targetElementId: '4:abc:1' }),
      row({ relType: 'KNOWS', direction: 'OUT', targetElementId: '4:abc:2' }),
    ];

    const groups = groupRelationshipsForMarkdown(rows, config());

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('KNOWS');
    expect(groups[0]!.links).toHaveLength(2);
    expect(groups[0]!.links.every((link) => link.direction === 'OUT')).toBe(true);
  });

  it('prefixes incoming-only relationships with in_ and keeps them separate from outgoing', () => {
    const rows: MarkdownRelationshipRow[] = [row({ relType: 'KNOWS', direction: 'IN' })];

    const groups = groupRelationshipsForMarkdown(rows, config());

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('in_KNOWS');
    expect(groups[0]!.links[0]!.direction).toBe('IN');
  });

  it('groups multiple relationship types in both directions into distinct sorted groups', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ relType: 'WORKS_AT', direction: 'OUT', targetElementId: '4:c:0', targetLabels: ['Company'] }),
      row({ relType: 'KNOWS', direction: 'OUT', targetElementId: '4:p:1' }),
      row({ relType: 'KNOWS', direction: 'IN', targetElementId: '4:p:2' }),
      row({ relType: 'WORKS_AT', direction: 'IN', targetElementId: '4:c:3', targetLabels: ['Company'] }),
    ];

    const groups = groupRelationshipsForMarkdown(rows, config());

    // Group keys sorted alphabetically: KNOWS, WORKS_AT, in_KNOWS, in_WORKS_AT
    expect(groups.map((g) => g.key)).toEqual(['KNOWS', 'WORKS_AT', 'in_KNOWS', 'in_WORKS_AT']);
    for (const group of groups) {
      expect(group.links).toHaveLength(1);
    }
    expect(groups.find((g) => g.key === 'KNOWS')!.links[0]!.direction).toBe('OUT');
    expect(groups.find((g) => g.key === 'in_KNOWS')!.links[0]!.direction).toBe('IN');
  });

  it('sorts targets within a group by label then by resolved name', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ targetElementId: '4:p:1', targetProperties: { name: 'zeta' } }),
      row({ targetElementId: '4:p:2', targetProperties: { name: 'alpha' } }),
      row({ targetElementId: '4:c:3', targetLabels: ['Company'], targetProperties: { name: 'acme' } }),
    ];
    const cfg = config({
      naming: {
        default: 'elementId',
        overrides: {
          nodes: { Person: { property: 'name' }, Company: { property: 'name' } },
        },
      },
    });

    const groups = groupRelationshipsForMarkdown(rows, cfg);

    expect(groups).toHaveLength(1);
    const names = groups[0]!.links.map((l) => `${l.targetLabel}/${l.targetName}`);
    expect(names).toEqual(['Company/acme', 'Person/alpha', 'Person/zeta']);
  });

  it('resolves elementId-strategy names when no naming override is configured', () => {
    const rows: MarkdownRelationshipRow[] = [row({ targetElementId: '4:abc:7' })];

    const groups = groupRelationshipsForMarkdown(rows, config());

    expect(groups[0]!.links[0]!.targetName).toBe('4_abc_7');
  });

  it('falls back to the elementId when the naming property is missing on the target', () => {
    const rows: MarkdownRelationshipRow[] = [row({ targetElementId: '4:abc:9', targetProperties: {} })];
    const cfg = config({
      naming: { default: 'elementId', overrides: { nodes: { Person: { property: 'name' } } } },
    });

    const groups = groupRelationshipsForMarkdown(rows, cfg);

    expect(groups[0]!.links[0]!.targetName).toBe('4_abc_9');
  });

  it('suffixes a colliding target name across relationships of the same label regardless of type/direction', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ relType: 'KNOWS', direction: 'OUT', targetElementId: '4:p:1', targetProperties: { name: 'alice' } }),
      row({ relType: 'WORKS_AT', direction: 'IN', targetElementId: '4:p:2', targetProperties: { name: 'alice' } }),
    ];
    const cfg = config({
      naming: { default: 'elementId', overrides: { nodes: { Person: { property: 'name' } } } },
    });

    const groups = groupRelationshipsForMarkdown(rows, cfg);

    const knows = groups.find((g) => g.key === 'KNOWS')!.links[0]!;
    const worksAt = groups.find((g) => g.key === 'in_WORKS_AT')!.links[0]!;
    expect(knows.targetName).toBe('alice');
    expect(worksAt.targetName).toBe('alice_4_p_2');
  });

  it('resolves a link to a multi-label target under its chosen label, not the raw label order', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ targetElementId: '4:h:0', targetLabels: ['Hero', 'Character'], targetProperties: {} }),
    ];

    const groups = groupRelationshipsForMarkdown(rows, config());

    expect(groups[0]!.links[0]!.targetLabel).toBe('Character');
  });

  it('resolves a link to a multi-label target under the first configured label when mode.markdown.labels is set', () => {
    const rows: MarkdownRelationshipRow[] = [
      row({ targetElementId: '4:h:0', targetLabels: ['Character', 'Hero'], targetProperties: {} }),
    ];
    const cfg = config({
      mode: {
        type: 'markdown',
        markdown: { ...DEFAULT_MARKDOWN_MODE_CONFIG, labels: ['Hero', 'Character'] },
      },
    });

    const groups = groupRelationshipsForMarkdown(rows, cfg);

    expect(groups[0]!.links[0]!.targetLabel).toBe('Hero');
  });
});

describe('chooseNodeLabel', () => {
  it('picks the alphabetically-first label when no configured order is given', () => {
    expect(chooseNodeLabel(['Hero', 'Character'])).toBe('Character');
  });

  it('picks the first label from the configured order that the node actually carries', () => {
    expect(chooseNodeLabel(['Hero', 'Character'], ['Hero', 'Character'])).toBe('Hero');
    expect(chooseNodeLabel(['Hero', 'Character'], ['Place', 'Character', 'Hero'])).toBe('Character');
  });

  it('falls back to alphabetical order when none of the node labels appear in the configured order', () => {
    expect(chooseNodeLabel(['Hero', 'Character'], ['Place', 'Creature'])).toBe('Character');
  });

  it('is deterministic given the same inputs', () => {
    const a = chooseNodeLabel(['Zeta', 'Alpha', 'Mu']);
    const b = chooseNodeLabel(['Zeta', 'Alpha', 'Mu']);
    expect(a).toBe(b);
    expect(a).toBe('Alpha');
  });

  it('returns the single label unchanged for a single-label node', () => {
    expect(chooseNodeLabel(['Character'])).toBe('Character');
    expect(chooseNodeLabel(['Character'], ['Hero'])).toBe('Character');
  });
});
