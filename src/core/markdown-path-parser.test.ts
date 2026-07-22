/**
 * Tests for LPGFS Markdown-Mode Path Parser
 */

import { describe, it, expect } from 'vitest';
import { parseMarkdownPath } from './markdown-path-parser.js';
import { LpgfsError, POSIX_ERRORS } from '../types/index.js';

describe('parseMarkdownPath', () => {
  describe('root path', () => {
    it('should parse "/" as root', () => {
      expect(parseMarkdownPath('/')).toEqual({ type: 'root' });
    });

    it('should handle trailing slashes', () => {
      expect(parseMarkdownPath('//')).toEqual({ type: 'root' });
    });
  });

  describe('root generated files', () => {
    it('should parse /index.md as root-index', () => {
      expect(parseMarkdownPath('/index.md')).toEqual({ type: 'root-index' });
    });

    it('should parse /log.md as root-log', () => {
      expect(parseMarkdownPath('/log.md')).toEqual({ type: 'root-log' });
    });
  });

  describe('label directory', () => {
    it('should parse /<Label> as label', () => {
      expect(parseMarkdownPath('/Character')).toEqual({
        type: 'label',
        label: 'Character',
      });
    });
  });

  describe('per-label generated index', () => {
    it('should parse /<Label>/index.md as label-index', () => {
      expect(parseMarkdownPath('/Character/index.md')).toEqual({
        type: 'label-index',
        label: 'Character',
      });
    });
  });

  describe('node file', () => {
    it('should parse /<Label>/<name>.md as node with .md stripped', () => {
      expect(parseMarkdownPath('/Character/odysseus.md')).toEqual({
        type: 'node',
        label: 'Character',
        nodeName: 'odysseus',
      });
    });

    it('should only strip the trailing .md extension', () => {
      expect(parseMarkdownPath('/Place/ithaca.island.md')).toEqual({
        type: 'node',
        label: 'Place',
        nodeName: 'ithaca.island',
      });
    });
  });

  describe('paths deeper than a node file', () => {
    it('should return ENOENT for a path with 3 segments', () => {
      expect(() => parseMarkdownPath('/Character/odysseus.md/extra')).toThrow(LpgfsError);
    });

    it('should return ENOENT with POSIX ENOENT code for a deep path', () => {
      try {
        parseMarkdownPath('/Character/odysseus.md/extra');
        expect.fail('expected parseMarkdownPath to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.ENOENT);
      }
    });
  });

  describe('malformed paths', () => {
    it('should return ENOENT for a node path missing the .md extension', () => {
      expect(() => parseMarkdownPath('/Character/odysseus')).toThrow(LpgfsError);
    });

    it('should return ENOENT for a node path with only the .md extension', () => {
      expect(() => parseMarkdownPath('/Character/.md')).toThrow(LpgfsError);
    });

    it('should return ENOENT for an interior empty segment', () => {
      expect(() => parseMarkdownPath('/Character//odysseus.md')).toThrow(LpgfsError);
    });

    it('should return ENOENT for a trailing empty segment before a label', () => {
      expect(() => parseMarkdownPath('//odysseus.md')).toThrow(LpgfsError);
    });
  });
});
