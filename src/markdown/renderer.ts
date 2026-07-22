/**
 * Pure markdown renderer for a single graph node (markdown mode).
 *
 * Turns a node's resolved properties and relationship links into an
 * OKF-conformant markdown file: YAML frontmatter followed by a body
 * composed from the configured text properties.
 */

import { stringify as stringifyYaml } from 'yaml';
import type {
  Direction,
  LinkStyle,
  MarkdownFieldsConfig,
  MarkdownModeConfig,
  Properties,
  PropertyValue,
  TextPropertiesConfig,
} from '../types/index.js';

/**
 * A single relationship link to render in frontmatter, already resolved
 * to the target's label/name (i.e. the display name used for its file).
 */
export interface MarkdownRelationshipLink {
  /** Relationship type, e.g. "KNOWS" */
  type: string;
  /** Direction relative to the node being rendered */
  direction: Direction;
  /** Label of the target node */
  targetLabel: string;
  /** Display name of the target node */
  targetName: string;
}

/**
 * Fields resolved by a {@link FieldResolver} for the canonical OKF/Obsidian
 * frontmatter keys (title/timestamp/tags). `consumedProperties` lists the
 * source property names that were mapped, so the renderer excludes them
 * from the "remaining properties" section instead of duplicating them.
 */
export interface ResolvedFields {
  title?: PropertyValue;
  timestamp?: string;
  tags?: PropertyValue[];
  consumedProperties: Set<string>;
}

/**
 * Resolves the title/timestamp/tags fallback lookups (REQ-F-050/051/052).
 * Implemented properly in task-006 (src/markdown/fields.ts); the renderer
 * only depends on this interface so that implementation can be swapped in
 * (e.g. for a future CypherFieldResolver) without changing renderer code.
 */
export interface FieldResolver {
  resolve(
    labels: string[],
    properties: Properties,
    fieldsConfig: MarkdownFieldsConfig
  ): ResolvedFields;
}

/**
 * Default resolver that maps nothing. Used until task-006 wires in the
 * real fallback-list resolution logic.
 */
export const passthroughFieldResolver: FieldResolver = {
  resolve(): ResolvedFields {
    return { consumedProperties: new Set() };
  },
};

/** Input to {@link renderNodeMarkdown}. */
export interface RenderNodeInput {
  /** Node labels; the first is used as the frontmatter `type`. */
  labels: string[];
  /** Node properties, already transformed to plain PropertyValue shapes. */
  properties: Properties;
  /** Relationship links (both directions; filtering is done here). */
  relationships: MarkdownRelationshipLink[];
  /** Markdown mode configuration. */
  config: MarkdownModeConfig;
  /** Field resolver; defaults to a no-op resolver. */
  fieldResolver?: FieldResolver;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function resolveTextPropertyNames(
  textProperties: TextPropertiesConfig,
  label: string | undefined
): string[] {
  const override = label ? textProperties.overrides?.[label] : undefined;
  return override ?? textProperties.default;
}

export function toBodyText(value: PropertyValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function buildBody(properties: Properties, textPropertyNames: string[]): string {
  const sections: Array<{ name: string; text: string }> = [];

  for (const name of textPropertyNames) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) continue;
    const value = properties[name];
    if (value === undefined || value === null) continue;
    sections.push({ name, text: toBodyText(value) });
  }

  if (sections.length === 0) return '';
  if (sections.length === 1) return sections[0]!.text;
  return sections.map((section) => `## ${section.name}\n\n${section.text}`).join('\n\n');
}

/**
 * Renders a link to a `<Label>/<name>` concept file per the configured
 * link style. Shared with the index/log generators (src/markdown/index-
 * renderer.ts) so root/label/log links use the exact same convention as
 * relationship links within node files.
 */
export function renderConceptLink(targetLabel: string, targetName: string, linkStyle: LinkStyle): string {
  if (linkStyle === 'wikilink') {
    return `[[${targetLabel}/${targetName}]]`;
  }
  return `/${targetLabel}/${targetName}.md`;
}

function renderLink(link: MarkdownRelationshipLink, linkStyle: LinkStyle): string {
  return renderConceptLink(link.targetLabel, link.targetName, linkStyle);
}

function buildRelationshipEntries(
  relationships: MarkdownRelationshipLink[],
  config: MarkdownModeConfig
): Array<[string, PropertyValue]> {
  const groups = new Map<string, MarkdownRelationshipLink[]>();

  for (const link of relationships) {
    if (link.direction === 'IN' && !config.includeIncoming) continue;
    const key = link.direction === 'IN' ? `in_${link.type}` : link.type;
    const group = groups.get(key);
    if (group) {
      group.push(link);
    } else {
      groups.set(key, [link]);
    }
  }

  const sortedKeys = Array.from(groups.keys()).sort(compareStrings);

  return sortedKeys.map((key) => {
    const links = groups.get(key)!;
    const sortedLinks = [...links].sort((a, b) => compareStrings(a.targetName, b.targetName));
    const values: PropertyValue = sortedLinks.map((link) => renderLink(link, config.linkStyle));
    return [key, values];
  });
}

/**
 * Renders a single node as a markdown-mode file: YAML frontmatter
 * (type, then type_property if a literal 'type' property collided with
 * the label-derived type, then mapped fields, remaining properties
 * alphabetically, then per-relationship-type link keys alphabetically)
 * followed by a body composed from the configured text properties.
 */
export function renderNodeMarkdown(input: RenderNodeInput): string {
  const { labels, properties, relationships, config } = input;
  const fieldResolver = input.fieldResolver ?? passthroughFieldResolver;
  const resolved = fieldResolver.resolve(labels, properties, config.fields);

  const frontmatter: Properties = {};
  // Callers are expected to always pass at least one label; the fallback
  // guards noUncheckedIndexedAccess rather than papering over a real gap.
  frontmatter.type = labels[0] ?? '';

  // Label wins the 'type' key (REQ-F-021's "always includes type: <Label>"
  // is the load-bearing OKF invariant consumers rely on), and a colliding
  // property is demoted to 'type_property' rather than dropped, so both
  // values survive round-trip without ever changing what 'type' means. In
  // the rare case a node also has a literal 'type_property' property, that
  // property is overwritten by the demoted value here (an accepted,
  // deliberately unhandled double collision, not a silent bug).
  const hasTypeProperty = Object.prototype.hasOwnProperty.call(properties, 'type');
  const hasTypeClash = hasTypeProperty && properties.type !== undefined && properties.type !== null;
  if (hasTypeClash) frontmatter.type_property = properties.type!;

  if (resolved.title !== undefined) frontmatter.title = resolved.title;
  if (resolved.timestamp !== undefined) frontmatter.timestamp = resolved.timestamp;
  if (resolved.tags !== undefined) frontmatter.tags = resolved.tags;

  const textPropertyNames = resolveTextPropertyNames(config.textProperties, labels[0]);
  const textPropertySet = new Set(textPropertyNames);

  // Mapped-field and clash-resolution key names are excluded whenever
  // they were actually populated above, so an unrelated same-named
  // property can't silently overwrite a resolved value in the frontmatter
  // object below.
  const reservedKeys = new Set<string>(['type']);
  if (hasTypeClash) reservedKeys.add('type_property');
  if (resolved.title !== undefined) reservedKeys.add('title');
  if (resolved.timestamp !== undefined) reservedKeys.add('timestamp');
  if (resolved.tags !== undefined) reservedKeys.add('tags');

  const remainingKeys = Object.keys(properties)
    .filter((key) => !reservedKeys.has(key))
    .filter((key) => !resolved.consumedProperties.has(key))
    .filter((key) => !textPropertySet.has(key))
    .sort(compareStrings);

  for (const key of remainingKeys) {
    frontmatter[key] = properties[key]!;
  }

  for (const [key, value] of buildRelationshipEntries(relationships, config)) {
    frontmatter[key] = value;
  }

  const frontmatterYaml = stringifyYaml(frontmatter);
  const body = buildBody(properties, textPropertyNames);

  if (!body) {
    return `---\n${frontmatterYaml}---\n`;
  }
  return `---\n${frontmatterYaml}---\n\n${body}\n`;
}
