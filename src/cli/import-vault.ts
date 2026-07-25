#!/usr/bin/env node
/**
 * lpgfs-import-vault CLI
 *
 * Bulk-imports a markdown vault directory into Neo4j (REQ-F-070–077):
 * the inverse of markdown mode's renderer, run entirely outside the FUSE
 * layer. Each vault subdirectory is a label, each `<name>.md` file (minus
 * `index.md`/`log.md`) is a node MERGEd on (label, naming property).
 *
 * Usage:
 *   npx lpgfs-import-vault <vaultDir> [options]
 *
 * See src/core/vault-import.ts for the pure parsing/graph-building logic.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { ConfigParser } from '../config/parser.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema } from '../types/index.js';
import { buildVaultGraph, resolveNamingProperty, type ParsedVault } from '../core/vault-import.js';

export interface ImportVaultOptions {
  db: string;
  config?: string;
  user?: string;
  password?: string;
  dryRun: boolean;
}

/**
 * Resolves the effective config for the import: loads `.lpgfs.yaml` if
 * `--config` points at a file, otherwise starts from the library
 * defaults. Either way `mode.markdown` is forced present (the import tool
 * always parses vault content as markdown mode, regardless of the
 * config's own `mode.type`) so downstream lookups never see `undefined`.
 */
export async function resolveImportConfig(configPath?: string): Promise<ConfigSchema> {
  const base = configPath && existsSync(configPath) ? await ConfigParser.load(configPath) : DEFAULT_CONFIG;

  return {
    ...base,
    mode: {
      type: 'markdown',
      markdown: base.mode.markdown ?? structuredClone(DEFAULT_MARKDOWN_MODE_CONFIG),
    },
  };
}

function quoteIdentifier(identifier: string): string {
  return '`' + identifier.replace(/`/g, '') + '`';
}

/** Renders the Cypher (and a human summary) that a real run would execute, for `--dry-run`. */
export function describeImportPlan(vault: ParsedVault, config: ConfigSchema): string {
  const lines: string[] = [];
  lines.push(`# Dry run: ${vault.nodes.length} node(s), ${vault.relationships.length} relationship(s)`);
  lines.push('');

  const namingProperty = (label: string): string => resolveNamingProperty(config, label);

  for (const node of vault.nodes) {
    const propsPreview = JSON.stringify(node.properties);
    lines.push(
      `MERGE (n:${quoteIdentifier(node.label)} {${quoteIdentifier(node.namingProperty)}: ${JSON.stringify(
        node.name
      )}}) SET n += ${propsPreview};`
    );
  }

  for (const rel of vault.relationships) {
    lines.push(
      `MATCH (a:${quoteIdentifier(rel.fromLabel)} {${quoteIdentifier(namingProperty(rel.fromLabel))}: ${JSON.stringify(rel.fromName)}}), ` +
        `(b:${quoteIdentifier(rel.toLabel)} {${quoteIdentifier(namingProperty(rel.toLabel))}: ${JSON.stringify(rel.toName)}}) ` +
        `MERGE (a)-[:${quoteIdentifier(rel.type)}]->(b);`
    );
  }

  return lines.join('\n');
}

/**
 * Executes the import against a live Neo4j via MERGE (REQ-F-075:
 * idempotent, safe to re-run). Nodes are written before relationships so
 * every relationship's endpoints already exist regardless of file walk
 * order.
 */
export async function executeImport(
  driver: Driver,
  vault: ParsedVault,
  config: ConfigSchema
): Promise<{ nodesMerged: number; relationshipsMerged: number }> {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.executeWrite(async (tx) => {
      for (const node of vault.nodes) {
        const cypher = `MERGE (n:${quoteIdentifier(node.label)} {${quoteIdentifier(
          node.namingProperty
        )}: $name}) SET n += $props`;
        await tx.run(cypher, { name: node.name, props: node.properties });
      }

      for (const rel of vault.relationships) {
        const fromNamingProperty = quoteIdentifier(resolveNamingProperty(config, rel.fromLabel));
        const toNamingProperty = quoteIdentifier(resolveNamingProperty(config, rel.toLabel));
        const cypher =
          `MATCH (a:${quoteIdentifier(rel.fromLabel)} {${fromNamingProperty}: $fromName}), ` +
          `(b:${quoteIdentifier(rel.toLabel)} {${toNamingProperty}: $toName}) ` +
          `MERGE (a)-[:${quoteIdentifier(rel.type)}]->(b)`;
        await tx.run(cypher, { fromName: rel.fromName, toName: rel.toName });
      }
    });
  } finally {
    await session.close();
  }

  return { nodesMerged: vault.nodes.length, relationshipsMerged: vault.relationships.length };
}

function validateVaultDir(vaultDir: string): string {
  const absolutePath = resolve(vaultDir);
  if (!existsSync(absolutePath)) {
    throw new Error(`Vault directory does not exist: ${absolutePath}`);
  }
  if (!statSync(absolutePath).isDirectory()) {
    throw new Error(`Vault path is not a directory: ${absolutePath}`);
  }
  return absolutePath;
}

export function createImportProgram(exitOverride = false): Command {
  const program = new Command();

  if (exitOverride) {
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  }

  program
    .name('lpgfs-import-vault')
    .description('Mirror a markdown (Obsidian-style) vault into a Neo4j graph, inverting markdown mode.')
    .version('0.1.0')
    .argument('<vaultDir>', 'Vault directory to import')
    .option('--db <uri>', 'Database connection URI', 'neo4j://localhost:7687')
    .option('--config <path>', 'Path to .lpgfs.yaml config file (for naming/markdown settings)')
    .option('--user <name>', 'Database username')
    .option('--password <pass>', 'Database password')
    .option('--dry-run', 'Print intended Cypher/summary without executing', false);

  return program;
}

export async function runImportVault(argv: string[]): Promise<void> {
  const program = createImportProgram(true);
  program.parse(argv, { from: 'user' });

  const vaultDir = validateVaultDir(program.args[0]!);
  const opts = program.opts() as ImportVaultOptions;

  const config = await resolveImportConfig(opts.config);
  const vault = buildVaultGraph(vaultDir, config, (path) => readFileSync(path, 'utf-8'));

  if (opts.dryRun) {
    console.log(describeImportPlan(vault, config));
    return;
  }

  const driver = neo4j.driver(
    opts.db,
    opts.user && opts.password ? neo4j.auth.basic(opts.user, opts.password) : undefined
  );

  try {
    const result = await executeImport(driver, vault, config);
    console.log(
      `Imported vault ${vaultDir}: merged ${result.nodesMerged} node(s), ${result.relationshipsMerged} relationship(s).`
    );
  } finally {
    await driver.close();
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/cli/import-vault.js') || process.argv[1].endsWith('/cli/import-vault.ts'));

if (isMain) {
  runImportVault(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : 'An unexpected error occurred'}`);
    process.exit(1);
  });
}
