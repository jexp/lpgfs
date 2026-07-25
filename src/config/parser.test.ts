/**
 * Tests for LPGFS Config Parser
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ConfigParser, ConfigValidationError } from './parser.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('ConfigParser.parse', () => {
  it('returns defaults for empty content', () => {
    expect(ConfigParser.parse('')).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for classic-only config', () => {
    const yaml = `
naming:
  default: elementId
`;
    expect(ConfigParser.parse(yaml)).toEqual(DEFAULT_CONFIG);
  });

  it('defaults mode.type to classic when mode is absent', () => {
    const config = ConfigParser.parse('');
    expect(config.mode).toEqual({ type: 'classic' });
  });

  describe('mode.type validation', () => {
    it('accepts mode.type: markdown and fills markdown defaults', () => {
      const config = ConfigParser.parse('mode:\n  type: markdown\n');
      expect(config.mode.type).toBe('markdown');
      expect(config.mode.markdown).toEqual({
        linkStyle: 'wikilink',
        includeIncoming: false,
        textProperties: {
          default: ['summary', 'text', 'content'],
        },
        fields: {
          title: ['title', 'name'],
          timestamp: ['updated', 'lastUpdated', 'modified', 'created'],
          tags: ['tags', 'categories'],
        },
      });
    });

    it('rejects an invalid mode.type', () => {
      expect(() => ConfigParser.parse('mode:\n  type: fancy\n')).toThrow(
        ConfigValidationError
      );
    });

    it('rejects a non-object mode section', () => {
      expect(() => ConfigParser.parse('mode: markdown\n')).toThrow(
        ConfigValidationError
      );
    });
  });

  describe('mode.markdown.linkStyle validation', () => {
    it('accepts a valid linkStyle', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    linkStyle: markdown
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.linkStyle).toBe('markdown');
    });

    it('rejects an invalid linkStyle', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    linkStyle: html
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });
  });

  describe('mode.markdown.labels validation', () => {
    it('accepts a list of labels', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    labels: [Character, Location]
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.labels).toEqual(['Character', 'Location']);
    });

    it('rejects a non-array labels value', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    labels: Character
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });
  });

  describe('mode.markdown.textProperties validation', () => {
    it('accepts default and per-label overrides', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    textProperties:
      default: [summary, text]
      overrides:
        Character: [description, story]
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.textProperties).toEqual({
        default: ['summary', 'text'],
        overrides: {
          Character: ['description', 'story'],
        },
      });
    });

    it('rejects malformed textProperties.default', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    textProperties:
      default: summary
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });

    it('rejects malformed textProperties.overrides entries', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    textProperties:
      overrides:
        Character: description
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });
  });

  describe('mode.markdown.fields validation', () => {
    it('accepts field fallback lists and overrides', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    fields:
      title: [name]
      timestamp: [updated]
      tags: [tags]
      overrides:
        title:
          Character: [heroName]
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.fields).toEqual({
        title: ['name'],
        timestamp: ['updated'],
        tags: ['tags'],
        overrides: {
          title: {
            Character: ['heroName'],
          },
        },
      });
    });

    it('allows disabling a field mapping with an empty list', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    fields:
      tags: []
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.fields.tags).toEqual([]);
    });

    it('rejects malformed fields.title', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    fields:
      title: name
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });

    it('rejects malformed fields.overrides', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    fields:
      overrides:
        title: name
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });
  });

  describe('mode.markdown.includeIncoming validation', () => {
    it('accepts a boolean', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    includeIncoming: true
`;
      const config = ConfigParser.parse(yaml);
      expect(config.mode.markdown?.includeIncoming).toBe(true);
    });

    it('rejects a non-boolean', () => {
      const yaml = `
mode:
  type: markdown
  markdown:
    includeIncoming: yes-please
`;
      expect(() => ConfigParser.parse(yaml)).toThrow(ConfigValidationError);
    });
  });

  it('does not add mode.markdown when mode.type is classic and markdown section is absent', () => {
    const config = ConfigParser.parse('mode:\n  type: classic\n');
    expect(config.mode).toEqual({ type: 'classic' });
  });
});

describe('ConfigParser.applyModeOverride', () => {
  it('returns the config unchanged when cliMode is undefined', () => {
    const config = ConfigParser.parse('mode:\n  type: markdown\n');
    expect(ConfigParser.applyModeOverride(config, undefined)).toBe(config);
  });

  it('returns the config unchanged when cliMode matches the config file mode.type', () => {
    const config = ConfigParser.parse('mode:\n  type: classic\n');
    expect(ConfigParser.applyModeOverride(config, 'classic')).toBe(config);
  });

  it('overrides mode.type from classic to markdown and fills in markdown defaults', () => {
    const config = ConfigParser.parse('mode:\n  type: classic\n');
    const result = ConfigParser.applyModeOverride(config, 'markdown');

    expect(result.mode.type).toBe('markdown');
    expect(result.mode.markdown).toEqual(DEFAULT_MARKDOWN_MODE_CONFIG);
  });

  it('overrides mode.type from markdown to classic and drops the markdown section', () => {
    const config = ConfigParser.parse(
      'mode:\n  type: markdown\n  markdown:\n    linkStyle: markdown\n'
    );
    const result = ConfigParser.applyModeOverride(config, 'classic');

    expect(result.mode).toEqual({ type: 'classic' });
  });

  it('preserves an existing mode.markdown section when overriding to markdown', () => {
    const config = ConfigParser.parse('mode:\n  type: classic\n');

    // Simulate a config that already carries a markdown section under a
    // different mode.type (not reachable via the parser, but defends the
    // override logic against future callers that pre-populate it).
    const preExistingMarkdownConfig = {
      linkStyle: 'markdown' as const,
      includeIncoming: true,
      textProperties: { default: [] },
      fields: { title: [], timestamp: [], tags: [] },
    };
    const withMarkdown = {
      ...config,
      mode: { type: 'classic' as const, markdown: preExistingMarkdownConfig },
    };
    const result = ConfigParser.applyModeOverride(withMarkdown, 'markdown');

    expect(result.mode.markdown?.linkStyle).toBe('markdown');
    expect(result.mode.markdown?.includeIncoming).toBe(true);
  });

  it('does not mutate the input config object', () => {
    const config = ConfigParser.parse('mode:\n  type: classic\n');
    const original = structuredClone(config);
    ConfigParser.applyModeOverride(config, 'markdown');
    expect(config).toEqual(original);
  });
});

describe('docs/examples/markdown-mode.lpgfs.yaml', () => {
  it('parses successfully and matches the Odyssey fixture config', async () => {
    const samplePath = join(
      __dirname,
      '../../docs/examples/markdown-mode.lpgfs.yaml'
    );
    const config = await ConfigParser.load(samplePath);

    expect(config.mode.type).toBe('markdown');
    expect(config.mode.markdown?.labels).toEqual([
      'Character',
      'Place',
      'Creature',
      'Event',
    ]);
    expect(config.mode.markdown?.linkStyle).toBe('wikilink');
    expect(config.mode.markdown?.includeIncoming).toBe(false);
    expect(config.mode.markdown?.textProperties).toEqual(
      DEFAULT_MARKDOWN_MODE_CONFIG.textProperties
    );
    expect(config.mode.markdown?.fields).toEqual(
      DEFAULT_MARKDOWN_MODE_CONFIG.fields
    );
    expect(config.naming.overrides?.nodes?.Character).toEqual({
      property: 'name',
    });
    expect(config.collision?.strategy).toBe('suffix_elementId');
  });
});
