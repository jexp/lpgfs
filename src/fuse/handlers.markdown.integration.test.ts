/**
 * Integration test for the markdown-mode FUSE handler path (readdir /
 * getattr / read) against a real Neo4j instance.
 *
 * This exercises handlers.ts end-to-end (getNodeForMarkdown ->
 * groupRelationshipsForMarkdown -> renderNodeMarkdown with the real
 * propertyFallbackFieldResolver) without a live FUSE mount, since
 * fuse-native requires an OS-level FUSE install that may not be available
 * in this environment (see test/mount-errors.md / test/manual.md, which
 * document FUSE mount testing as a manual/local-only procedure). It is the
 * handler-level equivalent of test/manual.md's classic-mode `ls`/`cat`
 * walkthrough.
 *
 * Requires Neo4j connection credentials, supplied either via a repo-root
 * `integration.env` file (KEY=VALUE per line, per AGENTS.md convention) or
 * via the equivalent process env vars. Automatically SKIPPED (not failed)
 * when neither is present, so `npm test` stays green without a live DB.
 *
 * To run locally with an ephemeral Docker Neo4j (via the neo4j-cli skill):
 *
 *   neo4j-cli docker create --name lpgfs-test --ephemeral --edition community \
 *     --env-out-file integration.env --wait --rw
 *   npm test -- src/fuse/handlers.markdown.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { createConnection, type DatabaseConnection } from '../db/connection.js';
import { getattr, read, readdir, createHandlerContext } from './handlers.js';
import type { HandlerContext } from './handlers.js';
import { Cache } from '../cache/index.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema } from '../types/index.js';

function loadIntegrationEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const envPath = resolve(process.cwd(), 'integration.env');
  if (!existsSync(envPath)) return env;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = loadIntegrationEnv();
const uri = env.NEO4J_URI;

describe.skipIf(!uri)('markdown-mode FUSE handlers (integration)', () => {
  let writeDriver: Driver;
  let db: DatabaseConnection;
  let ctx: HandlerContext;

  const config: ConfigSchema = {
    ...DEFAULT_CONFIG,
    naming: {
      default: 'elementId',
      overrides: {
        nodes: { Person: { property: 'name' }, Company: { property: 'name' } },
      },
    },
    mode: {
      type: 'markdown',
      markdown: {
        ...DEFAULT_MARKDOWN_MODE_CONFIG,
        textProperties: { default: ['summary'] },
      },
    },
  };

  beforeAll(async () => {
    writeDriver = neo4j.driver(
      uri!,
      env.NEO4J_USERNAME && env.NEO4J_PASSWORD
        ? neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD)
        : undefined
    );
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task007' DETACH DELETE n`);
      await writeSession.run(
        `CREATE (alice:Person {name: 'alice', summary: 'A curious explorer.', updated: '2026-01-01', testMarker: 'task007'})
         CREATE (bob:Person {name: 'bob', testMarker: 'task007'})
         CREATE (acme:Company {name: 'acme', testMarker: 'task007'})
         CREATE (alice)-[:KNOWS]->(bob)
         CREATE (alice)-[:WORKS_AT]->(acme)`
      );
    } finally {
      await writeSession.close();
    }

    db = createConnection({
      uri: uri!,
      username: env.NEO4J_USERNAME,
      password: env.NEO4J_PASSWORD,
    });
    await db.connect();
    ctx = createHandlerContext(db, { config, cache: new Cache() });
  });

  afterAll(async () => {
    await db.close();
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task007' DETACH DELETE n`);
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('lists Person and Company directories at root', async () => {
    const entries = await readdir('/', ctx);
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain('Person');
    expect(names).toContain('Company');
  });

  it('lists alice.md and bob.md under /Person', async () => {
    const entries = await readdir('/Person', ctx);
    expect(entries.map((e) => e.name).sort()).toEqual(['alice.md', 'bob.md']);
  });

  it('renders a real node end-to-end: getattr size matches read content, with frontmatter/body/links from the live graph', async () => {
    const stat = await getattr('/Person/alice.md', ctx);
    expect(stat.type).toBe('file');

    const result = await read('/Person/alice.md', ctx);
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);

    expect(result.content).toContain('type: Person');
    expect(result.content).toContain('title: alice');
    expect(result.content).toMatch(/timestamp: ['"]?2026-01-01['"]?/);
    expect(result.content).toContain('KNOWS:');
    expect(result.content).toContain('"[[Person/bob]]"');
    expect(result.content).toContain('WORKS_AT:');
    expect(result.content).toContain('"[[Company/acme]]"');
    expect(result.content).toContain('A curious explorer.');
  });

  it('read reuses the cache populated by getattr (no extra query)', async () => {
    await getattr('/Person/bob.md', ctx);
    const spy = vi.spyOn(db, 'executeQuery');
    const result = await read('/Person/bob.md', ctx);

    expect(result.content).toContain('type: Person');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe.skipIf(!uri)('root and per-label index.md generation (integration)', () => {
  let writeDriver: Driver;
  let db: DatabaseConnection;
  let ctx: HandlerContext;

  const config: ConfigSchema = {
    ...DEFAULT_CONFIG,
    naming: {
      default: 'elementId',
      overrides: {
        nodes: { Person: { property: 'name' }, Company: { property: 'name' } },
      },
    },
    mode: {
      type: 'markdown',
      markdown: {
        ...DEFAULT_MARKDOWN_MODE_CONFIG,
        linkStyle: 'markdown',
        textProperties: { default: ['summary'] },
      },
    },
  };

  beforeAll(async () => {
    writeDriver = neo4j.driver(
      uri!,
      env.NEO4J_USERNAME && env.NEO4J_PASSWORD
        ? neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD)
        : undefined
    );
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task011' DETACH DELETE n`);
      await writeSession.run(
        `CREATE (:Person {name: 'alice', title: 'Alice', summary: 'A curious explorer.', testMarker: 'task011'})
         CREATE (:Person {name: 'bob', testMarker: 'task011'})
         CREATE (:Company {name: 'acme', title: 'Acme Corp', testMarker: 'task011'})
         CREATE (:Person:VIP {name: 'carol', title: 'Carol', testMarker: 'task011'})`
      );
    } finally {
      await writeSession.close();
    }

    db = createConnection({
      uri: uri!,
      username: env.NEO4J_USERNAME,
      password: env.NEO4J_PASSWORD,
    });
    await db.connect();
    ctx = createHandlerContext(db, { config, cache: new Cache() });
  });

  afterAll(async () => {
    await db.close();
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task011' DETACH DELETE n`);
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('/index.md reports accurate getattr size and links every rendered label to its own index.md', async () => {
    const stat = await getattr('/index.md', ctx);
    const result = await read('/index.md', ctx);

    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
    expect(result.content).toContain('okf_version: "0.1"');
    expect(result.content).not.toMatch(/^type:/m);
    expect(result.content).toContain('/Person/index.md');
    expect(result.content).toContain('/Company/index.md');
    expect(result.content).toContain('/VIP/index.md');
  });

  it('/Person/index.md lists alice and bob with derived descriptions, real query results end-to-end', async () => {
    const stat = await getattr('/Person/index.md', ctx);
    const result = await read('/Person/index.md', ctx);

    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
    expect(result.content.startsWith('---')).toBe(false);
    expect(result.content).toContain('/Person/alice.md — Alice — A curious explorer.');
    expect(result.content).toContain('/Person/bob.md');
  });

  it('a multi-label node (Person+VIP) is listed under its chosen label (Person) only', async () => {
    const personIndex = await read('/Person/index.md', ctx);
    const vipIndex = await read('/VIP/index.md', ctx);

    expect(personIndex.content).toContain('/Person/carol.md — Carol');
    expect(vipIndex.content).not.toContain('carol');
  });

  it('/VIP/index.md (a rendered label whose only node was claimed by Person) renders a minimal valid file rather than erroring', async () => {
    const result = await read('/VIP/index.md', ctx);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('/Company/index.md read reuses the cache populated by getattr (no extra query)', async () => {
    await getattr('/Company/index.md', ctx);
    const spy = vi.spyOn(db, 'executeQuery');
    const result = await read('/Company/index.md', ctx);

    expect(result.content).toContain('/Company/acme.md');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
