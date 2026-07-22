/**
 * Integration test for getNodeForMarkdown against a real Neo4j instance.
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
 *   npm test -- src/db/queries.markdown.integration.test.ts
 *
 * `integration.env` is written by `--env-out-file` with NEO4J_URI,
 * NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE — exactly the keys read
 * below. The container is `--rm`, so nothing to clean up afterwards; the
 * test also DETACH DELETEs its own seeded nodes in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { createConnection, type DatabaseConnection } from './connection.js';
import { getNodeForMarkdown, groupRelationshipsForMarkdown } from './queries.js';
import { DEFAULT_CONFIG } from '../types/index.js';

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

describe.skipIf(!uri)('getNodeForMarkdown (integration)', () => {
  // getNodeForMarkdown/executeQuery run in a READ-mode session by design
  // (this is a read-only filesystem) so seeding/cleanup writes go through
  // a separate plain driver instead of the DatabaseConnection under test.
  let writeDriver: Driver;
  let db: DatabaseConnection;
  let aliceElementId: string;

  beforeAll(async () => {
    writeDriver = neo4j.driver(
      uri!,
      env.NEO4J_USERNAME && env.NEO4J_PASSWORD
        ? neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD)
        : undefined
    );
    const writeSession = writeDriver.session();
    try {
      // Seed: alice knows bob (OUT), acme knows alice (IN), alice works at
      // acme (OUT), globex works at alice (IN) — two rel types, both
      // directions, spanning two target labels.
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task018' DETACH DELETE n`);
      const result = await writeSession.run(
        `CREATE (alice:Person {name: 'alice', testMarker: 'task018'})
         CREATE (bob:Person {name: 'bob', testMarker: 'task018'})
         CREATE (acme:Company {name: 'acme', testMarker: 'task018'})
         CREATE (globex:Company {name: 'globex', testMarker: 'task018'})
         CREATE (alice)-[:KNOWS]->(bob)
         CREATE (acme)-[:KNOWS]->(alice)
         CREATE (alice)-[:WORKS_AT]->(acme)
         CREATE (globex)-[:WORKS_AT]->(alice)
         RETURN elementId(alice) AS elementId`
      );
      aliceElementId = result.records[0]!.get('elementId') as string;
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
      await writeSession.run(`MATCH (n) WHERE n.testMarker = 'task018' DETACH DELETE n`);
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('fetches labels, properties, and all relationships in one round trip', async () => {
    const result = await getNodeForMarkdown(db, aliceElementId);

    expect(result).not.toBeNull();
    expect(result!.labels).toEqual(['Person']);
    expect(result!.properties.name).toBe('alice');
    expect(result!.relationships).toHaveLength(4);

    const byKey = (r: { relType: string; direction: string }) => `${r.direction}:${r.relType}`;
    expect(result!.relationships.map(byKey).sort()).toEqual([
      'IN:KNOWS',
      'IN:WORKS_AT',
      'OUT:KNOWS',
      'OUT:WORKS_AT',
    ]);

    const outKnows = result!.relationships.find((r) => byKey(r) === 'OUT:KNOWS')!;
    expect(outKnows.targetLabels).toEqual(['Person']);
    expect(outKnows.targetProperties.name).toBe('bob');

    const inWorksAt = result!.relationships.find((r) => byKey(r) === 'IN:WORKS_AT')!;
    expect(inWorksAt.targetLabels).toEqual(['Company']);
    expect(inWorksAt.targetProperties.name).toBe('globex');
  });

  it('returns null for a non-existent elementId', async () => {
    const result = await getNodeForMarkdown(db, '4:00000000-0000-0000-0000-000000000000:999999');
    expect(result).toBeNull();
  });

  it('groups and sorts the raw relationships via groupRelationshipsForMarkdown', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      naming: {
        default: 'elementId' as const,
        overrides: {
          nodes: { Person: { property: 'name' }, Company: { property: 'name' } },
        },
      },
    };

    const result = await getNodeForMarkdown(db, aliceElementId);
    const groups = groupRelationshipsForMarkdown(result!.relationships, config);

    expect(groups.map((g) => g.key)).toEqual(['KNOWS', 'WORKS_AT', 'in_KNOWS', 'in_WORKS_AT']);

    const outKnows = groups.find((g) => g.key === 'KNOWS')!;
    expect(outKnows.links).toHaveLength(1);
    expect(outKnows.links[0]).toMatchObject({ targetLabel: 'Person', targetName: 'bob' });

    const inWorksAt = groups.find((g) => g.key === 'in_WORKS_AT')!;
    expect(inWorksAt.links[0]).toMatchObject({ targetLabel: 'Company', targetName: 'globex' });
  });
});
