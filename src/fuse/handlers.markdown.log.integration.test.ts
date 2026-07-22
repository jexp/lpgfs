/**
 * Integration test for the generated root /log.md file (task-012) against
 * a real Neo4j instance: seeds nodes with varying timestamp-fallback
 * properties (and one with none) across two labels, then verifies the
 * getattr/read-generated content against the raw query results.
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
 *   npm test -- src/fuse/handlers.markdown.log.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { createConnection, type DatabaseConnection } from '../db/connection.js';
import { getattr, read, createHandlerContext } from './handlers.js';
import type { HandlerContext } from './handlers.js';
import { Cache } from '../cache/index.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema } from '../types/index.js';
import { EMPTY_LOG_STUB } from '../markdown/log.js';

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

describe.skipIf(!uri)('root /log.md generation (integration)', () => {
  let writeDriver: Driver;
  let db: DatabaseConnection;
  let ctx: HandlerContext;

  // Randomized per-run label prefix, per task-010's flakiness fix for
  // src/dist test duplicates racing seed/cleanup against one shared
  // container on a fixed label.
  const marker = `Task012_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const characterLabel = `${marker}_Character`;
  const placeLabel = `${marker}_Place`;

  const config: ConfigSchema = {
    ...DEFAULT_CONFIG,
    naming: {
      default: 'elementId',
      overrides: {
        nodes: {
          [characterLabel]: { property: 'name' },
          [placeLabel]: { property: 'name' },
        },
      },
    },
    mode: {
      type: 'markdown',
      markdown: {
        ...DEFAULT_MARKDOWN_MODE_CONFIG,
        labels: [characterLabel, placeLabel],
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
      await writeSession.run(
        `CREATE (:\`${characterLabel}\` {name: 'odysseus', updated: date('2026-03-10')})
         CREATE (:\`${characterLabel}\` {name: 'telemachus', lastUpdated: '2026-02-01T00:00:00.000Z'})
         CREATE (:\`${characterLabel}\` {name: 'nobody'})
         CREATE (:\`${placeLabel}\` {name: 'ithaca', updated: date('2026-01-05')})`
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
      await writeSession.run(
        `MATCH (n) WHERE n:\`${characterLabel}\` OR n:\`${placeLabel}\` DETACH DELETE n`
      );
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('getattr size matches the read content for /log.md', async () => {
    const stat = await getattr('/log.md', ctx);
    expect(stat.type).toBe('file');

    const result = await read('/log.md', ctx);
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
  });

  it('groups the seeded nodes by mapped-timestamp date, newest first, merged across labels', async () => {
    const result = await read('/log.md', ctx);

    const marchIdx = result.content.indexOf('## 2026-03-10');
    const febIdx = result.content.indexOf('## 2026-02-01');
    const janIdx = result.content.indexOf('## 2026-01-05');

    expect(marchIdx).toBeGreaterThan(-1);
    expect(febIdx).toBeGreaterThan(-1);
    expect(janIdx).toBeGreaterThan(-1);
    expect(marchIdx).toBeLessThan(febIdx);
    expect(febIdx).toBeLessThan(janIdx);

    expect(result.content).toContain(`- **Update** [[${characterLabel}/odysseus]]`);
    expect(result.content).toContain(`- **Update** [[${characterLabel}/telemachus]]`);
    expect(result.content).toContain(`- **Update** [[${placeLabel}/ithaca]]`);
  });

  it('omits the node with no resolvable timestamp ("nobody") without affecting the others', async () => {
    const result = await read('/log.md', ctx);
    expect(result.content).not.toContain('nobody');
  });

  it('renders the documented empty-graph stub when scoped to a label with zero resolvable timestamps', async () => {
    const emptyLabel = `${marker}_Empty`;
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`CREATE (:\`${emptyLabel}\` {name: 'unresolved'})`);
    } finally {
      await writeSession.close();
    }

    const emptyConfig: ConfigSchema = {
      ...config,
      mode: {
        type: 'markdown',
        markdown: { ...config.mode.markdown!, labels: [emptyLabel] },
      },
    };
    const emptyCtx = createHandlerContext(db, { config: emptyConfig, cache: new Cache() });

    const result = await read('/log.md', emptyCtx);
    expect(result.content).toBe(EMPTY_LOG_STUB);

    const cleanupSession = writeDriver.session();
    try {
      await cleanupSession.run(`MATCH (n:\`${emptyLabel}\`) DETACH DELETE n`);
    } finally {
      await cleanupSession.close();
    }
  });
});
