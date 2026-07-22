/**
 * Tests for FUSE handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readdir,
  createHandlerContext,
  getConfigContent,
  getattr,
  readlink,
  read,
  write,
  mkdir,
  unlink,
  rmdir,
  rename,
  symlink,
  link,
  truncate,
  chmod,
  chown,
  utimens,
  create,
  mknod,
  setxattr,
  removexattr,
} from './handlers.js';
import type { HandlerContext } from './handlers.js';
import type { DatabaseConnection } from '../db/connection.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_MARKDOWN_MODE_CONFIG,
  LpgfsError,
  POSIX_ERRORS,
  type ConfigSchema,
} from '../types/index.js';
import { Cache } from '../cache/index.js';
import { CONFIG_FILENAME, PROPERTIES_FILENAME } from '../core/path-parser.js';
import { EMPTY_LOG_STUB } from '../markdown/log.js';

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
  /** Full label set for this node; defaults to just the queried label. */
  labels?: string[];
  /** Raw title/timestamp/rawDescription projection columns, for
   * listNodesForMarkdownIndex mock responses (root /log.md tests).
   * Default to `null`, matching what a real coalesce() with no matching
   * property returns. */
  title?: unknown;
  timestamp?: unknown;
  rawDescription?: unknown;
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

/** A single raw relationship row shape expected by getNodeForMarkdown's mock query result. */
interface MockMarkdownRow {
  relType: string;
  targetLabels: string[];
  targetElementId: string;
  targetProperties: Record<string, unknown>;
}

/** Per-node data returned by the mocked getNodeForMarkdown query, keyed by elementId. */
interface MockMarkdownNode {
  labels: string[];
  properties: Record<string, unknown>;
  outRows?: MockMarkdownRow[];
  inRows?: MockMarkdownRow[];
}

/**
 * Mock database connection for markdown-mode handler tests: serves
 * db.labels(), the label-scoped node listing query, and getNodeForMarkdown's
 * single-round-trip CYPHER 25 query.
 */
function createMockDbMarkdown(
  labels: string[],
  nodesByLabel: Record<string, MockNode[]> = {},
  markdownByElementId: Record<string, MockMarkdownNode> = {}
): DatabaseConnection {
  return {
    executeQuery: vi.fn().mockImplementation((query: string, params?: Record<string, unknown>) => {
      if (query.includes('db.labels()')) {
        return Promise.resolve({ records: labels.map((label) => ({ label })) });
      }

      if (query.includes('outRows') && params?.elementId) {
        const node = markdownByElementId[params.elementId as string];
        if (!node) {
          return Promise.resolve({ records: [] });
        }
        return Promise.resolve({
          records: [
            {
              properties: node.properties,
              labels: node.labels,
              outRows: node.outRows ?? [],
              inRows: node.inRows ?? [],
            },
          ],
        });
      }

      const labelMatch = query.match(/MATCH \(n:`(\w+)`\)/);
      if (labelMatch) {
        const label = labelMatch[1]!;
        const nodes = nodesByLabel[label] || [];
        return Promise.resolve({
          records: nodes.map((n) => {
            const props = n.properties as Record<string, unknown>;
            // Only listNodesForMarkdownIndex's query selects these columns
            // (its RETURN clause includes "AS title"), but supplying them
            // unconditionally here is harmless for the plain
            // getNodesByLabel-shaped queries above, which just ignore the
            // extra fields. A fixture may set title/timestamp/rawDescription
            // explicitly (n.title etc.) to override the property-fallback
            // computation below.
            return {
              elementId: n.elementId,
              properties: n.properties,
              labels: n.labels ?? [label],
              title: (n.title ?? props.title ?? props.name ?? null) as unknown,
              timestamp: (n.timestamp ?? props.updated ?? props.lastUpdated ?? props.modified ?? props.created ?? null) as unknown,
              rawDescription: (n.rawDescription ?? props.summary ?? props.text ?? props.content ?? null) as unknown,
            };
          }),
        });
      }

      return Promise.resolve({ records: [] });
    }),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseConnection;
}

function markdownConfig(overrides: Partial<ConfigSchema['mode']['markdown']> = {}): ConfigSchema {
  return {
    ...DEFAULT_CONFIG,
    naming: {
      default: 'elementId',
      overrides: { nodes: { Character: { property: 'name' } } },
    },
    mode: {
      type: 'markdown',
      markdown: { ...DEFAULT_MARKDOWN_MODE_CONFIG, ...overrides },
    },
  };
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

// =============================================================================
// Write Operations Tests - All should return EROFS
// =============================================================================

describe('write operations (EROFS)', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createHandlerContext(createMockDb(['Person']));
  });

  describe('write()', () => {
    it('throws EROFS error', () => {
      expect(() => write('/Person/alice/.properties.json', 'test data', 0, ctx)).toThrow();
      try {
        write('/Person/alice/.properties.json', 'test data', 0, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });

    it('throws EROFS with Buffer data', () => {
      expect(() => write('/test.txt', Buffer.from('test'), 0, ctx)).toThrow();
      try {
        write('/test.txt', Buffer.from('test'), 0, ctx);
      } catch (err) {
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
      }
    });
  });

  describe('mkdir()', () => {
    it('throws EROFS error', () => {
      expect(() => mkdir('/NewLabel', 0o755, ctx)).toThrow();
      try {
        mkdir('/NewLabel', 0o755, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('unlink()', () => {
    it('throws EROFS error', () => {
      expect(() => unlink('/Person/alice/.properties.json', ctx)).toThrow();
      try {
        unlink('/Person/alice/.properties.json', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('rmdir()', () => {
    it('throws EROFS error', () => {
      expect(() => rmdir('/Person', ctx)).toThrow();
      try {
        rmdir('/Person', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('rename()', () => {
    it('throws EROFS error', () => {
      expect(() => rename('/Person/alice', '/Person/bob', ctx)).toThrow();
      try {
        rename('/Person/alice', '/Person/bob', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('symlink()', () => {
    it('throws EROFS error', () => {
      expect(() => symlink('/Person/alice', '/Person/link_to_alice', ctx)).toThrow();
      try {
        symlink('/Person/alice', '/Person/link_to_alice', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('link()', () => {
    it('throws EROFS error', () => {
      expect(() => link('/Person/alice', '/Person/hardlink', ctx)).toThrow();
      try {
        link('/Person/alice', '/Person/hardlink', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('truncate()', () => {
    it('throws EROFS error', () => {
      expect(() => truncate('/Person/alice/.properties.json', 0, ctx)).toThrow();
      try {
        truncate('/Person/alice/.properties.json', 0, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('chmod()', () => {
    it('throws EROFS error', () => {
      expect(() => chmod('/Person/alice', 0o755, ctx)).toThrow();
      try {
        chmod('/Person/alice', 0o755, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('chown()', () => {
    it('throws EROFS error', () => {
      expect(() => chown('/Person/alice', 1000, 1000, ctx)).toThrow();
      try {
        chown('/Person/alice', 1000, 1000, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('utimens()', () => {
    it('throws EROFS error with Date objects', () => {
      const now = new Date();
      expect(() => utimens('/Person/alice', now, now, ctx)).toThrow();
      try {
        utimens('/Person/alice', now, now, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });

    it('throws EROFS error with numeric timestamps', () => {
      expect(() => utimens('/Person/alice', Date.now(), Date.now(), ctx)).toThrow();
      try {
        utimens('/Person/alice', Date.now(), Date.now(), ctx);
      } catch (err) {
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
      }
    });
  });

  describe('create()', () => {
    it('throws EROFS error', () => {
      expect(() => create('/newfile.txt', 0o644, ctx)).toThrow();
      try {
        create('/newfile.txt', 0o644, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('mknod()', () => {
    it('throws EROFS error', () => {
      expect(() => mknod('/device', 0o644, 0, ctx)).toThrow();
      try {
        mknod('/device', 0o644, 0, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('setxattr()', () => {
    it('throws EROFS error', () => {
      expect(() => setxattr('/Person/alice', 'user.attr', Buffer.from('value'), 0, ctx)).toThrow();
      try {
        setxattr('/Person/alice', 'user.attr', Buffer.from('value'), 0, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('removexattr()', () => {
    it('throws EROFS error', () => {
      expect(() => removexattr('/Person/alice', 'user.attr', ctx)).toThrow();
      try {
        removexattr('/Person/alice', 'user.attr', ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(LpgfsError);
        expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
        expect((err as LpgfsError).message).toBe('LPGFS is read-only');
      }
    });
  });

  describe('all write operations fail consistently', () => {
    it('all return EROFS with same error message', () => {
      const operations = [
        () => write('/test', 'data', 0, ctx),
        () => mkdir('/test', 0o755, ctx),
        () => unlink('/test', ctx),
        () => rmdir('/test', ctx),
        () => rename('/a', '/b', ctx),
        () => symlink('/a', '/b', ctx),
        () => link('/a', '/b', ctx),
        () => truncate('/test', 0, ctx),
        () => chmod('/test', 0o755, ctx),
        () => chown('/test', 1000, 1000, ctx),
        () => utimens('/test', new Date(), new Date(), ctx),
        () => create('/test', 0o644, ctx),
        () => mknod('/test', 0o644, 0, ctx),
        () => setxattr('/test', 'attr', Buffer.from('v'), 0, ctx),
        () => removexattr('/test', 'attr', ctx),
      ];

      for (const op of operations) {
        try {
          op();
          // If we get here, the operation didn't throw
          expect.fail('Operation should have thrown EROFS error');
        } catch (err) {
          expect(err).toBeInstanceOf(LpgfsError);
          expect((err as LpgfsError).code).toBe(POSIX_ERRORS.EROFS);
          expect((err as LpgfsError).message).toBe('LPGFS is read-only');
        }
      }
    });
  });
});

describe('markdown mode', () => {
  function createCtx(config: ConfigSchema, db: DatabaseConnection): HandlerContext {
    return createHandlerContext(db, { config, cache: new Cache() });
  }

  describe('readdir', () => {
    it('lists one directory entry per rendered label at root', async () => {
      const db = createMockDbMarkdown(['Character', 'Place']);
      const ctx = createCtx(markdownConfig(), db);

      const entries = await readdir('/', ctx);

      expect(entries).toEqual([
        { name: 'Character', type: 'directory' },
        { name: 'Place', type: 'directory' },
      ]);
    });

    it('respects mode.markdown.labels as an allow-list at root', async () => {
      const db = createMockDbMarkdown(['Character', 'Place', 'Creature']);
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      const entries = await readdir('/', ctx);

      expect(entries).toEqual([{ name: 'Character', type: 'directory' }]);
    });

    it('lists node files with a .md extension under a label', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' } },
          { elementId: '4:a:1', properties: { name: 'penelope' } },
        ],
      });
      const ctx = createCtx(markdownConfig(), db);

      const entries = await readdir('/Character', ctx);

      expect(entries).toEqual([
        { name: 'odysseus.md', type: 'file' },
        { name: 'penelope.md', type: 'file' },
      ]);
    });

    it('rejects a label directory excluded by mode.markdown.labels with ENOENT', async () => {
      const db = createMockDbMarkdown(['Character', 'Place']);
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      await expect(readdir('/Place', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('renders every label found in the database when mode.markdown.labels is unset', async () => {
      const db = createMockDbMarkdown(['Character', 'Place', 'Creature']);
      const ctx = createCtx(markdownConfig(), db);

      const entries = await readdir('/', ctx);

      expect(entries.map((e) => e.name).sort()).toEqual([
        'Character',
        'Creature',
        'Place',
      ]);
    });

    it('rejects paths deeper than a node file with ENOENT', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      await expect(readdir('/Character/odysseus.md/extra', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });
  });

  describe('getattr and read', () => {
    it('reports getattr size equal to the exact rendered byte length, and read returns matching content', async () => {
      const db = createMockDbMarkdown(
        ['Character'],
        { Character: [{ elementId: '4:a:0', properties: { name: 'odysseus', summary: 'A king of Ithaca.' } }] },
        {
          '4:a:0': {
            labels: ['Character'],
            properties: { name: 'odysseus', summary: 'A king of Ithaca.' },
            outRows: [
              {
                relType: 'KNOWS',
                targetLabels: ['Character'],
                targetElementId: '4:a:1',
                targetProperties: { name: 'penelope' },
              },
            ],
          },
        }
      );
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/Character/odysseus.md', ctx);
      expect(stat.type).toBe('file');
      expect(stat.size).toBeGreaterThan(0);

      const result = await read('/Character/odysseus.md', ctx);

      expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
      expect(result.size).toBe(stat.size);
      expect(result.content).toContain('type: Character');
      expect(result.content).toContain('A king of Ithaca.');
      expect(result.content).toContain('[[Character/penelope]]');
    });

    it('serves read from the cache populated by getattr without re-rendering', async () => {
      const db = createMockDbMarkdown(
        ['Character'],
        { Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }] },
        { '4:a:0': { labels: ['Character'], properties: { name: 'odysseus' } } }
      );
      const ctx = createCtx(markdownConfig(), db);

      await getattr('/Character/odysseus.md', ctx);
      const callsAfterGetattr = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      const result = await read('/Character/odysseus.md', ctx);
      const callsAfterRead = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfterRead).toBe(callsAfterGetattr);
      expect(result.content).toContain('type: Character');
    });

    it('getattr on a label directory reports type directory', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/Character', ctx);
      expect(stat.type).toBe('directory');
    });

    it('getattr on root reports type directory', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/', ctx);
      expect(stat.type).toBe('directory');
    });

    it('getattr for an unknown node throws ENOENT', async () => {
      const db = createMockDbMarkdown(['Character'], { Character: [] });
      const ctx = createCtx(markdownConfig(), db);

      await expect(getattr('/Character/nobody.md', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('read for a label directory (not a node file) throws ENOENT', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      await expect(read('/Character', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('supports offset/length slicing of rendered content, matching the classic read contract', async () => {
      const db = createMockDbMarkdown(
        ['Character'],
        { Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }] },
        { '4:a:0': { labels: ['Character'], properties: { name: 'odysseus' } } }
      );
      const ctx = createCtx(markdownConfig(), db);

      const full = await read('/Character/odysseus.md', ctx);
      const partial = await read('/Character/odysseus.md', ctx, 0, 3);

      expect(partial.size).toBe(full.size);
      expect(partial.content).toBe(full.content.slice(0, 3));
    });

    it('getattr on a node under a label excluded by mode.markdown.labels throws ENOENT', async () => {
      const db = createMockDbMarkdown(['Character', 'Place'], {
        Place: [{ elementId: '4:a:0', properties: { name: 'ithaca' } }],
      });
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      await expect(getattr('/Place/ithaca.md', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('read on a node under a label excluded by mode.markdown.labels throws ENOENT', async () => {
      const db = createMockDbMarkdown(['Character', 'Place'], {
        Place: [{ elementId: '4:a:0', properties: { name: 'ithaca' } }],
      });
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      await expect(read('/Place/ithaca.md', ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('renders a link to a node in an excluded label as a normal Label/name link, not suppressed', async () => {
      const db = createMockDbMarkdown(
        ['Character', 'Place'],
        { Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }] },
        {
          '4:a:0': {
            labels: ['Character'],
            properties: { name: 'odysseus' },
            outRows: [
              {
                relType: 'VISITED',
                targetLabels: ['Place'],
                targetElementId: '4:a:1',
                targetProperties: { name: 'ithaca' },
              },
            ],
          },
        }
      );
      const config = markdownConfig({ labels: ['Character'] });
      config.naming.overrides = {
        ...config.naming.overrides,
        nodes: {
          ...config.naming.overrides?.nodes,
          Place: { property: 'name' },
        },
      };
      const ctx = createCtx(config, db);

      const result = await read('/Character/odysseus.md', ctx);

      expect(result.content).toContain('[[Place/ithaca]]');
    });
  });

  describe('root /log.md generation (task-012)', () => {
    function placeConfig(overrides: Partial<ConfigSchema['mode']['markdown']> = {}): ConfigSchema {
      const config = markdownConfig(overrides);
      config.naming.overrides = {
        ...config.naming.overrides,
        nodes: { ...config.naming.overrides?.nodes, Place: { property: 'name' } },
      };
      return config;
    }

    it('merges nodes across every rendered label, grouped by date (## YYYY-MM-DD, newest first)', async () => {
      const db = createMockDbMarkdown(['Character', 'Place'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' }, timestamp: '2026-03-10T00:00:00.000Z' },
        ],
        Place: [{ elementId: '4:a:1', properties: { name: 'ithaca' }, timestamp: '2026-01-05T00:00:00.000Z' }],
      });
      const ctx = createCtx(placeConfig(), db);

      const stat = await getattr('/log.md', ctx);
      expect(stat.type).toBe('file');

      const result = await read('/log.md', ctx);
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);

      const marchIdx = result.content.indexOf('## 2026-03-10');
      const janIdx = result.content.indexOf('## 2026-01-05');
      expect(marchIdx).toBeGreaterThan(-1);
      expect(janIdx).toBeGreaterThan(-1);
      expect(marchIdx).toBeLessThan(janIdx);
      expect(result.content).toContain('- **Update** [[Character/odysseus]]');
      expect(result.content).toContain('- **Update** [[Place/ithaca]]');
    });

    it('excludes nodes without a resolvable timestamp, without affecting other entries', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' }, timestamp: '2026-01-05T00:00:00.000Z' },
          { elementId: '4:a:1', properties: { name: 'telemachus' } }, // no timestamp -> null
        ],
      });
      const ctx = createCtx(markdownConfig(), db);

      const result = await read('/log.md', ctx);
      expect(result.content).toContain('odysseus');
      expect(result.content).not.toContain('telemachus');
    });

    it('renders the documented stub when zero nodes anywhere resolve a timestamp', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }],
      });
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/log.md', ctx);
      const result = await read('/log.md', ctx);

      expect(result.content).toBe(EMPTY_LOG_STUB);
      expect(stat.size).toBe(Buffer.byteLength(EMPTY_LOG_STUB, 'utf8'));
      expect(result.content).not.toContain('##');
    });

    it('respects mode.markdown.labels: only allow-listed labels contribute entries', async () => {
      const db = createMockDbMarkdown(['Character', 'Place'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' }, timestamp: '2026-01-05T00:00:00.000Z' },
        ],
        Place: [{ elementId: '4:a:1', properties: { name: 'ithaca' }, timestamp: '2026-02-01T00:00:00.000Z' }],
      });
      const ctx = createCtx(placeConfig({ labels: ['Character'] }), db);

      const result = await read('/log.md', ctx);
      expect(result.content).toContain('odysseus');
      expect(result.content).not.toContain('ithaca');
    });

    it('supports the markdown link style', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' }, timestamp: '2026-01-05T00:00:00.000Z' },
        ],
      });
      const ctx = createCtx(markdownConfig({ linkStyle: 'markdown' }), db);

      const result = await read('/log.md', ctx);
      expect(result.content).toContain('- **Update** /Character/odysseus.md');
    });

    it('a multi-label node contributes only one entry, under its chosen label (REQ-F-014)', async () => {
      const db = createMockDbMarkdown(['Character', 'Place'], {
        Character: [
          {
            elementId: '4:a:0',
            properties: { name: 'delphi' },
            labels: ['Place', 'Character'],
            timestamp: '2026-01-05T00:00:00.000Z',
          },
        ],
        Place: [
          {
            elementId: '4:a:0',
            properties: { name: 'delphi' },
            labels: ['Place', 'Character'],
            timestamp: '2026-01-05T00:00:00.000Z',
          },
        ],
      });
      const ctx = createCtx(placeConfig({ labels: ['Place', 'Character'] }), db);

      const result = await read('/log.md', ctx);
      const occurrences = result.content.split('delphi').length - 1;
      expect(occurrences).toBe(1);
      expect(result.content).toContain('[[Place/delphi]]');
    });

    it('caches under the label-listing TTL bucket and does not re-query on a second read', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus' }, timestamp: '2026-01-05T00:00:00.000Z' },
        ],
      });
      const ctx = createCtx(markdownConfig(), db);

      await getattr('/log.md', ctx);
      const callsAfterGetattr = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      const result = await read('/log.md', ctx);
      const callsAfterRead = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfterRead).toBe(callsAfterGetattr);
      expect(result.content).toContain('odysseus');
    });
  });

  describe('multi-label nodes (first-label-wins, REQ-F-014)', () => {
    // Real Neo4j returns this node from `MATCH (n:Hero)` AND `MATCH (n:Character)`
    // since it carries both labels; the mock buckets mirror that by listing the
    // same node under both label keys.
    const multiLabelNode: MockNode = {
      elementId: '4:m:0',
      properties: {},
      labels: ['Hero', 'Character'],
    };
    const sanitizedFile = '4_m_0.md';

    it('appears under exactly one label listing (alphabetically-first) when mode.markdown.labels is unset', async () => {
      const db = createMockDbMarkdown(['Hero', 'Character'], {
        Hero: [multiLabelNode],
        Character: [multiLabelNode],
      });
      const ctx = createCtx(markdownConfig(), db);

      expect(await readdir('/Hero', ctx)).toEqual([]);
      expect(await readdir('/Character', ctx)).toEqual([{ name: sanitizedFile, type: 'file' }]);
    });

    it('appears under the first label from mode.markdown.labels order when configured', async () => {
      const db = createMockDbMarkdown(['Hero', 'Character'], {
        Hero: [multiLabelNode],
        Character: [multiLabelNode],
      });
      const ctx = createCtx(markdownConfig({ labels: ['Hero', 'Character'] }), db);

      expect(await readdir('/Hero', ctx)).toEqual([{ name: sanitizedFile, type: 'file' }]);
      expect(await readdir('/Character', ctx)).toEqual([]);
    });

    it('getattr/read succeed on the chosen label path and throw ENOENT on the non-chosen label path', async () => {
      const db = createMockDbMarkdown(
        ['Hero', 'Character'],
        { Hero: [multiLabelNode], Character: [multiLabelNode] },
        { '4:m:0': { labels: ['Hero', 'Character'], properties: {} } }
      );
      const ctx = createCtx(markdownConfig(), db);

      // Chosen label is alphabetically-first: Character.
      const stat = await getattr(`/Character/${sanitizedFile}`, ctx);
      expect(stat.type).toBe('file');
      const result = await read(`/Character/${sanitizedFile}`, ctx);
      expect(result.content).toContain('type: Character');

      await expect(getattr(`/Hero/${sanitizedFile}`, ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
      await expect(read(`/Hero/${sanitizedFile}`, ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('getattr/read succeed under the configured first label instead of the alphabetical default', async () => {
      const db = createMockDbMarkdown(
        ['Hero', 'Character'],
        { Hero: [multiLabelNode], Character: [multiLabelNode] },
        { '4:m:0': { labels: ['Hero', 'Character'], properties: {} } }
      );
      const ctx = createCtx(markdownConfig({ labels: ['Hero', 'Character'] }), db);

      const stat = await getattr(`/Hero/${sanitizedFile}`, ctx);
      expect(stat.type).toBe('file');
      const result = await read(`/Hero/${sanitizedFile}`, ctx);
      expect(result.content).toContain('type: Hero');

      await expect(getattr(`/Character/${sanitizedFile}`, ctx)).rejects.toMatchObject({
        code: POSIX_ERRORS.ENOENT,
      });
    });

    it('renders a link to a multi-label target at its chosen-label path regardless of the raw target label order', async () => {
      const db = createMockDbMarkdown(
        ['Character'],
        { Character: [{ elementId: '4:n:0', properties: {} }] },
        {
          '4:n:0': {
            labels: ['Character'],
            properties: {},
            outRows: [
              // Two different relationships return the multi-label target's
              // labels in opposite orders; both must still resolve to the
              // same chosen-label link.
              { relType: 'ALLY_OF', targetLabels: ['Hero', 'Character'], targetElementId: '4:m:1', targetProperties: {} },
              { relType: 'RIVAL_OF', targetLabels: ['Character', 'Hero'], targetElementId: '4:m:1', targetProperties: {} },
            ],
          },
        }
      );
      const ctx = createCtx(markdownConfig(), db);

      const result = await read('/Character/4_n_0.md', ctx);

      expect(result.content).toContain('[[Character/4_m_1]]');
      expect(result.content).not.toContain('[[Hero/4_m_1]]');
    });
  });

  describe('write operations remain EROFS in markdown mode', () => {
    it('write, create, unlink, mkdir, rmdir, rename, truncate, and chmod all throw EROFS', () => {
      const ctx = createCtx(markdownConfig(), createMockDbMarkdown(['Character']));

      expect(() => write('/Character/odysseus.md', Buffer.from('x'), 0, ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => create('/Character/new.md', 0o644, ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => unlink('/Character/odysseus.md', ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => mkdir('/NewLabel', 0o755, ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => rmdir('/Character', ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => rename('/Character/odysseus.md', '/Character/renamed.md', ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => truncate('/Character/odysseus.md', 0, ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
      expect(() => chmod('/Character/odysseus.md', 0o644, ctx)).toThrow(
        expect.objectContaining({ code: POSIX_ERRORS.EROFS })
      );
    });
  });

  describe('generated index.md files (root and per-label)', () => {
    it('getattr on /index.md reports the exact rendered byte length', async () => {
      const db = createMockDbMarkdown(['Character', 'Place']);
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/index.md', ctx);
      const content = await read('/index.md', ctx);

      expect(stat.type).toBe('file');
      expect(stat.size).toBe(Buffer.byteLength(content.content, 'utf8'));
    });

    it('read on /index.md contains okf_version frontmatter and a link to every rendered label', async () => {
      const db = createMockDbMarkdown(['Character', 'Place']);
      const ctx = createCtx(markdownConfig(), db);

      const result = await read('/index.md', ctx);

      expect(result.content).toContain('okf_version: "0.1"');
      expect(result.content).toContain('[[Character/index]]');
      expect(result.content).toContain('[[Place/index]]');
    });

    it('/index.md only links rendered labels, respecting mode.markdown.labels', async () => {
      const db = createMockDbMarkdown(['Character', 'Place', 'Creature']);
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      const result = await read('/index.md', ctx);

      expect(result.content).toContain('[[Character/index]]');
      expect(result.content).not.toContain('Place');
      expect(result.content).not.toContain('Creature');
    });

    it('getattr on /<Label>/index.md reports the exact rendered byte length', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [{ elementId: '4:a:0', properties: { name: 'odysseus', title: 'Odysseus' } }],
      });
      const ctx = createCtx(markdownConfig(), db);

      const stat = await getattr('/Character/index.md', ctx);
      const content = await read('/Character/index.md', ctx);

      expect(stat.type).toBe('file');
      expect(stat.size).toBe(Buffer.byteLength(content.content, 'utf8'));
    });

    it('read on /<Label>/index.md lists every concept in that label with a derived description', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [
          { elementId: '4:a:0', properties: { name: 'odysseus', title: 'Odysseus', summary: 'King of Ithaca.' } },
          { elementId: '4:a:1', properties: { name: 'penelope', title: 'Penelope' } },
        ],
      });
      const ctx = createCtx(markdownConfig(), db);

      const result = await read('/Character/index.md', ctx);

      expect(result.content).toContain('[[Character/odysseus]] — Odysseus — King of Ithaca.');
      expect(result.content).toContain('[[Character/penelope]] — Penelope');
      expect(result.content.startsWith('---')).toBe(false);
    });

    it('read on /<Label>/index.md for an empty label renders a minimal valid file, not an error', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      const result = await read('/Character/index.md', ctx);

      expect(result.content.length).toBeGreaterThan(0);
    });

    it('getattr on /<Label>/index.md for an excluded label throws ENOENT', async () => {
      const db = createMockDbMarkdown(['Character', 'Place']);
      const ctx = createCtx(markdownConfig({ labels: ['Character'] }), db);

      await expect(getattr('/Place/index.md', ctx)).rejects.toEqual(
        expect.objectContaining({ code: POSIX_ERRORS.ENOENT })
      );
    });

    it('markdown-mode /<Label>/index.md links use the configured markdown linkStyle', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }],
      });
      const ctx = createCtx(markdownConfig({ linkStyle: 'markdown' }), db);

      const result = await read('/Character/index.md', ctx);

      expect(result.content).toContain('/Character/odysseus.md');
    });

    it('caches the rendered root index.md, issuing no additional query on a second read', async () => {
      const db = createMockDbMarkdown(['Character']);
      const ctx = createCtx(markdownConfig(), db);

      await read('/index.md', ctx);
      const callsAfterFirst = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;
      await read('/index.md', ctx);
      const callsAfterSecond = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('caches the rendered per-label index.md, issuing no additional per-node query on a second read', async () => {
      const db = createMockDbMarkdown(['Character'], {
        Character: [{ elementId: '4:a:0', properties: { name: 'odysseus' } }],
      });
      const ctx = createCtx(markdownConfig(), db);

      await read('/Character/index.md', ctx);
      const callsAfterFirst = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;
      await read('/Character/index.md', ctx);
      const callsAfterSecond = (db.executeQuery as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  describe('classic mode is unaffected', () => {
    it('readdir on root still uses the classic path parser when mode.type is classic', async () => {
      const db = createMockDbWithNodes(['Person']);
      const ctx = createHandlerContext(db, { config: DEFAULT_CONFIG, cache: new Cache() });

      const entries = await readdir('/', ctx);

      expect(entries).toEqual([
        { name: 'Person', type: 'directory' },
        { name: CONFIG_FILENAME, type: 'file' },
      ]);
    });
  });
});
