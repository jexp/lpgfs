/**
 * Tests for FUSE handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdir, createHandlerContext, getConfigContent, getattr, readlink, read } from './handlers.js';
import type { HandlerContext } from './handlers.js';
import type { DatabaseConnection } from '../db/connection.js';
import { DEFAULT_CONFIG, LpgfsError, POSIX_ERRORS } from '../types/index.js';
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

/**
 * Mock relationship data for testing direction directory
 */
interface MockRelationship {
  relElementId: string;
  relProperties: Record<string, unknown>;
  targetElementId: string;
  targetLabels: string[];
  targetProperties: Record<string, unknown>;
}

/**
 * Key format for relationships: `${sourceElementId}:${relType}:${direction}`
 */
type RelationshipKey = string;

/**
 * Map of relationship elementId to its properties
 */
type RelPropertiesMap = Record<string, Record<string, unknown>>;

function createMockDbWithNodes(
  labels: string[],
  nodesByLabel: Record<string, MockNode[]> = {},
  relTypesByElementId: Record<string, string[]> = {},
  relationshipsByKey: Record<RelationshipKey, MockRelationship[]> = {},
  relPropertiesByElementId: RelPropertiesMap = {}
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
      if (labelMatch && !query.includes('-[r]-') && !query.includes('-[r:') && !query.includes('<-[r:')) {
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
      // Handle relationship properties query (for getRelationshipProperties)
      if (query.includes('MATCH ()-[r]-()') && query.includes('WHERE elementId(r)') && params?.relElementId) {
        const relElementId = params.relElementId as string;
        const props = relPropertiesByElementId[relElementId];
        if (props) {
          return Promise.resolve({
            records: [{ elementId: relElementId, properties: props }],
          });
        }
        // Try to find it in the relationships data
        for (const key of Object.keys(relationshipsByKey)) {
          const rels = relationshipsByKey[key] || [];
          const rel = rels.find((r) => r.relElementId === relElementId);
          if (rel) {
            return Promise.resolve({
              records: [{ elementId: relElementId, properties: rel.relProperties }],
            });
          }
        }
        return Promise.resolve({ records: [] });
      }
      // Handle relationships query (OUT direction)
      const outMatch = query.match(/MATCH \(n\)-\[r:`(\w+)`\]->\(m\)/);
      if (outMatch && params?.elementId) {
        const relType = outMatch[1];
        const key = `${params.elementId}:${relType}:OUT`;
        const rels = relationshipsByKey[key] || [];
        return Promise.resolve({
          records: rels,
        });
      }
      // Handle relationships query (IN direction)
      const inMatch = query.match(/MATCH \(n\)<-\[r:`(\w+)`\]-\(m\)/);
      if (inMatch && params?.elementId) {
        const relType = inMatch[1];
        const key = `${params.elementId}:${relType}:IN`;
        const rels = relationshipsByKey[key] || [];
        return Promise.resolve({
          records: rels,
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

  describe('reltype directory (/Label/nodeName/RELTYPE)', () => {
    it('returns OUT and IN directories', async () => {
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

      const entries = await readdir('/Person/4_abc_0/KNOWS', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.type === 'directory')).toBe(true);
      expect(entries.map((e) => e.name).sort()).toEqual(['IN', 'OUT']);
    });

    it('returns OUT and IN for any relationship type', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['WORKS_AT'],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/WORKS_AT', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['IN', 'OUT']);
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

      const entries = await readdir('/Person/4_abc_0/KNOWS/', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['IN', 'OUT']);
    });

    it('works with property naming strategy', async () => {
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

      // Path uses display name 'alice' instead of elementId
      const entries = await readdir('/Person/alice/KNOWS', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['IN', 'OUT']);
    });

    it('returns OUT and IN even for non-existent reltype (validation happens elsewhere)', async () => {
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

      // FAKE_REL doesn't exist, but readdir doesn't validate - getattr would
      const entries = await readdir('/Person/4_abc_0/FAKE_REL', ctx);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['IN', 'OUT']);
    });
  });

  describe('direction directory (/Label/nodeName/RELTYPE/OUT or IN)', () => {
    it('returns symlinks and property files for relationships', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { since: 2020 },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/OUT', ctx);

      // Should have symlink + property file
      expect(entries).toHaveLength(2);

      const symlink = entries.find((e) => e.type === 'symlink');
      expect(symlink?.name).toBe('4_abc_1'); // Default naming uses elementId

      const file = entries.find((e) => e.type === 'file');
      expect(file?.name).toBe('.4_abc_1.json');
    });

    it('returns empty array when no relationships exist', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {} // No relationships
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/OUT', ctx);

      expect(entries).toHaveLength(0);
    });

    it('handles multiple relationships to different targets', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
            { elementId: '4:abc:2', properties: { username: 'bob' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
            {
              relElementId: '5:abc:1',
              relProperties: {},
              targetElementId: '4:abc:2',
              targetLabels: ['Person'],
              targetProperties: { username: 'bob' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/OUT', ctx);

      // Should have 2 symlinks + 2 property files = 4 entries
      expect(entries).toHaveLength(4);

      const symlinks = entries.filter((e) => e.type === 'symlink');
      expect(symlinks).toHaveLength(2);
      expect(symlinks.map((s) => s.name).sort()).toEqual(['4_abc_1', '4_abc_2']);

      const files = entries.filter((e) => e.type === 'file');
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name).sort()).toEqual(['.4_abc_1.json', '.4_abc_2.json']);
    });

    it('handles multiple relationships to same target with suffixes (section 8.1)', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { context: 'work' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
            {
              relElementId: '5:abc:1',
              relProperties: { context: 'school' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/OUT', ctx);

      // Should have 2 symlinks + 2 property files = 4 entries
      expect(entries).toHaveLength(4);

      const symlinks = entries.filter((e) => e.type === 'symlink');
      expect(symlinks).toHaveLength(2);
      // First uses base name, second gets _1 suffix
      expect(symlinks.map((s) => s.name)).toEqual(['4_abc_1', '4_abc_1_1']);

      const files = entries.filter((e) => e.type === 'file');
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toEqual(['.4_abc_1.json', '.4_abc_1_1.json']);
    });

    it('works with property naming strategy', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { since: 2020 },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
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

      const entries = await readdir('/Person/alice/KNOWS/OUT', ctx);

      // Should use property naming for target
      expect(entries).toHaveLength(2);

      const symlink = entries.find((e) => e.type === 'symlink');
      expect(symlink?.name).toBe('james');

      const file = entries.find((e) => e.type === 'file');
      expect(file?.name).toBe('.james.json');
    });

    it('handles IN direction correctly', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:IN': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/IN', ctx);

      expect(entries).toHaveLength(2);

      const symlink = entries.find((e) => e.type === 'symlink');
      expect(symlink?.name).toBe('4_abc_1');
    });

    it('handles trailing slash', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/KNOWS/OUT/', ctx);

      expect(entries).toHaveLength(2);
    });

    it('handles cross-label relationships', async () => {
      const db = createMockDbWithNodes(
        ['Person', 'Company'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
          Company: [
            { elementId: '4:xyz:0', properties: { name: 'Acme' } },
          ],
        },
        {
          '4:abc:0': ['WORKS_AT'],
        },
        {
          '4:abc:0:WORKS_AT:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { role: 'Engineer' },
              targetElementId: '4:xyz:0',
              targetLabels: ['Company'],
              targetProperties: { name: 'Acme' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const entries = await readdir('/Person/4_abc_0/WORKS_AT/OUT', ctx);

      expect(entries).toHaveLength(2);

      const symlink = entries.find((e) => e.type === 'symlink');
      // Should use elementId since Company label has no override
      expect(symlink?.name).toBe('4_xyz_0');
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

describe('getattr', () => {
  let ctx: HandlerContext;

  describe('root directory (/)', () => {
    beforeEach(() => {
      ctx = createHandlerContext(createMockDb(['Person', 'Company']));
    });

    it('returns directory type for root', async () => {
      const stat = await getattr('/', ctx);

      expect(stat.type).toBe('directory');
      expect(stat.mtime).toBeInstanceOf(Date);
      expect(stat.atime).toBeInstanceOf(Date);
      expect(stat.ctime).toBeInstanceOf(Date);
    });
  });

  describe('label directory (/Label)', () => {
    beforeEach(() => {
      ctx = createHandlerContext(createMockDb(['Person', 'Company']));
    });

    it('returns directory type for existing label', async () => {
      const stat = await getattr('/Person', ctx);

      expect(stat.type).toBe('directory');
    });

    it('throws ENOENT for non-existent label', async () => {
      await expect(getattr('/NonExistent', ctx)).rejects.toThrow(LpgfsError);
      await expect(getattr('/NonExistent', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('node directory (/Label/nodeName)', () => {
    beforeEach(() => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
          { elementId: '4:abc:1', properties: { username: 'bob' } },
        ],
      });
      ctx = createHandlerContext(db);
    });

    it('returns directory type for existing node', async () => {
      const stat = await getattr('/Person/4_abc_0', ctx);

      expect(stat.type).toBe('directory');
    });

    it('throws ENOENT for non-existent node', async () => {
      await expect(getattr('/Person/nonexistent', ctx)).rejects.toThrow(LpgfsError);
      await expect(getattr('/Person/nonexistent', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for node under non-existent label', async () => {
      await expect(getattr('/NonExistent/alice', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('works with property naming strategy', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
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

      const stat = await getattr('/Person/alice', ctx);

      expect(stat.type).toBe('directory');
    });
  });

  describe('reltype directory (/Label/nodeName/RELTYPE)', () => {
    beforeEach(() => {
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
    });

    it('returns directory type for existing relationship type', async () => {
      const stat = await getattr('/Person/4_abc_0/KNOWS', ctx);

      expect(stat.type).toBe('directory');
    });

    it('throws ENOENT for non-existent relationship type', async () => {
      await expect(getattr('/Person/4_abc_0/FAKE_REL', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for reltype under non-existent node', async () => {
      await expect(getattr('/Person/nonexistent/KNOWS', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('direction directory (/Label/nodeName/RELTYPE/OUT or IN)', () => {
    beforeEach(() => {
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
    });

    it('returns directory type for OUT direction', async () => {
      const stat = await getattr('/Person/4_abc_0/KNOWS/OUT', ctx);

      expect(stat.type).toBe('directory');
    });

    it('returns directory type for IN direction', async () => {
      const stat = await getattr('/Person/4_abc_0/KNOWS/IN', ctx);

      expect(stat.type).toBe('directory');
    });

    it('throws ENOENT for invalid direction', async () => {
      await expect(getattr('/Person/4_abc_0/KNOWS/INVALID', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('target symlink (/Label/nodeName/RELTYPE/OUT/target)', () => {
    beforeEach(() => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { since: 2020 },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);
    });

    it('returns symlink type for existing target', async () => {
      const stat = await getattr('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);

      expect(stat.type).toBe('symlink');
    });

    it('throws ENOENT for non-existent target', async () => {
      await expect(getattr('/Person/4_abc_0/KNOWS/OUT/nonexistent', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('handles multiple relationships to same target with suffix', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { context: 'work' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
            {
              relElementId: '5:abc:1',
              relProperties: { context: 'school' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      // First target
      const stat1 = await getattr('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);
      expect(stat1.type).toBe('symlink');

      // Second target with suffix
      const stat2 = await getattr('/Person/4_abc_0/KNOWS/OUT/4_abc_1_1', ctx);
      expect(stat2.type).toBe('symlink');
    });
  });

  describe('properties files', () => {
    describe('config file (/.lpgfs.yaml)', () => {
      beforeEach(() => {
        ctx = createHandlerContext(createMockDb(['Person']));
      });

      it('returns file type with size for config file', async () => {
        const stat = await getattr('/.lpgfs.yaml', ctx);

        expect(stat.type).toBe('file');
        expect(stat.size).toBeGreaterThan(0);
      });
    });

    describe('node properties file (.properties.json)', () => {
      beforeEach(() => {
        const db = createMockDbWithNodes(['Person'], {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        });
        ctx = createHandlerContext(db);
      });

      it('returns file type for existing node properties', async () => {
        const stat = await getattr('/Person/4_abc_0/.properties.json', ctx);

        expect(stat.type).toBe('file');
      });

      it('throws ENOENT for properties file of non-existent node', async () => {
        await expect(getattr('/Person/nonexistent/.properties.json', ctx)).rejects.toMatchObject({
          code: POSIX_ERRORS.ENOENT,
        });
      });
    });

    describe('relationship properties file (.targetName.json)', () => {
      beforeEach(() => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020 },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);
      });

      it('returns file type for existing relationship properties file', async () => {
        const stat = await getattr('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx);

        expect(stat.type).toBe('file');
      });

      it('throws ENOENT for non-existent relationship properties file', async () => {
        await expect(getattr('/Person/4_abc_0/KNOWS/OUT/.nonexistent.json', ctx)).rejects.toMatchObject({
          code: POSIX_ERRORS.ENOENT,
        });
      });
    });
  });

  describe('caching', () => {
    it('caches label lookups', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
        ],
      });
      ctx = createHandlerContext(db);

      // First call
      await getattr('/Person', ctx);
      // Second call should use cache
      await getattr('/Person', ctx);

      // Labels query should only be called once (cached)
      const mockCalls = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls;
      const labelsCalls = mockCalls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('db.labels()')
      );
      expect(labelsCalls).toHaveLength(1);
    });
  });
});

describe('readlink', () => {
  let ctx: HandlerContext;

  describe('same-label relationships', () => {
    it('returns relative path for same-label symlink', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { since: 2020 },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const target = await readlink('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);

      // Same label: 3 levels up, then target name
      expect(target).toBe('../../../4_abc_1');
    });

    it('works with property naming strategy', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { since: 2020 },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
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

      const target = await readlink('/Person/alice/KNOWS/OUT/james', ctx);

      expect(target).toBe('../../../james');
    });

    it('handles IN direction', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:IN': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const target = await readlink('/Person/4_abc_0/KNOWS/IN/4_abc_1', ctx);

      expect(target).toBe('../../../4_abc_1');
    });
  });

  describe('cross-label relationships', () => {
    it('returns relative path for cross-label symlink', async () => {
      const db = createMockDbWithNodes(
        ['Person', 'Company'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
          Company: [
            { elementId: '4:xyz:0', properties: { name: 'Acme' } },
          ],
        },
        {
          '4:abc:0': ['WORKS_AT'],
        },
        {
          '4:abc:0:WORKS_AT:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { role: 'Engineer' },
              targetElementId: '4:xyz:0',
              targetLabels: ['Company'],
              targetProperties: { name: 'Acme' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const target = await readlink('/Person/4_abc_0/WORKS_AT/OUT/4_xyz_0', ctx);

      // Cross-label: 4 levels up, then TargetLabel/targetName
      expect(target).toBe('../../../../Company/4_xyz_0');
    });

    it('works with property naming for cross-label', async () => {
      const db = createMockDbWithNodes(
        ['Person', 'Company'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
          Company: [
            { elementId: '4:xyz:0', properties: { name: 'Acme' } },
          ],
        },
        {
          '4:abc:0': ['WORKS_AT'],
        },
        {
          '4:abc:0:WORKS_AT:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { role: 'Engineer' },
              targetElementId: '4:xyz:0',
              targetLabels: ['Company'],
              targetProperties: { name: 'Acme' },
            },
          ],
        }
      );
      const config = {
        ...DEFAULT_CONFIG,
        naming: {
          default: 'property' as const,
          overrides: {
            nodes: {
              Person: { property: 'username' },
              Company: { property: 'name' },
            },
          },
        },
      };
      ctx = createHandlerContext(db, { config });

      const target = await readlink('/Person/alice/WORKS_AT/OUT/Acme', ctx);

      expect(target).toBe('../../../../Company/Acme');
    });

    it('handles IN direction for cross-label', async () => {
      const db = createMockDbWithNodes(
        ['Person', 'Company'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
          Company: [
            { elementId: '4:xyz:0', properties: { name: 'Acme' } },
          ],
        },
        {
          '4:xyz:0': ['WORKS_AT'],
        },
        {
          '4:xyz:0:WORKS_AT:IN': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:0',
              targetLabels: ['Person'],
              targetProperties: { username: 'alice' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      const target = await readlink('/Company/4_xyz_0/WORKS_AT/IN/4_abc_0', ctx);

      expect(target).toBe('../../../../Person/4_abc_0');
    });
  });

  describe('multiple relationships to same target', () => {
    it('handles suffix for multiple rels to same target', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: { context: 'work' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
            {
              relElementId: '5:abc:1',
              relProperties: { context: 'school' },
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      // First relationship uses base name
      const target1 = await readlink('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);
      expect(target1).toBe('../../../4_abc_1');

      // Second relationship uses suffix
      const target2 = await readlink('/Person/4_abc_0/KNOWS/OUT/4_abc_1_1', ctx);
      expect(target2).toBe('../../../4_abc_1');
    });
  });

  describe('error handling', () => {
    it('throws ENOENT for non-existent symlink', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [],
        }
      );
      ctx = createHandlerContext(db);

      await expect(readlink('/Person/4_abc_0/KNOWS/OUT/nonexistent', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for non-symlink path', async () => {
      ctx = createHandlerContext(createMockDb(['Person']));

      // Try to readlink a directory
      await expect(readlink('/Person', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for properties file path', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
          ],
        },
        {},
        {}
      );
      ctx = createHandlerContext(db);

      await expect(readlink('/Person/4_abc_0/.properties.json', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('caching', () => {
    it('uses cached relationship data', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      // First call
      await readlink('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);
      // Second call should use cache
      await readlink('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx);

      // Relationship query should only be called once
      const mockCalls = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls;
      const relCalls = mockCalls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('-[r:`KNOWS`]->')
      );
      expect(relCalls).toHaveLength(1);
    });
  });
});

describe('read', () => {
  let ctx: HandlerContext;

  describe('config file (/.lpgfs.yaml)', () => {
    beforeEach(() => {
      ctx = createHandlerContext(createMockDb(['Person']));
    });

    it('returns config content as YAML string', async () => {
      const result = await read('/.lpgfs.yaml', ctx);

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('naming');
      expect(result.size).toBeGreaterThan(0);
      expect(result.size).toBe(Buffer.byteLength(result.content, 'utf8'));
    });

    it('returns correct size', async () => {
      const result = await read('/.lpgfs.yaml', ctx);

      // Read again without offset to verify size is consistent
      const fullContent = getConfigContent(ctx);
      expect(result.size).toBe(Buffer.byteLength(fullContent, 'utf8'));
    });
  });

  describe('node properties (.properties.json)', () => {
    beforeEach(() => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice', age: 30, email: 'alice@example.com' } },
          { elementId: '4:abc:1', properties: { username: 'bob', age: 25 } },
        ],
      });
      ctx = createHandlerContext(db);
    });

    it('returns node properties as JSON', async () => {
      const result = await read('/Person/4_abc_0/.properties.json', ctx);

      expect(result.content).toBeTruthy();
      const parsed = JSON.parse(result.content);
      expect(parsed._elementId).toBe('4:abc:0');
      expect(parsed.username).toBe('alice');
      expect(parsed.age).toBe(30);
      expect(parsed.email).toBe('alice@example.com');
    });

    it('includes _elementId field in output', async () => {
      const result = await read('/Person/4_abc_0/.properties.json', ctx);

      const parsed = JSON.parse(result.content);
      expect(parsed._elementId).toBe('4:abc:0');
    });

    it('returns formatted JSON with indentation', async () => {
      const result = await read('/Person/4_abc_0/.properties.json', ctx);

      // Check for newlines and spaces indicating formatted JSON
      expect(result.content).toContain('\n');
      expect(result.content).toContain('  ');
    });

    it('throws ENOENT for non-existent node', async () => {
      await expect(read('/Person/nonexistent/.properties.json', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for non-existent label', async () => {
      await expect(read('/NonExistent/alice/.properties.json', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('works with property naming strategy', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice', age: 30 } },
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

      const result = await read('/Person/alice/.properties.json', ctx);

      const parsed = JSON.parse(result.content);
      expect(parsed._elementId).toBe('4:abc:0');
      expect(parsed.username).toBe('alice');
    });

    it('returns correct size in bytes', async () => {
      const result = await read('/Person/4_abc_0/.properties.json', ctx);

      // Verify size matches actual content bytes
      expect(result.size).toBe(Buffer.byteLength(result.content, 'utf8'));
    });
  });

  describe('partial reads with offset/length', () => {
    beforeEach(() => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice', data: 'some long data for testing partial reads' } },
        ],
      });
      ctx = createHandlerContext(db);
    });

    it('handles offset parameter', async () => {
      const fullResult = await read('/Person/4_abc_0/.properties.json', ctx);
      const partialResult = await read('/Person/4_abc_0/.properties.json', ctx, 10);

      // Content should be from offset to end
      expect(partialResult.content).toBe(fullResult.content.substring(10));
      // Size should be total file size, not partial content size
      expect(partialResult.size).toBe(fullResult.size);
    });

    it('handles length parameter', async () => {
      const fullResult = await read('/Person/4_abc_0/.properties.json', ctx);
      const partialResult = await read('/Person/4_abc_0/.properties.json', ctx, 0, 20);

      // Content should be first 20 bytes
      expect(partialResult.content.length).toBeLessThanOrEqual(20);
      // Size should be total file size
      expect(partialResult.size).toBe(fullResult.size);
    });

    it('handles offset and length together', async () => {
      const fullResult = await read('/Person/4_abc_0/.properties.json', ctx);
      const partialResult = await read('/Person/4_abc_0/.properties.json', ctx, 5, 10);

      // Content should be 10 bytes starting at offset 5
      const expectedContent = Buffer.from(fullResult.content, 'utf8').subarray(5, 15).toString('utf8');
      expect(partialResult.content).toBe(expectedContent);
    });

    it('handles offset beyond content length', async () => {
      const fullResult = await read('/Person/4_abc_0/.properties.json', ctx);
      const partialResult = await read('/Person/4_abc_0/.properties.json', ctx, fullResult.size + 10);

      // Should return empty content
      expect(partialResult.content).toBe('');
      expect(partialResult.size).toBe(fullResult.size);
    });

    it('handles length extending beyond content', async () => {
      const fullResult = await read('/Person/4_abc_0/.properties.json', ctx);
      const partialResult = await read('/Person/4_abc_0/.properties.json', ctx, 0, fullResult.size + 100);

      // Should return full content (not beyond)
      expect(partialResult.content).toBe(fullResult.content);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      ctx = createHandlerContext(createMockDb(['Person']));
    });

    it('throws ENOENT for directory paths', async () => {
      await expect(read('/Person', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for root path', async () => {
      await expect(read('/', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('throws ENOENT for symlink paths', async () => {
      const db = createMockDbWithNodes(
        ['Person'],
        {
          Person: [
            { elementId: '4:abc:0', properties: { username: 'alice' } },
            { elementId: '4:abc:1', properties: { username: 'james' } },
          ],
        },
        {
          '4:abc:0': ['KNOWS'],
        },
        {
          '4:abc:0:KNOWS:OUT': [
            {
              relElementId: '5:abc:0',
              relProperties: {},
              targetElementId: '4:abc:1',
              targetLabels: ['Person'],
              targetProperties: { username: 'james' },
            },
          ],
        }
      );
      ctx = createHandlerContext(db);

      // Try to read a symlink (should fail)
      await expect(read('/Person/4_abc_0/KNOWS/OUT/4_abc_1', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('caching', () => {
    it('uses cached node data', async () => {
      const db = createMockDbWithNodes(['Person'], {
        Person: [
          { elementId: '4:abc:0', properties: { username: 'alice' } },
        ],
      });
      ctx = createHandlerContext(db);

      // First read
      await read('/Person/4_abc_0/.properties.json', ctx);
      // Second read should use cache
      await read('/Person/4_abc_0/.properties.json', ctx);

      // Node query should only be called once (nodes are cached)
      const mockCalls = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls;
      const nodeCalls = mockCalls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('MATCH (n:`Person`)')
      );
      expect(nodeCalls).toHaveLength(1);
    });
  });

  describe('relationship properties (.targetName.json)', () => {
    describe('OUT direction (canonical properties)', () => {
      it('returns full relationship properties as JSON', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020, weight: 0.8 },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        const result = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx);

        const parsed = JSON.parse(result.content);
        expect(parsed._elementId).toBe('5:abc:0');
        expect(parsed.since).toBe(2020);
        expect(parsed.weight).toBe(0.8);
      });

      it('returns formatted JSON with indentation', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020 },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        const result = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx);

        expect(result.content).toContain('\n');
        expect(result.content).toContain('  ');
      });

      it('works with property naming strategy', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020 },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
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

        const result = await read('/Person/alice/KNOWS/OUT/.james.json', ctx);

        const parsed = JSON.parse(result.content);
        expect(parsed._elementId).toBe('5:abc:0');
        expect(parsed.since).toBe(2020);
      });

      it('handles multiple relationships to same target with suffix', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { context: 'work' },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
              {
                relElementId: '5:abc:1',
                relProperties: { context: 'school' },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        // First relationship (base name)
        const result1 = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx);
        const parsed1 = JSON.parse(result1.content);
        expect(parsed1._elementId).toBe('5:abc:0');
        expect(parsed1.context).toBe('work');

        // Second relationship (with suffix)
        const result2 = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1_1.json', ctx);
        const parsed2 = JSON.parse(result2.content);
        expect(parsed2._elementId).toBe('5:abc:1');
        expect(parsed2.context).toBe('school');
      });

      it('handles cross-label relationships', async () => {
        const db = createMockDbWithNodes(
          ['Person', 'Company'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
            ],
            Company: [
              { elementId: '4:xyz:0', properties: { name: 'Acme' } },
            ],
          },
          {
            '4:abc:0': ['WORKS_AT'],
          },
          {
            '4:abc:0:WORKS_AT:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { role: 'Engineer', since: 2019 },
                targetElementId: '4:xyz:0',
                targetLabels: ['Company'],
                targetProperties: { name: 'Acme' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        const result = await read('/Person/4_abc_0/WORKS_AT/OUT/.4_xyz_0.json', ctx);

        const parsed = JSON.parse(result.content);
        expect(parsed._elementId).toBe('5:abc:0');
        expect(parsed.role).toBe('Engineer');
        expect(parsed.since).toBe(2019);
      });
    });

    describe('IN direction (_ref pointer)', () => {
      it('returns _ref pointing to relationship elementId', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:1': ['KNOWS'],
          },
          {
            '4:abc:1:KNOWS:IN': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020 },
                targetElementId: '4:abc:0',
                targetLabels: ['Person'],
                targetProperties: { username: 'alice' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        const result = await read('/Person/4_abc_1/KNOWS/IN/.4_abc_0.json', ctx);

        const parsed = JSON.parse(result.content);
        expect(parsed._ref).toBe('5:abc:0');
        // Should NOT have the actual properties
        expect(parsed.since).toBeUndefined();
        expect(parsed._elementId).toBeUndefined();
      });

      it('works with property naming strategy', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:1': ['KNOWS'],
          },
          {
            '4:abc:1:KNOWS:IN': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020 },
                targetElementId: '4:abc:0',
                targetLabels: ['Person'],
                targetProperties: { username: 'alice' },
              },
            ],
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

        const result = await read('/Person/james/KNOWS/IN/.alice.json', ctx);

        const parsed = JSON.parse(result.content);
        expect(parsed._ref).toBe('5:abc:0');
      });

      it('handles multiple incoming relationships with suffix', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:1': ['KNOWS'],
          },
          {
            '4:abc:1:KNOWS:IN': [
              {
                relElementId: '5:abc:0',
                relProperties: { context: 'work' },
                targetElementId: '4:abc:0',
                targetLabels: ['Person'],
                targetProperties: { username: 'alice' },
              },
              {
                relElementId: '5:abc:1',
                relProperties: { context: 'school' },
                targetElementId: '4:abc:0',
                targetLabels: ['Person'],
                targetProperties: { username: 'alice' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        // First relationship (base name)
        const result1 = await read('/Person/4_abc_1/KNOWS/IN/.4_abc_0.json', ctx);
        const parsed1 = JSON.parse(result1.content);
        expect(parsed1._ref).toBe('5:abc:0');

        // Second relationship (with suffix)
        const result2 = await read('/Person/4_abc_1/KNOWS/IN/.4_abc_0_1.json', ctx);
        const parsed2 = JSON.parse(result2.content);
        expect(parsed2._ref).toBe('5:abc:1');
      });
    });

    describe('error handling', () => {
      it('throws ENOENT for non-existent relationship properties file', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: {},
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        await expect(read('/Person/4_abc_0/KNOWS/OUT/.nonexistent.json', ctx)).rejects.toMatchObject({
          code: POSIX_ERRORS.ENOENT,
        });
      });

      it('throws ENOENT when no relationships exist', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {} // No relationships
        );
        ctx = createHandlerContext(db);

        await expect(read('/Person/4_abc_0/KNOWS/OUT/.someone.json', ctx)).rejects.toMatchObject({
          code: POSIX_ERRORS.ENOENT,
        });
      });
    });

    describe('partial reads', () => {
      it('handles offset and length for relationship properties', async () => {
        const db = createMockDbWithNodes(
          ['Person'],
          {
            Person: [
              { elementId: '4:abc:0', properties: { username: 'alice' } },
              { elementId: '4:abc:1', properties: { username: 'james' } },
            ],
          },
          {
            '4:abc:0': ['KNOWS'],
          },
          {
            '4:abc:0:KNOWS:OUT': [
              {
                relElementId: '5:abc:0',
                relProperties: { since: 2020, notes: 'Met at conference' },
                targetElementId: '4:abc:1',
                targetLabels: ['Person'],
                targetProperties: { username: 'james' },
              },
            ],
          }
        );
        ctx = createHandlerContext(db);

        const fullResult = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx);
        const partialResult = await read('/Person/4_abc_0/KNOWS/OUT/.4_abc_1.json', ctx, 0, 20);

        expect(partialResult.content.length).toBeLessThanOrEqual(20);
        expect(partialResult.size).toBe(fullResult.size);
      });
    });
  });
});
