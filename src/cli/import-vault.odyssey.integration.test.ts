/**
 * Integration test for the lpgfs-import-vault CLI (task-020) against a
 * REAL Neo4j: provisions an ephemeral Docker instance (neo4j-cli skill),
 * imports test/fixtures/odyssey/ with buildVaultGraph + executeImport,
 * then verifies:
 *   (a) the import completes without error and produces the expected
 *       node/relationship counts and the Odysseus[Character,Hero]
 *       multi-label node (task-009's first-label-wins fixture),
 *   (b) re-running the import against the same database is idempotent
 *       (no duplicate nodes/relationships),
 *   (c) re-rendering the imported graph through the existing renderer
 *       (via handlers.getattr/read, the same plumbing
 *       handlers.markdown.odyssey.integration.test.ts uses) reproduces
 *       each fixture file, modulo the documented title/timestamp/tags
 *       canonical-key round-trip limitation (REQ-F-074). Concretely,
 *       under this vault's field-mapping config, that limitation shows
 *       up as two related gaps this test's comparison normalizes away:
 *         - `timestamp`'s fallback list (updated/lastUpdated/modified/
 *           created) does not include the literal key `timestamp`
 *           itself, so a node with a resolvable timestamp before import
 *           has no timestamp line after import.
 *         - `title`'s fallback list IS `[title, name]`, so a node
 *           without a literal `title` property originally had its
 *           `name` property *consumed* by the title fallback (never
 *           appearing as a separate remaining property in the fixture).
 *           After import, a literal `title` property always exists
 *           (REQ-F-074), so the title fallback stops at `title` and
 *           `name` is newly visible as an ordinary remaining property.
 *       Both gaps are presence/provenance differences, not value bugs —
 *       `title`/`tags` values round-trip exactly since their fallback
 *       lists do include their own canonical key.
 *
 * Requires Neo4j connection credentials, supplied either via a repo-root
 * `integration.env` file (KEY=VALUE per line, per AGENTS.md convention) or
 * via the equivalent process env vars. Automatically SKIPPED (not failed)
 * when neither is present, so `npm test` stays green without Docker.
 *
 * To run locally with an ephemeral Docker Neo4j (via the neo4j-cli skill):
 *
 *   neo4j-cli docker create --name lpgfs-task020 --ephemeral --edition community \
 *     --env-out-file integration.env --wait --rw
 *   npm test -- src/cli/import-vault.odyssey.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import neo4j, { type Driver } from 'neo4j-driver';
import { createConnection, type DatabaseConnection } from '../db/connection.js';
import { getattr, read, createHandlerContext } from '../fuse/handlers.js';
import type { HandlerContext } from '../fuse/handlers.js';
import { Cache } from '../cache/index.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema } from '../types/index.js';
import { buildVaultGraph } from '../core/vault-import.js';
import { executeImport } from './import-vault.js';

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

const FIXTURE_ROOT = resolve(process.cwd(), 'test/fixtures/odyssey');
const LABELS = ['Character', 'Place', 'Creature', 'Event'];

function conceptFilesForLabel(label: string): string[] {
  return readdirSync(join(FIXTURE_ROOT, label))
    .filter((name) => name.endsWith('.md') && name !== 'index.md' && name !== 'log.md')
    .sort();
}

/**
 * Parses a rendered markdown-mode file into frontmatter + body for
 * tolerant comparison, dropping `timestamp` and `name` — the two keys
 * whose presence (not value) is affected by REQ-F-074's canonical-key
 * round-trip limitation under this vault's field-mapping config (see
 * file header). Comparing structurally, rather than byte-for-byte, also
 * avoids false failures from key-order shifts caused by `name`
 * appearing/disappearing among the alphabetically-sorted remaining keys.
 */
function normalizeForComparison(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const parsed = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
  const { timestamp, name, ...frontmatter } = parsed;
  void timestamp;
  void name;

  let body = match[2] ?? '';
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);

  return { frontmatter, body };
}

describe.skipIf(!uri)('lpgfs-import-vault against the Odyssey fixture vault (Docker integration)', () => {
  let writeDriver: Driver;
  let db: DatabaseConnection;
  let ctx: HandlerContext;

  const config: ConfigSchema = {
    ...DEFAULT_CONFIG,
    naming: {
      default: 'elementId',
      overrides: {
        nodes: {
          Character: { property: 'name' },
          Place: { property: 'name' },
          Creature: { property: 'name' },
          Event: { property: 'name' },
        },
      },
    },
    mode: {
      type: 'markdown',
      markdown: {
        ...DEFAULT_MARKDOWN_MODE_CONFIG,
        labels: LABELS,
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

    const wipeSession = writeDriver.session();
    try {
      await wipeSession.run('MATCH (n) DETACH DELETE n');
    } finally {
      await wipeSession.close();
    }

    const vault = buildVaultGraph(FIXTURE_ROOT, config, (path) => readFileSync(path, 'utf-8'));
    await executeImport(writeDriver, vault, config);

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
    await writeDriver.close();
  });

  it('imports the expected node/relationship counts', async () => {
    const session = writeDriver.session();
    try {
      const nodeResult = await session.run('MATCH (n) RETURN count(n) AS c');
      expect(nodeResult.records[0]!.get('c').toNumber()).toBe(20);

      const relResult = await session.run('MATCH ()-[r]->() RETURN count(r) AS c');
      expect(relResult.records[0]!.get('c').toNumber()).toBe(30);

      const labelCounts = await session.run(
        'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS c ORDER BY label'
      );
      const counts = Object.fromEntries(
        labelCounts.records.map((r) => [r.get('label') as string, (r.get('c') as { toNumber(): number }).toNumber()])
      );
      expect(counts).toEqual({ Character: 7, Creature: 4, Event: 4, Place: 5 });
    } finally {
      await session.close();
    }
  });

  it('restores a real type property demoted to type_property (task-013 inversion)', async () => {
    const session = writeDriver.session();
    try {
      const result = await session.run('MATCH (c:Character {name: $name}) RETURN properties(c) AS p', {
        name: 'Circe',
      });
      const props = result.records[0]!.get('p') as Record<string, unknown>;
      expect(props.type).toBe('Sorceress');
      expect(props.name).toBe('Circe');
      expect(props.timestamp).toBe('2026-03-15T15:00:00Z');
      expect(props.tags).toEqual(['sorceress', 'divine']);
    } finally {
      await session.close();
    }
  });

  it('is idempotent: re-running the import against the same database adds no duplicates', async () => {
    const vault = buildVaultGraph(FIXTURE_ROOT, config, (path) => readFileSync(path, 'utf-8'));
    const result = await executeImport(writeDriver, vault, config);
    expect(result.nodesMerged).toBe(20);
    expect(result.relationshipsMerged).toBe(30);

    const session = writeDriver.session();
    try {
      const nodeResult = await session.run('MATCH (n) RETURN count(n) AS c');
      expect(nodeResult.records[0]!.get('c').toNumber()).toBe(20);

      const relResult = await session.run('MATCH ()-[r]->() RETURN count(r) AS c');
      expect(relResult.records[0]!.get('c').toNumber()).toBe(30);
    } finally {
      await session.close();
    }
  });

  for (const label of LABELS) {
    for (const fileName of conceptFilesForLabel(label)) {
      it(`re-rendering /${label}/${fileName} reproduces the fixture modulo the title/timestamp/tags limitation`, async () => {
        const path = `/${label}/${fileName}`;
        const expected = readFileSync(join(FIXTURE_ROOT, label, fileName), 'utf-8');

        await getattr(path, ctx);
        const result = await read(path, ctx);

        expect(normalizeForComparison(result.content)).toEqual(normalizeForComparison(expected));
      });
    }
  }
});
