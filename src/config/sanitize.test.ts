/**
 * Tests for LPGFS Sanitization
 */

import { describe, it, expect } from 'vitest';
import { sanitize, sanitizeElementId, isValidFilename } from './sanitize.js';

describe('sanitize (classic mode)', () => {
  it('replaces default forbidden characters', () => {
    expect(sanitize('hello/world')).toBe('hello_world');
    expect(sanitize('test:file')).toBe('test_file');
    expect(sanitize('a|b')).toBe('a_b');
  });

  it('leaves markdown-only illegal characters untouched', () => {
    expect(sanitize('[note]')).toBe('[note]');
    expect(sanitize('a#b^c')).toBe('a#b^c');
  });

  it('handles null/undefined/empty values', () => {
    expect(sanitize(null)).toBe('_empty_');
    expect(sanitize(undefined as unknown as null)).toBe('_empty_');
    expect(sanitize('')).toBe('_empty_');
  });
});

describe('sanitize (markdown mode)', () => {
  it.each(['[', ']', '#', '^', '|'])(
    'replaces the markdown-illegal character %s',
    (char) => {
      const result = sanitize(`a${char}b`, undefined, 'markdown');
      expect(result).toBe('a_b');
      expect(result).not.toContain(char);
    }
  );

  it('replaces multiple markdown-illegal characters in one value', () => {
    expect(sanitize('[[note#1]]^a|b', undefined, 'markdown')).toBe(
      '__note_1___a_b'
    );
  });

  it('still applies the default replacement map', () => {
    expect(sanitize('hello/world', undefined, 'markdown')).toBe(
      'hello_world'
    );
  });

  it('respects a custom sanitization config merged with markdown additions', () => {
    const result = sanitize(
      'a[b',
      { replace: { '/': '-' } },
      'markdown'
    );
    expect(result).toBe('a_b');
  });
});

describe('sanitizeElementId', () => {
  it('sanitizes element ids in classic mode', () => {
    expect(sanitizeElementId('4:abc123:0')).toBe('4_abc123_0');
  });

  it('sanitizes element ids in markdown mode', () => {
    expect(sanitizeElementId('4:abc[1]:0', undefined, 'markdown')).toBe(
      '4_abc_1__0'
    );
  });
});

describe('isValidFilename', () => {
  it('rejects reserved and forbidden names', () => {
    expect(isValidFilename('')).toBe(false);
    expect(isValidFilename('.')).toBe(false);
    expect(isValidFilename('..')).toBe(false);
    expect(isValidFilename('a/b')).toBe(false);
  });

  it('accepts a normal name', () => {
    expect(isValidFilename('alice')).toBe(true);
  });
});
