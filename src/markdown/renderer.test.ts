/**
 * Tests for the pure markdown-mode node renderer.
 */

import { describe, it, expect } from 'vitest';
import {
  renderNodeMarkdown,
  passthroughFieldResolver,
  type FieldResolver,
  type MarkdownRelationshipLink,
} from './renderer.js';
import { DEFAULT_MARKDOWN_MODE_CONFIG, type MarkdownModeConfig, type Properties } from '../types/index.js';

function config(overrides: Partial<MarkdownModeConfig> = {}): MarkdownModeConfig {
  return {
    ...DEFAULT_MARKDOWN_MODE_CONFIG,
    ...overrides,
    textProperties: {
      ...DEFAULT_MARKDOWN_MODE_CONFIG.textProperties,
      ...overrides.textProperties,
    },
    fields: {
      ...DEFAULT_MARKDOWN_MODE_CONFIG.fields,
      ...overrides.fields,
    },
  };
}

describe('renderNodeMarkdown', () => {
  it('emits type first, then remaining properties alphabetically', () => {
    const properties: Properties = { zebra: 'z', apple: 'a', middle: 'm' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toBe('---\ntype: Person\napple: a\nmiddle: m\nzebra: z\n---\n');
  });

  it('drops a property literally named "type" without duplicating the key', () => {
    const properties: Properties = { type: 'SomeValue', name: 'Alice' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toContain('type: Person\n');
    expect(result).not.toContain('SomeValue');
  });

  it('places mapped fields between type and remaining properties', () => {
    const properties: Properties = { updated: '2026-01-01', zebra: 'z' };
    const resolver: FieldResolver = {
      resolve: () => ({
        title: 'A Title',
        timestamp: '2026-01-01T00:00:00.000Z',
        tags: ['a', 'b'],
        consumedProperties: new Set(['updated']),
      }),
    };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
      fieldResolver: resolver,
    });

    const lines = result.split('\n');
    expect(lines.indexOf('type: Person')).toBeLessThan(lines.indexOf('title: A Title'));
    expect(lines.indexOf('title: A Title')).toBeLessThan(lines.indexOf('timestamp: 2026-01-01T00:00:00.000Z'));
    // updated was consumed by the resolver, so it must not appear again
    expect(result).not.toContain('updated:');
    expect(result).toContain('zebra: z');
  });

  it('serializes Neo4j Integer/Float-transformed numeric properties as plain numbers', () => {
    const properties: Properties = { age: 42, score: 3.14 };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toContain('age: 42');
    expect(result).toContain('score: 3.14');
  });

  it('serializes a temporal-transformed nested object property', () => {
    // Mirrors the shape produced by db/connection.ts's generic object
    // transform for Neo4j temporal values (Integer sub-fields already
    // converted to plain numbers upstream).
    const properties: Properties = {
      createdAt: { year: 2026, month: 1, day: 15 },
    };
    const result = renderNodeMarkdown({
      labels: ['Event'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toContain('createdAt:\n  year: 2026\n  month: 1\n  day: 15\n');
  });

  it('serializes a point-transformed nested object property', () => {
    const properties: Properties = {
      location: { x: 1.5, y: 2.5, srid: 4326 },
    };
    const result = renderNodeMarkdown({
      labels: ['Place'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toContain('location:\n  x: 1.5\n  y: 2.5\n  srid: 4326\n');
  });

  it('serializes list properties as a YAML list', () => {
    const properties: Properties = { aliases: ['Bob', 'Bobby'] };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
    });

    expect(result).toContain('aliases:\n  - Bob\n  - Bobby\n');
  });

  it('renders outgoing relationship links with wikilink style, quoted', () => {
    const relationships: MarkdownRelationshipLink[] = [
      { type: 'KNOWS', direction: 'OUT', targetLabel: 'Person', targetName: 'bob' },
      { type: 'KNOWS', direction: 'OUT', targetLabel: 'Person', targetName: 'alice' },
    ];
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties: {},
      relationships,
      config: config({ linkStyle: 'wikilink' }),
    });

    // alphabetical target order: alice before bob
    expect(result).toContain('KNOWS:\n  - "[[Person/alice]]"\n  - "[[Person/bob]]"\n');
  });

  it('renders outgoing relationship links with markdown style, unquoted path', () => {
    const relationships: MarkdownRelationshipLink[] = [
      { type: 'KNOWS', direction: 'OUT', targetLabel: 'Person', targetName: 'alice' },
    ];
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties: {},
      relationships,
      config: config({ linkStyle: 'markdown' }),
    });

    expect(result).toContain('KNOWS:\n  - /Person/alice.md\n');
  });

  it('omits incoming relationships by default (includeIncoming: false)', () => {
    const relationships: MarkdownRelationshipLink[] = [
      { type: 'KNOWS', direction: 'IN', targetLabel: 'Person', targetName: 'carol' },
    ];
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties: {},
      relationships,
      config: config({ includeIncoming: false }),
    });

    expect(result).not.toContain('in_KNOWS');
    expect(result).not.toContain('carol');
  });

  it('renders incoming relationships under in_<TYPE> when includeIncoming: true', () => {
    const relationships: MarkdownRelationshipLink[] = [
      { type: 'KNOWS', direction: 'IN', targetLabel: 'Person', targetName: 'carol' },
      { type: 'KNOWS', direction: 'OUT', targetLabel: 'Person', targetName: 'alice' },
    ];
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties: {},
      relationships,
      config: config({ includeIncoming: true }),
    });

    expect(result).toContain('in_KNOWS:\n  - "[[Person/carol]]"\n');
    expect(result).toContain('KNOWS:\n  - "[[Person/alice]]"\n');
  });

  it('renders a bare body for a single present text property', () => {
    const properties: Properties = { summary: 'A short summary.' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config({ textProperties: { default: ['summary', 'text'] } }),
    });

    expect(result.endsWith('\nA short summary.\n')).toBe(true);
    expect(result).not.toContain('## summary');
  });

  it('renders ## headings for multiple present text properties, in config order', () => {
    const properties: Properties = { text: 'Body text.', summary: 'A short summary.' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config({ textProperties: { default: ['summary', 'text'] } }),
    });

    const bodyStart = result.indexOf('## summary');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(result.indexOf('## text')).toBeGreaterThan(bodyStart);
    expect(result).toContain('## summary\n\nA short summary.\n\n## text\n\nBody text.\n');
  });

  it('renders frontmatter-only with an empty body when no text properties are present', () => {
    const properties: Properties = { name: 'Alice' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config({ textProperties: { default: ['summary', 'text'] } }),
    });

    expect(result).toBe('---\ntype: Person\nname: Alice\n---\n');
  });

  it('applies per-label textProperties overrides', () => {
    const properties: Properties = { description: 'Character description.', summary: 'Not used here.' };
    const result = renderNodeMarkdown({
      labels: ['Character'],
      properties,
      relationships: [],
      config: config({
        textProperties: {
          default: ['summary'],
          overrides: { Character: ['description'] },
        },
      }),
    });

    // "description" is the configured text property for Character, so it
    // moves to the (bare, single-section) body and is excluded from frontmatter.
    expect(result).not.toContain('description:');
    expect(result).not.toContain('## description');
    expect(result.endsWith('\nCharacter description.\n')).toBe(true);
    // "summary" is not the configured text property for Character, so it stays as frontmatter
    expect(result).toContain('summary: Not used here.');
  });

  it('excludes configured text properties from frontmatter even when moved to the body', () => {
    const properties: Properties = { summary: 'Body content.', name: 'Alice' };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config({ textProperties: { default: ['summary'] } }),
    });

    expect(result).not.toContain('summary:');
    expect(result).toContain('name: Alice');
    expect(result.endsWith('\nBody content.\n')).toBe(true);
  });

  it('does not let an unconsumed same-named property overwrite a resolved mapped field', () => {
    const properties: Properties = { title: 'Literal Title Property' };
    const resolver: FieldResolver = {
      resolve: () => ({
        title: 'Resolved Title',
        // Deliberately does NOT include 'title' in consumedProperties, to
        // simulate a fields.overrides fallback list that omits the
        // canonical key name itself.
        consumedProperties: new Set(),
      }),
    };
    const result = renderNodeMarkdown({
      labels: ['Person'],
      properties,
      relationships: [],
      config: config(),
      fieldResolver: resolver,
    });

    expect(result).toContain('title: Resolved Title');
    expect(result).not.toContain('Literal Title Property');
  });

  it('uses the passthroughFieldResolver by default (no mapped fields emitted)', () => {
    const resolved = passthroughFieldResolver.resolve(['Person'], {}, DEFAULT_MARKDOWN_MODE_CONFIG.fields);
    expect(resolved.title).toBeUndefined();
    expect(resolved.timestamp).toBeUndefined();
    expect(resolved.tags).toBeUndefined();
    expect(resolved.consumedProperties.size).toBe(0);
  });
});
