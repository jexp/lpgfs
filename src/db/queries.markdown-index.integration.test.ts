/**
 * Integration test for listNodesForMarkdownIndex against a real Neo4j
 * instance.
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
 *   npm test -- src/db/queries.markdown-index.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { createConnection, type DatabaseConnection } from './connection.js';
import { listNodesForMarkdownIndex } from './queries.js';
import { DEFAULT_CONFIG, type ConfigSchema, type MarkdownFieldsConfig, type TextPropertiesConfig } from '../types/index.js';

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

const fieldsConfig: MarkdownFieldsConfig = {
  title: ['title', 'name'],
  timestamp: ['updated', 'lastUpdated'],
  tags: ['tags'],
};

const textPropertiesConfig: TextPropertiesConfig = {
  default: ['summary', 'text'],
};

describe.skipIf(!uri)('listNodesForMarkdownIndex (integration)', () => {
  // Writes go through a plain driver, mirroring queries.markdown.integration.test.ts,
  // since the DatabaseConnection under test is read-only by design.
  //
  // The label is randomized per test run (not a fixed "Concept"), because
  // this file also exists compiled under dist/ and both copies run in the
  // same `npm test` pass against the one shared live container; a fixed
  // label let each copy's beforeAll/afterAll race the other's label-wide
  // seed/cleanup/read, producing flaky node counts.
  const testLabel = `Task010Concept_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let writeDriver: Driver;
  let db: DatabaseConnection;

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
        `CREATE (:\`${testLabel}\` {
            title: 'The Odyssey',
            updated: date('2026-01-05'),
            summary: 'A long journey home across the wine-dark sea.'
          })
         CREATE (:\`${testLabel}\` {
            name: 'Ithaca',
            lastUpdated: date('2026-02-10'),
            text: 'The island kingdom Odysseus is trying to reach.'
          })
         CREATE (:\`${testLabel}\` {name: 'Unmapped'})`
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
  });

  afterAll(async () => {
    await db.close();
    const writeSession = writeDriver.session();
    try {
      await writeSession.run(`MATCH (n:\`${testLabel}\`) DETACH DELETE n`);
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('resolves title/timestamp/description per node from a single query, matching fallback lists per node', async () => {
    const config: ConfigSchema = {
      ...DEFAULT_CONFIG,
      mode: { type: 'markdown' },
      naming: { default: 'elementId', overrides: { nodes: { [testLabel]: { property: 'title' } } } },
    };

    const results = await listNodesForMarkdownIndex(db, testLabel, fieldsConfig, textPropertiesConfig, config);

    expect(results).toHaveLength(3);

    const odyssey = results.find((r) => r.title === 'The Odyssey')!;
    expect(odyssey.timestamp).toBe('2026-01-05');
    expect(odyssey.description).toBe('A long journey home across the wine-dark sea.');

    const ithaca = results.find((r) => r.title === 'Ithaca')!;
    expect(ithaca.timestamp).toBe('2026-02-10');
    expect(ithaca.description).toBe('The island kingdom Odysseus is trying to reach.');

    const unmapped = results.find((r) => r.title === 'Unmapped')!;
    expect(unmapped.timestamp).toBeUndefined();
    expect(unmapped.description).toBeNull();
  });

  it('issues exactly one query for the whole label listing', async () => {
    const spy = vi.spyOn(db, 'executeQuery');

    await listNodesForMarkdownIndex(db, testLabel, fieldsConfig, textPropertiesConfig, {
      ...DEFAULT_CONFIG,
      mode: { type: 'markdown' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
