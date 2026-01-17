/**
 * Tests for FUSE handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdir, createHandlerContext, getConfigContent } from './handlers.js';
import type { HandlerContext } from './handlers.js';
import type { DatabaseConnection } from '../db/connection.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { Cache } from '../cache/index.js';
import { CONFIG_FILENAME, PROPERTIES_FILENAME } from '../core/path-parser.js';

// Mock database connection
function createMockDb(labels: string[] = []): DatabaseConnection {
  return {
    executeQuery: vi.fn().mockResolvedValue({
      records: labels.map((label) => ({ label })),
    }),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseConnection;
}

// Mock database connection with nodes for a specific label
interface MockNode {
  elementId: string;
  properties: Record<string, unknown>;
}

function createMockDbWithNodes(
  labels: string[],
  nodesByLabel: Record<string, MockNode[]> = {},
  relTypesByElementId: Record<string, string[]> = {}
): DatabaseConnection {
  return {
    executeQuery: vi.fn().mockImplementation((query: string, params?: Record<string, unknown>) => {
      // Handle labels query
      if (query.includes('db.labels()')) {
        return Promise.resolve({
          records: labels.map((label) => ({ label })),
        });
      }
      // Handle nodes by label query
      const labelMatch = query.match(/MATCH \(n:`(\w+)`\)/);
      if (labelMatch && !query.includes('-[r]-')) {
        const label = labelMatch[1];
        const nodes = nodesByLabel[label!] || [];
        return Promise.resolve({
          records: nodes.map((n) => ({
            elementId: n.elementId,
            properties: n.properties,
          })),
        });
      }
      // Handle relationship types query
      if (query.includes('RETURN DISTINCT type(r) AS relType') && params?.elementId) {
        const elementId = params.elementId as string;
        const relTypes = relTypesByElementId[elementId] || [];
        return Promise.resolve({
          records: relTypes.map((relType) => ({ relType })),
        });
      }
      return Promise.resolve({ records: [] });
    }),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseConnection;
}

describe('createHandlerContext', () => {
  it('creates context with defaults', () => {
    const db = createMockDb();
    const ctx = createHandlerContext(db);

    expect(ctx.db).toBe(db);
    expect(ctx.config).toEqual(DEFAULT_CONFIG);
    expect(ctx.cache).toBeInstanceOf(Cache);
    expect(ctx.debug).toBe(false);
  });

  it('uses provided options', () => {
    const db = createMockDb();
    const cache = new Cache();
    const config = { ...DEFAULT_CONFIG, naming: { default: 'property' as const } };

    const ctx = createHandlerContext(db, { config, cache, debug: true });

    expect(ctx.config).toBe(config);
    expect(ctx.cache).toBe(cache);
    expect(ctx.debug).toBe(true);
  });
});

describe('readdir', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createHandlerContext(createMockDb(['Person', 'Company', 'Movie']));
  });

  describe('root directory (/)', () => {
    it('returns all labels as directories', async () => {
      const entries = await readdir('/', ctx);

      // Should contain Person, Company, Movie as directories
      const directories = entries.filter((e) => e.type === 'directory');
      expect(directories).toHaveLength(3);
      expect(directories.map((d) => d.name).sort()).toEqual([
        'Company',
        'Movie',
        'Person',
      ]);
    });

    it('includes .lpgfs.yaml file', async () => {
      const entries = await readdir('/', ctx);

      const configFile = entries.find((e) => e.name === CONFIG_FILENAME);
      expect(configFile).toBeDefined();
      expect(configFile?.type).toBe('file');
    });

    it('handles empty database (no labels)', async () => {
      ctx = createHandlerContext(createMockDb([]));

      const entries = await readdir('/', ctx);

      // Should only have the config file
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe(CONFIG_FILENAME);
      expect(entries[0]?.type).toBe('file');
    });

    it('handles trailing slash', async () => {
      const entries = await readdir('//', ctx);

      // Should still work for root
      const directories = entries.filter((e) => e.type === 'directory');
      expect(directories).toHaveLength(3);
    });
  });

  describe('caching', () => {
    it('caches label results', async () => {
      // First call
      await readdir('/', ctx);

      // Second call should use cache
      await readdir('/', ctx);

      // executeQuery should only be called once
      expect(ctx.db.executeQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('label directory (/Label)', () => {
    it('returns all nodes as directories', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice', age: 30 } },
          { elementId: '4:abc:1', properties: { username: 'bob', age: 25 } },
          { elementId: '4:abc:2', properties: { username: 'carol', age: 35 } },
        ],
      });
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person', ctx);

      // All entries should be directories
      expect(entries.every((e) => e.type === 'directory')).toBe(true);
      expect(entries).toHaveLength(3);
    });

    it('uses elementId naming strategy by default', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
          { elementId: '4:abc:1', properties: { username: 'bob' } },
        ],
      });
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person', ctx);

      // With default config (elementId naming), should use sanitized elementIds
      // Colons are replaced with underscores
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['4_abc_0', '4_abc_1']);
    });

    it('uses property naming strategy when configured', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
          { elementId: '4:abc:1', properties: { username: 'bob' } },
        ],
      });
      const config = {
        ...DEFAULT_CONFIG,
        naming: {
          default: 'property' as const,
          overrides: {
            nodes: {
              Person: { property: 'username' },
            },
          },
        },
      };
      ctx = createHandlerContext(db, { config });

      const entries = await readdir('/Person', ctx);

      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['alice', 'bob']);
    });

    it('handles empty label (no nodes)', async () => {
      const db = createMockDbWithNodes(['Person', 'Company'], {
        Person: [],
        Company: [{ elementId: '4:xyz:0', properties: { name: 'Acme' } }],
      });
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person', ctx);

      expect(entries).toHaveLength(0);
    });

    it('handles trailing slash', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [{ elementId: '4:abc:0', properties: { username: 'alice' } }],
      });
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/', ctx);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('4_abc_0');
    });

    it('handles collision with suffix_elementId strategy', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
          { elementId: '4:abc:1', properties: { username: 'alice' } }, // Duplicate name
        ],
      });
      const config = {
        ...DEFAULT_CONFIG,
        naming: {
          default: 'property' as const,
          overrides: {
            nodes: {
              Person: { property: 'username' },
            },
          },
        },
        collision: { strategy: 'suffix_elementId' as const },
      };
      ctx = createHandlerContext(db, { config });

      const entries = await readdir('/Person', ctx);

      // One should be 'alice', the other 'alice_<elementId>'
      const names = entries.map((e) => e.name).sort();
      expect(names).toHaveLength(2);
      expect(names[0]).toBe('alice');
      expect(names[1]).toMatch(/^alice_4_abc_/);
    });
  });

  describe('node directory (/Label/nodeName)', () => {
    it('returns .properties.json and relationship type directories', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS', 'WORKS_AT'],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0', ctx);

      // Should have .properties.json file
      const propsFile = entries.find((e) => e.name === PROPERTIES_FILENAME);
      expect(propsFile).toBeDefined();
      expect(propsFile?.type).toBe('file');

      // Should have relationship type directories
      const directories = entries.filter((e) => e.type === 'directory');
      expect(directories).toHaveLength(2);
      expect(directories.map((d) => d.name).sort()).toEqual(['KNOWS', 'WORKS_AT']);
    });

    it('returns only .properties.json for node with no relationships', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': [], // No relationships
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0', ctx);

      // Should only have .properties.json
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe(PROPERTIES_FILENAME);
      expect(entries[0]?.type).toBe('file');
    });

    it('handles trailing slash', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.name === PROPERTIES_FILENAME)).toBe(true);
      expect(entries.some((e) => e.name === 'KNOWS')).toBe(true);
    });

    it('works with property naming strategy', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'bob' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS', 'WORKS_AT'],
        }
      );
      const config = {
        ...DEFAULT_CONFIG,
        naming: {
          default: 'property' as const,
          overrides: {
            nodes: {
              Person: { property: 'username' },
            },
          },
        },
      };
      ctx = createHandlerContext(db, { config });

      const entries = await readdir('/Person/alice', ctx);

      // Should have .properties.json and relationship types
      expect(entries).toHaveLength(3);
      expect(entries.some((e) => e.name === PROPERTIES_FILENAME)).toBe(true);
      expect(entries.some((e) => e.name === 'KNOWS')).toBe(true);
      expect(entries.some((e) => e.name === 'WORKS_AT')).toBe(true);
    });

    it('returns empty array for non-existent node (no relTypes)', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {}
      );
      ctx = createHandlerContext(db);

      // When node doesn't exist, getRelationshipTypes returns []
      // But the node name doesn't match any node, so relTypes will be empty
      const entries = await readdir('/Person/nonexistent', ctx);

      // .properties.json is always added, relTypes will be empty since node not found
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe(PROPERTIES_FILENAME);
    });

    it('handles multiple relationship types', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS', 'WORKS_AT', 'LIVES_IN', 'MANAGES'],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0', ctx);

      // .properties.json + 4 relationship types
      expect(entries).toHaveLength(5);
      const directories = entries.filter((e) => e.type === 'directory');
      expect(directories).toHaveLength(4);
      expect(directories.map((d) => d.name).sort()).toEqual([
        'KNOWS',
        'LIVES_IN',
        'MANAGES',
        'WORKS_AT',
      ]);
    });
  });
});

describe('getConfigContent', () => {
  it('returns config as YAML string', () => {
    const ctx = createHandlerContext(createMockDb());
    const content = getConfigContent(ctx);

    expect(typeof content).toBe('string');
    expect(content).toContain('naming');
    expect(content).toContain('default');
  });

  it('includes custom config values', () => {
    const config = {
      ...DEFAULT_CONFIG,
      naming: {
        default: 'property' as const,
        overrides: {
          nodes: {
            Person: { property: 'username' },
          },
        },
      },
    };
    const ctx = createHandlerContext(createMockDb(), { config });
    const content = getConfigContent(ctx);

    expect(content).toContain('property');
    expect(content).toContain('Person');
    expect(content).toContain('username');
  });
});
