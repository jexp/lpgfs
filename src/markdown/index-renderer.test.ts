/**
 * Tests for the pure root/label index.md renderers.
 */

import { describe, it, expect } from 'vitest';
import { renderRootIndex, renderLabelIndex, OKF_VERSION } from './index-renderer.js';
import type { MarkdownIndexNodeResult } from '../db/queries.js';

function node(overrides: Partial<MarkdownIndexNodeResult> = {}): MarkdownIndexNodeResult {
  return {
    name: 'odysseus',
    elementId: '4:a:0',
    title: undefined,
    timestamp: undefined,
    description: null,
    ...overrides,
  };
}

describe('renderRootIndex', () => {
  it('emits okf_version frontmatter with no type key and a section per rendered label', () => {
    const result = renderRootIndex(['Place', 'Character'], 'markdown');

    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain(`okf_version: "${OKF_VERSION}"\n`);
    expect(result).not.toMatch(/^type:/m);
    // sections are sorted, regardless of input order
    const characterIdx = result.indexOf('## Character');
    const placeIdx = result.indexOf('## Place');
    expect(characterIdx).toBeGreaterThan(-1);
    expect(placeIdx).toBeGreaterThan(characterIdx);
  });

  it('links each label section to that label\'s own index.md, using markdown link style', () => {
    const result = renderRootIndex(['Character'], 'markdown');
    expect(result).toContain('- /Character/index.md');
  });

  it('links each label section using wikilink style, quoted for YAML-safety within the section body', () => {
    const result = renderRootIndex(['Character'], 'wikilink');
    expect(result).toContain('- [[Character/index]]');
  });

  it('renders a minimal valid file when there are no rendered labels at all', () => {
    const result = renderRootIndex([], 'markdown');
    expect(result).toBe(`---\nokf_version: "${OKF_VERSION}"\n---\n\n`);
  });
});

describe('renderLabelIndex', () => {
  it('has no frontmatter block', () => {
    const result = renderLabelIndex('Character', [node()], 'markdown');
    expect(result.startsWith('---')).toBe(false);
  });

  it('lists every node as a bullet link, sorted by name', () => {
    const result = renderLabelIndex(
      'Character',
      [node({ name: 'penelope', elementId: '4:a:1' }), node({ name: 'odysseus', elementId: '4:a:0' })],
      'markdown'
    );

    const odysseusIdx = result.indexOf('/Character/odysseus.md');
    const penelopeIdx = result.indexOf('/Character/penelope.md');
    expect(odysseusIdx).toBeGreaterThan(-1);
    expect(penelopeIdx).toBeGreaterThan(odysseusIdx);
  });

  it('uses wikilink style when configured', () => {
    const result = renderLabelIndex('Character', [node()], 'wikilink');
    expect(result).toContain('[[Character/odysseus]]');
  });

  it('appends a description combining mapped title and truncated text when both are derivable', () => {
    const result = renderLabelIndex(
      'Character',
      [node({ title: 'Odysseus', description: 'King of Ithaca.' })],
      'markdown'
    );
    expect(result).toContain('- /Character/odysseus.md — Odysseus — King of Ithaca.');
  });

  it('appends only the title when no text-derived description is present', () => {
    const result = renderLabelIndex('Character', [node({ title: 'Odysseus', description: null })], 'markdown');
    expect(result).toContain('- /Character/odysseus.md — Odysseus');
    expect(result).not.toContain('— Odysseus —');
  });

  it('appends only the description when no title is mapped', () => {
    const result = renderLabelIndex(
      'Character',
      [node({ title: undefined, description: 'King of Ithaca.' })],
      'markdown'
    );
    expect(result).toContain('- /Character/odysseus.md — King of Ithaca.');
  });

  it('renders a bare link when neither title nor description is derivable', () => {
    const result = renderLabelIndex('Character', [node({ title: undefined, description: null })], 'markdown');
    expect(result).toContain('- /Character/odysseus.md\n');
    expect(result).not.toContain('—');
  });

  it('stringifies a non-string mapped title', () => {
    const result = renderLabelIndex('Character', [node({ title: 42, description: null })], 'markdown');
    expect(result).toContain('- /Character/odysseus.md — 42');
  });

  it('produces a minimal valid file for an empty label rather than erroring', () => {
    const result = renderLabelIndex('Empty', [], 'markdown');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Empty');
    expect(result).not.toContain('undefined');
  });
});
