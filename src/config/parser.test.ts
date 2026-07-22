/**
 * Tests for LPGFS Config Parser
 */

import { describe, it, expect } from 'vitest';
import { ConfigParser, ConfigValidationError } from './parser.js';
import { DEFAULT_CONFIG } from '../types/index.js';

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
