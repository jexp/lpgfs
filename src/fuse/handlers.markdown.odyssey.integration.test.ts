/**
 * Integration test verifying that markdown mode reproduces
 * test/fixtures/odyssey/ against a REAL database, not just an in-memory
 * fixture load. Task-015 (an in-memory renderer round-trip test against
 * these same fixtures, no live DB) is still pending as of this writing;
 * until it lands, this is the only automated test reproducing the
 * fixture vault at all.
 *
 * Provisions an ephemeral Neo4j via Docker (neo4j-cli skill), applies
 * test/fixtures/odyssey/import.cypher verbatim, then drives the same
 * handler functions the FUSE layer calls (readdir/getattr/read from
 * handlers.ts) against the live database and diffs their output
 * byte-for-byte against the fixture files on disk.
 *
 * Real FUSE mounting is intentionally NOT attempted here: fuse-native
 * requires an OS-level FUSE install (macFUSE/libfuse) that daemon.test.ts
 * documents as unavailable in this environment ("fuse-native and FUSE to
 * be installed. Instead, they test the daemon structure."), and
 * handlers.markdown.integration.test.ts / handlers.markdown.log.integration.test.ts
 * already established the handler-level pattern as the portable substitute.
 * A full real-mount `diff -r` procedure is documented as a manual step in
 * test/manual.md for environments where FUSE is actually installed.
 *
 * Known gap (task-019, not yet landed): readdir on markdown-mode root/label
 * directories does not yet list index.md/log.md entries alongside concept
 * files, so this test cannot assert readdir-based directory-listing parity
 * for the generated files — it instead calls getattr/read on their known
 * paths directly and compares content, which is the part that matters for
 * "does markdown mode reproduce test/fixtures/odyssey/".
 *
 * Requires Neo4j connection credentials, supplied either via a repo-root
 * `integration.env` file (KEY=VALUE per line, per AGENTS.md convention) or
 * via the equivalent process env vars. Automatically SKIPPED (not failed)
 * when neither is present, so `npm test` stays green without Docker.
 *
 * To run locally with an ephemeral Docker Neo4j (via the neo4j-cli skill):
 *
 *   neo4j-cli docker create --name lpgfs-odyssey --ephemeral --edition community \
 *     --env-out-file integration.env --wait --rw
 *   cat test/fixtures/odyssey/import.cypher | cypher-shell -a <bolt-uri> -u neo4j -p <password>
 *   npm test -- src/fuse/handlers.markdown.odyssey.integration.test.ts
 *
 * (This test applies import.cypher itself via the driver in beforeAll —
 * the cypher-shell invocation above is only needed for manual/ad-hoc runs.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
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

const FIXTURE_ROOT = resolve(process.cwd(), 'test/fixtures/odyssey');
const LABELS = ['Character', 'Place', 'Creature', 'Event'];

/**
 * Splits import.cypher into individually runnable statements. The file
 * only uses full-line `//` comments and semicolons that terminate a
 * statement (never inside a string literal), so a comment-strip + `;`
 * split is safe here.
 */
function splitCypherStatements(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

function conceptFilesForLabel(label: string): string[] {
  return readdirSync(join(FIXTURE_ROOT, label))
    .filter((name) => name.endsWith('.md') && name !== 'index.md')
    .sort();
}

describe.skipIf(!uri)('markdown mode reproduces the Odyssey fixture vault (Docker integration)', () => {
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
        : undefined,
    );

    const script = readFileSync(join(FIXTURE_ROOT, 'import.cypher'), 'utf-8');
    const statements = splitCypherStatements(script);

    const writeSession = writeDriver.session();
    try {
      for (const statement of statements) {
        await writeSession.run(statement);
      }
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
      await writeSession.run('MATCH (n) DETACH DELETE n');
    } finally {
      await writeSession.close();
      await writeDriver.close();
    }
  });

  it('root readdir lists exactly the four fixture label directories', async () => {
    const entries = await readdir('/', ctx);
    expect(entries.map((e) => e.name).sort()).toEqual([...LABELS].sort());
  });

  for (const label of LABELS) {
    it(`readdir /${label} lists exactly the fixture's concept files`, async () => {
      const expectedFiles = conceptFilesForLabel(label);
      const entries = await readdir(`/${label}`, ctx);
      expect(entries.map((e) => e.name).sort()).toEqual(expectedFiles);
    });
  }

  for (const label of LABELS) {
    for (const fileName of conceptFilesForLabel(label)) {
      it(`/${label}/${fileName} reproduces the fixture file byte-for-byte`, async () => {
        const path = `/${label}/${fileName}`;
        const expected = readFileSync(join(FIXTURE_ROOT, label, fileName), 'utf-8');

        const stat = await getattr(path, ctx);
        const result = await read(path, ctx);

        expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
        expect(result.content).toBe(expected);
      });
    }
  }

  it('/index.md reproduces the fixture root index byte-for-byte', async () => {
    const expected = readFileSync(join(FIXTURE_ROOT, 'index.md'), 'utf-8');

    const stat = await getattr('/index.md', ctx);
    const result = await read('/index.md', ctx);

    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
    expect(result.content).toBe(expected);
  });

  for (const label of LABELS) {
    it(`/${label}/index.md reproduces the fixture's per-label index byte-for-byte`, async () => {
      const expected = readFileSync(join(FIXTURE_ROOT, label, 'index.md'), 'utf-8');

      const stat = await getattr(`/${label}/index.md`, ctx);
      const result = await read(`/${label}/index.md`, ctx);

      expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
      expect(result.content).toBe(expected);
    });
  }

  it('/log.md reproduces the fixture log byte-for-byte', async () => {
    const expected = readFileSync(join(FIXTURE_ROOT, 'log.md'), 'utf-8');

    const stat = await getattr('/log.md', ctx);
    const result = await read('/log.md', ctx);

    expect(Buffer.byteLength(result.content, 'utf8')).toBe(stat.size);
    expect(result.content).toBe(expected);
  });
});
