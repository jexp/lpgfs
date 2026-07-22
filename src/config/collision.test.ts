/**
 * Tests for LPGFS Collision Handling
 */

import { describe, it, expect } from 'vitest';
import {
  CollisionResolver,
  CollisionError,
  resolveCollisions,
  createCollisionResolver,
  MARKDOWN_MODE_RESERVED_NAMES,
} from './collision.js';

describe('CollisionResolver (base behavior)', () => {
  it('returns the base name on first use', () => {
    const resolver = new CollisionResolver('Person');
    expect(resolver.resolve('alice', '4:abc:0')).toBe('alice');
  });

  it('suffixes a colliding name with the sanitized elementId', () => {
    const resolver = new CollisionResolver('Person');
    expect(resolver.resolve('alice', '4:abc:0')).toBe('alice');
    expect(resolver.resolve('alice', '4:abc:1')).toBe('alice_4_abc_1');
  });

  it('returns the same resolved name for a repeated elementId', () => {
    const resolver = new CollisionResolver('Person');
    resolver.resolve('alice', '4:abc:0');
    expect(resolver.resolve('alice', '4:abc:0')).toBe('alice');
  });

  it('throws CollisionError when strategy is fail', () => {
    const resolver = new CollisionResolver('Person', { strategy: 'fail' });
    resolver.resolve('alice', '4:abc:0');
    expect(() => resolver.resolve('alice', '4:abc:1')).toThrow(
      CollisionError
    );
  });
});

describe('CollisionResolver (reserved names)', () => {
  it('suffixes the first node matching a reserved name', () => {
    const resolver = new CollisionResolver('Concept', undefined, ['index']);
    expect(resolver.resolve('index', '4:abc:0')).toBe('index_4_abc_0');
  });

  it('suffixes the first node matching either reserved name', () => {
    const resolver = new CollisionResolver(
      'Concept',
      undefined,
      MARKDOWN_MODE_RESERVED_NAMES
    );
    expect(resolver.resolve('index', '4:abc:0')).toBe('index_4_abc_0');
    expect(resolver.resolve('log', '4:abc:1')).toBe('log_4_abc_1');
  });

  it('does not affect names other than the reserved ones', () => {
    const resolver = new CollisionResolver(
      'Concept',
      undefined,
      MARKDOWN_MODE_RESERVED_NAMES
    );
    expect(resolver.resolve('alice', '4:abc:0')).toBe('alice');
  });

  it('still resolves subsequent collisions on a reserved name normally', () => {
    const resolver = new CollisionResolver('Concept', undefined, ['index']);
    expect(resolver.resolve('index', '4:abc:0')).toBe('index_4_abc_0');
    expect(resolver.resolve('index', '4:abc:1')).toBe('index_4_abc_1');
  });

  it('applies the fail strategy to a reserved-name collision', () => {
    const resolver = new CollisionResolver(
      'Concept',
      { strategy: 'fail' },
      ['index']
    );
    expect(() => resolver.resolve('index', '4:abc:0')).toThrow(
      CollisionError
    );
  });

  it('works with no reserved names given', () => {
    const resolver = new CollisionResolver('Concept', undefined, []);
    expect(resolver.resolve('index', '4:abc:0')).toBe('index');
  });
});

describe('resolveCollisions', () => {
  it('resolves a batch of items with reserved names applied', () => {
    const names = resolveCollisions(
      [
        { baseName: 'index', elementId: '4:abc:0' },
        { baseName: 'alice', elementId: '4:abc:1' },
      ],
      'Concept',
      undefined,
      MARKDOWN_MODE_RESERVED_NAMES
    );
    expect(names).toEqual(['index_4_abc_0', 'alice']);
  });
});

describe('createCollisionResolver', () => {
  it('creates a resolver seeded with reserved names', () => {
    const resolver = createCollisionResolver('Concept', undefined, ['log']);
    expect(resolver.resolve('log', '4:abc:0')).toBe('log_4_abc_0');
  });
});
