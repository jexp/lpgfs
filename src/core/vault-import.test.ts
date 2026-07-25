/**
 * Unit tests for the lpgfs-import-vault CLI's pure parsing/graph-building
 * logic (task-020). No live database; vault content is written to a
 * temp directory so walkVault/buildVaultGraph exercise real fs calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  walkVault,
  splitFrontmatterAndBody,
  splitBodySections,
  parseLinkTarget,
  invertFrontmatter,
  applyBodySections,
  resolveNamingProperty,
  parseConceptFile,
  buildVaultGraph,
} from './vault-import.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema, type Properties } from '../types/index.js';

const ODYSSEY_CONFIG: ConfigSchema = {
  ...DEFAULT_CONFIG,
  naming: {
    default: 'elementId',
    overrides: {
      nodes: {
        Character: { property: 'name' },
        Place: { property: 'name' },
      },
    },
  },
  mode: {
    type: 'markdown',
    markdown: {
      ...DEFAULT_MARKDOWN_MODE_CONFIG,
      labels: ['Character', 'Place'],
    },
  },
};

describe('splitFrontmatterAndBody', () => {
  it('splits frontmatter and a single-line body', () => {
    const raw = '---\ntype: Character\nname: Circe\n---\n\nA goddess-sorceress.\n';
    const { frontmatter, body } = splitFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({ type: 'Character', name: 'Circe' });
    expect(body).toBe('A goddess-sorceress.');
  });

  it('returns an empty body when the frontmatter block has no trailing content', () => {
    const raw = '---\ntype: Character\ntitle: Eumaeus\n---\n';
    const { frontmatter, body } = splitFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({ type: 'Character', title: 'Eumaeus' });
    expect(body).toBe('');
  });

  it('preserves multi-section body text verbatim', () => {
    const raw = '---\ntype: Character\n---\n\n## summary\n\nKing of Ithaca.\n\n## content\n\nWandered for ten years.\n';
    const { body } = splitFrontmatterAndBody(raw);
    expect(body).toBe('## summary\n\nKing of Ithaca.\n\n## content\n\nWandered for ten years.');
  });
});

describe('splitBodySections', () => {
  it('returns no sections for empty body', () => {
    expect(splitBodySections('')).toEqual([]);
  });

  it('returns a single unnamed section when there are no headings', () => {
    expect(splitBodySections('A goddess-sorceress.')).toEqual([{ text: 'A goddess-sorceress.' }]);
  });

  it('splits multiple ## <heading> sections', () => {
    const body = '## summary\n\nKing of Ithaca.\n\n## content\n\nWandered for ten years.';
    expect(splitBodySections(body)).toEqual([
      { heading: 'summary', text: 'King of Ithaca.' },
      { heading: 'content', text: 'Wandered for ten years.' },
    ]);
  });
});

describe('parseLinkTarget', () => {
  it('parses a wikilink', () => {
    expect(parseLinkTarget('[[Place/Aeaea]]')).toEqual({ label: 'Place', name: 'Aeaea' });
  });

  it('parses a bundle-relative markdown link', () => {
    expect(parseLinkTarget('/Place/Aeaea.md')).toEqual({ label: 'Place', name: 'Aeaea' });
  });

  it('returns null for a non-link string', () => {
    expect(parseLinkTarget('Circe')).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(parseLinkTarget(42)).toBeNull();
    expect(parseLinkTarget(['[[Place/Aeaea]]'])).toBeNull();
  });
});

describe('invertFrontmatter', () => {
  it('drops the type key and uses it as the label', () => {
    const result = invertFrontmatter({ type: 'Character', name: 'Odysseus' }, 'Character');
    expect(result.label).toBe('Character');
    expect(result.properties).toEqual({ name: 'Odysseus' });
  });

  it('falls back to the directory label when type is missing', () => {
    const result = invertFrontmatter({ name: 'Odysseus' }, 'Character');
    expect(result.label).toBe('Character');
  });

  it('restores the original type property when type_property is present (task-013 inversion)', () => {
    const result = invertFrontmatter(
      { type: 'Character', type_property: 'Sorceress', name: 'Circe' },
      'Character'
    );
    expect(result.label).toBe('Character');
    expect(result.properties).toEqual({ type: 'Sorceress', name: 'Circe' });
  });

  it('keeps mapped fields under their literal canonical keys', () => {
    const result = invertFrontmatter(
      { type: 'Character', title: 'Enchantress of Aeaea', timestamp: '2026-03-15T15:00:00Z', tags: ['a', 'b'] },
      'Character'
    );
    expect(result.properties).toEqual({
      title: 'Enchantress of Aeaea',
      timestamp: '2026-03-15T15:00:00Z',
      tags: ['a', 'b'],
    });
  });

  it('recognizes an array of wikilinks as an OUT relationship', () => {
    const result = invertFrontmatter({ type: 'Character', RULES: ['[[Place/Ithaca]]'] }, 'Character');
    expect(result.relationships).toEqual([
      { type: 'RULES', direction: 'OUT', targets: [{ label: 'Place', name: 'Ithaca' }] },
    ]);
    expect(result.properties).toEqual({});
  });

  it('recognizes a single scalar link value', () => {
    const result = invertFrontmatter({ type: 'Character', RULES: '[[Place/Ithaca]]' }, 'Character');
    expect(result.relationships).toEqual([
      { type: 'RULES', direction: 'OUT', targets: [{ label: 'Place', name: 'Ithaca' }] },
    ]);
  });

  it('recognizes bundle-relative markdown links too, regardless of configured linkStyle', () => {
    const result = invertFrontmatter({ type: 'Character', RULES: ['/Place/Ithaca.md'] }, 'Character');
    expect(result.relationships).toEqual([
      { type: 'RULES', direction: 'OUT', targets: [{ label: 'Place', name: 'Ithaca' }] },
    ]);
  });

  it('resolves an in_<TYPE> key to an IN direction relationship', () => {
    const result = invertFrontmatter({ type: 'Character', in_AWAITS: ['[[Character/Penelope]]'] }, 'Character');
    expect(result.relationships).toEqual([
      { type: 'AWAITS', direction: 'IN', targets: [{ label: 'Character', name: 'Penelope' }] },
    ]);
  });

  it('treats a non-link array value as a plain property, not a relationship', () => {
    const result = invertFrontmatter({ type: 'Character', tags2: ['loyalty', 'patience'] }, 'Character');
    expect(result.relationships).toEqual([]);
    expect(result.properties).toEqual({ tags2: ['loyalty', 'patience'] });
  });

  it('treats an empty array value as a plain property, not a relationship', () => {
    const result = invertFrontmatter({ type: 'Character', EMPTYREL: [] }, 'Character');
    expect(result.relationships).toEqual([]);
    expect(result.properties).toEqual({ EMPTYREL: [] });
  });
});

describe('applyBodySections', () => {
  it('writes a single unnamed section to the label\'s first configured text property', () => {
    const properties: Properties = {};
    applyBodySections(properties, [{ text: 'A goddess-sorceress.' }], DEFAULT_MARKDOWN_MODE_CONFIG, 'Character');
    expect(properties).toEqual({ summary: 'A goddess-sorceress.' });
  });

  it('writes multiple headed sections to their named properties', () => {
    const properties: Properties = {};
    applyBodySections(
      properties,
      [
        { heading: 'summary', text: 'King of Ithaca.' },
        { heading: 'content', text: 'Wandered for ten years.' },
      ],
      DEFAULT_MARKDOWN_MODE_CONFIG,
      'Character'
    );
    expect(properties).toEqual({ summary: 'King of Ithaca.', content: 'Wandered for ten years.' });
  });

  it('is a no-op for an empty section list', () => {
    const properties: Properties = { existing: 'value' };
    applyBodySections(properties, [], DEFAULT_MARKDOWN_MODE_CONFIG, 'Character');
    expect(properties).toEqual({ existing: 'value' });
  });
});

describe('resolveNamingProperty', () => {
  it('uses the configured per-label override', () => {
    expect(resolveNamingProperty(ODYSSEY_CONFIG, 'Character')).toBe('name');
  });

  it('defaults to "name" when no override is configured for the label', () => {
    expect(resolveNamingProperty(ODYSSEY_CONFIG, 'Creature')).toBe('name');
  });
});

describe('parseConceptFile', () => {
  it('produces the exact property/relationship set for the Circe fixture file', () => {
    const raw =
      '---\n' +
      'type: Character\n' +
      'type_property: Sorceress\n' +
      'title: Enchantress of Aeaea\n' +
      'timestamp: 2026-03-15T15:00:00Z\n' +
      'tags:\n' +
      '  - sorceress\n' +
      '  - divine\n' +
      'name: Circe\n' +
      'RULES:\n' +
      '  - "[[Place/Aeaea]]"\n' +
      '---\n' +
      '\n' +
      'A goddess-sorceress who transforms sailors into swine on her island.\n';

    const result = parseConceptFile(raw, 'Character', 'Circe', ODYSSEY_CONFIG);

    expect(result.label).toBe('Character');
    expect(result.properties).toEqual({
      type: 'Sorceress',
      title: 'Enchantress of Aeaea',
      timestamp: '2026-03-15T15:00:00Z',
      tags: ['sorceress', 'divine'],
      name: 'Circe',
      summary: 'A goddess-sorceress who transforms sailors into swine on her island.',
    });
    expect(result.relationships).toEqual([
      { type: 'RULES', direction: 'OUT', targets: [{ label: 'Place', name: 'Aeaea' }] },
    ]);
  });

  it('produces an empty body and title-from-filename for the Eumaeus fixture file', () => {
    const raw =
      '---\n' +
      'type: Character\n' +
      'title: Eumaeus\n' +
      'role: swineherd\n' +
      'RESIDES_IN:\n' +
      '  - "[[Place/Ithaca]]"\n' +
      'SERVES:\n' +
      '  - "[[Character/Odysseus]]"\n' +
      '---\n';

    const result = parseConceptFile(raw, 'Character', 'Eumaeus', ODYSSEY_CONFIG);

    expect(result.properties).toEqual({
      title: 'Eumaeus',
      role: 'swineherd',
      name: 'Eumaeus',
    });
    expect(result.relationships).toEqual([
      { type: 'RESIDES_IN', direction: 'OUT', targets: [{ label: 'Place', name: 'Ithaca' }] },
      { type: 'SERVES', direction: 'OUT', targets: [{ label: 'Character', name: 'Odysseus' }] },
    ]);
  });

  it('splits a multi-section body across named properties', () => {
    const raw =
      '---\n' +
      'type: Character\n' +
      '---\n' +
      '\n' +
      '## summary\n' +
      '\n' +
      'King of Ithaca.\n' +
      '\n' +
      '## content\n' +
      '\n' +
      'Wandered for ten years.\n';

    const result = parseConceptFile(raw, 'Character', 'Odysseus', ODYSSEY_CONFIG);
    expect(result.properties.summary).toBe('King of Ithaca.');
    expect(result.properties.content).toBe('Wandered for ten years.');
  });
});

describe('walkVault / buildVaultGraph (real filesystem)', () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'lpgfs-vault-import-test-'));
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  function writeConcept(label: string, name: string, content: string): void {
    const dir = join(vaultRoot, label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content, 'utf-8');
  }

  it('skips reserved index.md/log.md files at every directory level', () => {
    writeFileSync(join(vaultRoot, 'index.md'), '---\ntype: Root\n---\n', 'utf-8');
    writeFileSync(join(vaultRoot, 'log.md'), '---\ntype: Root\n---\n', 'utf-8');
    writeConcept('Character', 'index', '---\ntype: Character\n---\n');
    writeConcept('Character', 'log', '---\ntype: Character\n---\n');
    writeConcept('Character', 'Odysseus', '---\ntype: Character\nname: Odysseus\n---\n');

    const files = walkVault(vaultRoot);
    expect(files).toEqual([{ label: 'Character', name: 'Odysseus', filePath: join(vaultRoot, 'Character', 'Odysseus.md') }]);
  });

  it('ignores non-.md files and non-directory entries at the vault root', () => {
    writeFileSync(join(vaultRoot, '.lpgfs.yaml'), 'naming:\n  default: elementId\n', 'utf-8');
    writeConcept('Character', 'Odysseus', '---\ntype: Character\n---\n');
    writeFileSync(join(vaultRoot, 'Character', 'notes.txt'), 'ignore me', 'utf-8');

    const files = walkVault(vaultRoot);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('Odysseus');
  });

  it('builds a graph with nodes MERGE-keyed on the naming property and relationships resolved across files', () => {
    writeConcept(
      'Character',
      'Odysseus',
      '---\ntype: Character\ntitle: King of Ithaca\nRULES:\n  - "[[Place/Ithaca]]"\n---\n\nProtagonist.\n'
    );
    writeConcept('Place', 'Ithaca', '---\ntype: Place\ntitle: Ithaca\n---\n\nA rocky island.\n');

    const graph = buildVaultGraph(vaultRoot, ODYSSEY_CONFIG, (path) => readFileSync(path, 'utf-8'));

    expect(graph.nodes).toHaveLength(2);
    const odysseus = graph.nodes.find((n) => n.name === 'Odysseus')!;
    expect(odysseus.label).toBe('Character');
    expect(odysseus.namingProperty).toBe('name');
    expect(odysseus.properties.name).toBe('Odysseus');
    expect(odysseus.properties.title).toBe('King of Ithaca');
    expect(odysseus.properties.summary).toBe('Protagonist.');

    expect(graph.relationships).toEqual([
      { fromLabel: 'Character', fromName: 'Odysseus', type: 'RULES', toLabel: 'Place', toName: 'Ithaca' },
    ]);
  });

  it('normalizes an in_<TYPE> key into a reversed OUT-direction relationship from the target', () => {
    writeConcept('Character', 'Penelope', '---\ntype: Character\nin_AWAITS:\n  - "[[Character/Odysseus]]"\n---\n');

    const graph = buildVaultGraph(vaultRoot, ODYSSEY_CONFIG, (path) => readFileSync(path, 'utf-8'));

    expect(graph.relationships).toEqual([
      { fromLabel: 'Character', fromName: 'Odysseus', type: 'AWAITS', toLabel: 'Character', toName: 'Penelope' },
    ]);
  });
});
