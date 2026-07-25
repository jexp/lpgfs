/**
 * Pure logic for the `lpgfs-import-vault` CLI (task-020): the inverse of
 * src/markdown/renderer.ts. Walks a markdown vault directory and turns it
 * into an in-memory graph description (nodes + relationships) that a
 * caller can MERGE into Neo4j. No filesystem writes, no driver calls, no
 * process/CLI concerns live here so it stays unit-testable without a live
 * database or mocked fs.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ConfigSchema, MarkdownModeConfig, Properties, PropertyValue } from '../types/index.js';
import { ROOT_INDEX_FILENAME, ROOT_LOG_FILENAME } from './markdown-path-parser.js';

/** A `<Label>/<name>.md` concept file discovered while walking a vault. */
export interface VaultConceptFile {
  label: string;
  name: string;
  filePath: string;
}

/** Frontmatter (parsed YAML) and body text split from a concept file's raw content. */
export interface FrontmatterAndBody {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** A link target resolved from a wikilink or bundle-relative markdown link string. */
export interface LinkTarget {
  label: string;
  name: string;
}

/** A body section: either the single unnamed section, or a `## <heading>`-delimited one. */
export interface BodySection {
  heading?: string;
  text: string;
}

/** One resolved node, keyed by `<label>/<name>` by the caller. */
export interface VaultNode {
  label: string;
  name: string;
  namingProperty: string;
  properties: Properties;
}

/** One resolved relationship, always normalized to its OUT direction. */
export interface VaultRelationship {
  fromLabel: string;
  fromName: string;
  type: string;
  toLabel: string;
  toName: string;
}

/** Full result of walking and parsing a vault directory. */
export interface ParsedVault {
  nodes: VaultNode[];
  relationships: VaultRelationship[];
}

const MAPPED_FIELD_KEYS = new Set(['title', 'timestamp', 'tags']);
const DEFAULT_NAMING_PROPERTY = 'name';

/**
 * Lists every `<Label>/<name>.md` concept file under a vault root.
 * Each direct subdirectory of `vaultRoot` is a label; `index.md`/`log.md`
 * are reserved bundle files and skipped at both the root and per-label
 * level (REQ-F-072). Non-directory entries at the root (loose files,
 * `.lpgfs.yaml`, etc.) are ignored — only directories become labels.
 */
export function walkVault(vaultRoot: string): VaultConceptFile[] {
  const results: VaultConceptFile[] = [];

  for (const rootEntry of readdirSync(vaultRoot, { withFileTypes: true })) {
    if (!rootEntry.isDirectory()) continue;
    const label = rootEntry.name;
    const labelDir = join(vaultRoot, label);

    for (const fileEntry of readdirSync(labelDir, { withFileTypes: true })) {
      if (!fileEntry.isFile()) continue;
      if (!fileEntry.name.endsWith('.md')) continue;
      if (fileEntry.name === ROOT_INDEX_FILENAME || fileEntry.name === ROOT_LOG_FILENAME) continue;

      const name = fileEntry.name.slice(0, -'.md'.length);
      if (name.length === 0) continue;

      results.push({ label, name, filePath: join(labelDir, fileEntry.name) });
    }
  }

  return results.sort((a, b) => `${a.label}/${a.name}`.localeCompare(`${b.label}/${b.name}`));
}

/**
 * Splits a concept file's raw content into parsed YAML frontmatter and
 * body text, inverting renderNodeMarkdown's
 * `---\n${frontmatterYaml}---\n` (empty body) /
 * `---\n${frontmatterYaml}---\n\n${body}\n` (non-empty body) shapes.
 */
export function splitFrontmatterAndBody(raw: string): FrontmatterAndBody {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const closeMarker = '\n---\n';
  const closeIdx = raw.indexOf(closeMarker, 4);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const frontmatterText = raw.slice(4, closeIdx);
  let body = raw.slice(closeIdx + closeMarker.length);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);

  const parsed = parseYaml(frontmatterText);
  const frontmatter = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return { frontmatter, body };
}

const HEADING_RE = /^## (.+)$/;

/**
 * Splits body text into sections, inverting buildBody's join convention
 * (single text property renders with no heading; multiple render as
 * `## <property>\n\n<text>` joined by a blank line).
 */
export function splitBodySections(body: string): BodySection[] {
  if (body === '') return [];

  const lines = body.split('\n');
  if (!lines.some((line) => HEADING_RE.test(line))) {
    return [{ text: body }];
  }

  const sections: BodySection[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    sections.push({ heading: current.heading, text });
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flush();
      current = { heading: match[1]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return sections;
}

const WIKILINK_RE = /^\[\[([^[\]/]+)\/(.+)\]\]$/;
const MARKDOWN_LINK_RE = /^\/([^/]+)\/(.+)\.md$/;

/**
 * Parses a single frontmatter value as a concept link, supporting both
 * the wikilink (`[[Label/name]]`) and bundle-relative markdown
 * (`/Label/name.md`) styles regardless of which `linkStyle` the vault's
 * config declares — a real-world vault may not perfectly match one style.
 */
export function parseLinkTarget(value: unknown): LinkTarget | null {
  if (typeof value !== 'string') return null;
  const wiki = value.match(WIKILINK_RE);
  if (wiki) return { label: wiki[1]!, name: wiki[2]! };
  const markdown = value.match(MARKDOWN_LINK_RE);
  if (markdown) return { label: markdown[1]!, name: markdown[2]! };
  return null;
}

/**
 * Recognizes a frontmatter value as a relationship-link key's value: a
 * single link string, or a non-empty array where every entry is a link.
 * Returns null (meaning "treat as a normal property") on anything else,
 * including an empty array or an array with any non-link entry.
 */
function parseLinkValues(value: unknown): LinkTarget[] | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const targets: LinkTarget[] = [];
    for (const entry of value) {
      const target = parseLinkTarget(entry);
      if (!target) return null;
      targets.push(target);
    }
    return targets;
  }
  const single = parseLinkTarget(value);
  return single ? [single] : null;
}

/** A relationship key/value pair recognized in frontmatter, direction-normalized. */
export interface FrontmatterRelationship {
  type: string;
  direction: 'IN' | 'OUT';
  targets: LinkTarget[];
}

/** Result of inverting a concept file's frontmatter (REQ-F-072/074, task-013's clash rule). */
export interface InvertedFrontmatter {
  label: string;
  properties: Properties;
  relationships: FrontmatterRelationship[];
}

/**
 * Inverts renderNodeMarkdown's frontmatter construction: resolves the
 * effective label from `type` (falling back to `directoryLabel` if
 * `type` is missing or not a string, tolerating a malformed/hand-edited
 * file), restores a clashing `type` property from `type_property` when
 * present (task-013's rule — label always wins the literal `type` key, so
 * a real `type` property can only survive under the demoted key), and
 * splits the remaining keys into mapped fields (title/timestamp/tags,
 * kept under their literal canonical key per REQ-F-074), relationship
 * links (recognized by value shape, not by name, so either linkStyle
 * parses), and plain properties.
 */
export function invertFrontmatter(
  frontmatter: Record<string, unknown>,
  directoryLabel: string
): InvertedFrontmatter {
  const rawType = frontmatter.type;
  const label = typeof rawType === 'string' && rawType.length > 0 ? rawType : directoryLabel;

  const properties: Properties = {};
  const relationships: FrontmatterRelationship[] = [];

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'type_property')) {
    properties.type = frontmatter.type_property as PropertyValue;
  }

  for (const key of Object.keys(frontmatter)) {
    if (key === 'type' || key === 'type_property') continue;

    const value = frontmatter[key];

    if (MAPPED_FIELD_KEYS.has(key)) {
      properties[key] = value as PropertyValue;
      continue;
    }

    const direction: 'IN' | 'OUT' = key.startsWith('in_') ? 'IN' : 'OUT';
    const relType = direction === 'IN' ? key.slice('in_'.length) : key;
    const targets = relType.length > 0 ? parseLinkValues(value) : null;

    if (targets) {
      relationships.push({ type: relType, direction, targets });
    } else {
      properties[key] = value as PropertyValue;
    }
  }

  return { label, properties, relationships };
}

/** Resolves the ordered text-property list for a label (mirrors renderer.ts's own lookup). */
function resolveTextPropertyNames(config: MarkdownModeConfig, label: string): string[] {
  return config.textProperties.overrides?.[label] ?? config.textProperties.default;
}

/**
 * Writes body sections back onto `properties` in place, inverting
 * buildBody: a single unnamed section goes to the label's first
 * configured text property; `## <heading>`-named sections go to the
 * property named by their heading.
 */
export function applyBodySections(
  properties: Properties,
  sections: BodySection[],
  config: MarkdownModeConfig,
  label: string
): void {
  if (sections.length === 0) return;

  if (sections.length === 1 && sections[0]!.heading === undefined) {
    const [textProperty] = resolveTextPropertyNames(config, label);
    if (textProperty) properties[textProperty] = sections[0]!.text;
    return;
  }

  for (const section of sections) {
    if (section.heading !== undefined) {
      properties[section.heading] = section.text;
    }
  }
}

/** Resolves the naming property for a label from config.naming, defaulting to `name`. */
export function resolveNamingProperty(config: ConfigSchema, label: string): string {
  return config.naming.overrides?.nodes?.[label]?.property ?? DEFAULT_NAMING_PROPERTY;
}

/**
 * Parses one concept file's raw content into its node properties and
 * frontmatter-declared relationships, given the label/name derived from
 * its position in the vault tree and the resolved markdown-mode config.
 */
export function parseConceptFile(
  raw: string,
  directoryLabel: string,
  name: string,
  config: ConfigSchema
): { label: string; properties: Properties; relationships: FrontmatterRelationship[] } {
  const { frontmatter, body } = splitFrontmatterAndBody(raw);
  const inverted = invertFrontmatter(frontmatter, directoryLabel);

  const namingProperty = resolveNamingProperty(config, inverted.label);
  inverted.properties[namingProperty] = name;

  const markdownConfig = config.mode.markdown;
  if (markdownConfig) {
    const sections = splitBodySections(body);
    applyBodySections(inverted.properties, sections, markdownConfig, inverted.label);
  }

  return { label: inverted.label, properties: inverted.properties, relationships: inverted.relationships };
}

/**
 * Reads and parses an entire vault directory into a flat node +
 * relationship description ready for MERGE. `readFile` is injected so
 * unit tests can exercise this without touching a real filesystem, while
 * the CLI passes `node:fs`'s `readFileSync`.
 */
export function buildVaultGraph(
  vaultRoot: string,
  config: ConfigSchema,
  readFile: (path: string) => string
): ParsedVault {
  const files = walkVault(vaultRoot);
  const nodes: VaultNode[] = [];
  const relationships: VaultRelationship[] = [];

  for (const file of files) {
    const raw = readFile(file.filePath);
    const { label, properties, relationships: relEntries } = parseConceptFile(
      raw,
      file.label,
      file.name,
      config
    );
    const namingProperty = resolveNamingProperty(config, label);

    nodes.push({ label, name: file.name, namingProperty, properties });

    for (const rel of relEntries) {
      for (const target of rel.targets) {
        if (rel.direction === 'OUT') {
          relationships.push({
            fromLabel: label,
            fromName: file.name,
            type: rel.type,
            toLabel: target.label,
            toName: target.name,
          });
        } else {
          relationships.push({
            fromLabel: target.label,
            fromName: target.name,
            type: rel.type,
            toLabel: label,
            toName: file.name,
          });
        }
      }
    }
  }

  return { nodes, relationships };
}
