/**
 * Database Queries
 *
 * Cypher queries for fetching graph data from Neo4j.
 * All queries support optional caching to reduce database load.
 */

import type { DatabaseConnection } from './connection.js';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  Direction,
  LabelPropertyListOverrides,
  MarkdownFieldsConfig,
  NamingStrategy,
  NodeQueryResult,
  Properties,
  PropertyValue,
  RelationshipQueryResult,
  TextPropertiesConfig,
} from '../types/index.js';
import { sanitize, sanitizeElementId } from '../config/sanitize.js';
import { resolveCollisions } from '../config/collision.js';
import { Cache, cacheKey } from '../cache/index.js';
import { toIsoTimestamp } from '../markdown/fields.js';

/**
 * Get all node labels in the database.
 *
 * @param db Database connection
 * @param cache Optional cache instance for caching results (TTL: 60s)
 * @returns Array of label names
 */
export async function getLabels(
  db: DatabaseConnection,
  cache?: Cache
): Promise<string[]> {
  const key = cacheKey.labels();

  // Check cache first
  if (cache) {
    const cached = cache.get<string[]>(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  const result = await db.executeQuery<{ label: string }>(
    'CALL db.labels() YIELD label RETURN label'
  );

  const labels = result.records.map((record) => record.label);

  // Store in cache
  if (cache) {
    cache.set(key, labels);
  }

  return labels;
}

/**
 * Get the naming strategy for a given label.
 * Returns 'property' if there's a per-label override, otherwise the default strategy.
 */
function getNamingStrategy(label: string, config: ConfigSchema): NamingStrategy {
  const override = config.naming.overrides?.nodes?.[label];
  if (override) {
    return 'property';
  }
  return config.naming.default;
}

/**
 * Get the property name to use for naming a label.
 * Returns the property from the per-label override, or undefined if using elementId strategy.
 */
function getPropertyName(label: string, config: ConfigSchema): string | undefined {
  return config.naming.overrides?.nodes?.[label]?.property;
}

/**
 * Deterministically picks a single rendering label for a multi-label node
 * (REQ-F-014). If `mode.markdown.labels` is configured, its ordering is an
 * explicit user choice, so the first label in that list that the node
 * actually carries wins; otherwise (or if none of the node's labels appear
 * in that list) the alphabetically-first of the node's own labels wins.
 * Applied identically wherever a multi-label node's identity matters
 * (label-listing, node lookup, relationship-link target rendering) so it is
 * never duplicated across the labels it carries.
 */
export function chooseNodeLabel(nodeLabels: string[], configuredLabelOrder?: string[]): string {
  if (configuredLabelOrder && configuredLabelOrder.length > 0) {
    const firstConfigured = configuredLabelOrder.find((label) => nodeLabels.includes(label));
    if (firstConfigured !== undefined) return firstConfigured;
  }
  return [...nodeLabels].sort()[0] ?? '';
}

/**
 * Get all nodes of a given label with display names.
 *
 * @param db Database connection
 * @param label The node label to query
 * @param config Configuration schema for naming
 * @param cache Optional cache instance for caching results (TTL: 30s)
 * @returns Array of nodes with display names
 *
 * @example
 * // With default config (elementId naming)
 * const nodes = await getNodesByLabel(db, 'Person');
 * // Returns: [{ name: '4_abc123_0', elementId: '4:abc123:0', properties: {...} }]
 *
 * @example
 * // With property naming override
 * const config = {
 *   naming: {
 *     default: 'elementId',
 *     overrides: { nodes: { Person: { property: 'username' } } }
 *   }
 * };
 * const nodes = await getNodesByLabel(db, 'Person', config);
 * // Returns: [{ name: 'alice', elementId: '4:abc123:0', properties: { username: 'alice', ... } }]
 */
export async function getNodesByLabel(
  db: DatabaseConnection,
  label: string,
  config: ConfigSchema = DEFAULT_CONFIG,
  cache?: Cache
): Promise<NodeQueryResult[]> {
  const key = cacheKey.nodes(label);

  // Check cache first
  if (cache) {
    const cached = cache.get<NodeQueryResult[]>(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Query all nodes with the given label
  // Using backticks to safely escape the label name in Cypher
  const result = await db.executeQuery<{
    elementId: string;
    properties: Properties;
    labels?: string[];
  }>(
    `MATCH (n:\`${label}\`) RETURN elementId(n) AS elementId, properties(n) AS properties, labels(n) AS labels`
  );

  // Handle empty result
  if (result.records.length === 0) {
    if (cache) {
      cache.set(key, []);
    }
    return [];
  }

  // Determine naming strategy for this label
  const namingStrategy = getNamingStrategy(label, config);
  const propertyName = getPropertyName(label, config);

  // Build base names for collision resolution
  const items = result.records.map((record) => {
    let baseName: string;

    if (namingStrategy === 'property' && propertyName) {
      // Use property value for naming
      const propValue = record.properties[propertyName];
      // Handle missing property by falling back to elementId
      if (propValue === undefined) {
        baseName = sanitizeElementId(record.elementId, config.sanitization);
      } else {
        baseName = sanitize(propValue, config.sanitization);
      }
    } else {
      // Use elementId for naming (default fallback)
      baseName = sanitizeElementId(record.elementId, config.sanitization);
    }

    return {
      baseName,
      elementId: record.elementId,
      properties: record.properties,
      // Falls back to just the queried label when a caller's mocked
      // result omits labels(n) (real Cypher always returns it).
      labels: record.labels ?? [label],
    };
  });

  // Resolve collisions
  const resolvedNames = resolveCollisions(
    items.map(({ baseName, elementId }) => ({ baseName, elementId })),
    label,
    config.collision
  );

  // Build final results (arrays have same length, so index is always valid)
  const nodes = items.map((item, index) => ({
    name: resolvedNames[index]!,
    elementId: item.elementId,
    properties: item.properties,
    labels: item.labels,
  }));

  // Store in cache
  if (cache) {
    cache.set(key, nodes);
  }

  return nodes;
}

/**
 * Result from getNodeProperties: node properties with _elementId included.
 */
export interface NodePropertiesResult {
  /** The database element ID, prefixed with underscore as per PRD */
  _elementId: string;
  /** All other properties spread into the result */
  [key: string]: PropertyValue;
}

/**
 * Get a single node's properties by its display name.
 *
 * Supports both naming strategies (elementId and property) by using
 * the same naming logic as getNodesByLabel to find the matching node.
 *
 * @param db Database connection
 * @param label The node label
 * @param name The display name (filesystem directory name) to look up
 * @param config Configuration schema for naming
 * @param cache Optional cache instance for caching results (TTL: 10s for props, 30s for nodes)
 * @returns Node properties with _elementId, or null if not found
 *
 * @example
 * // With default config (elementId naming)
 * const props = await getNodeProperties(db, 'Person', '4_abc123_0');
 * // Returns: { _elementId: '4:abc123:0', username: 'alice', age: 30 }
 *
 * @example
 * // With property naming
 * const props = await getNodeProperties(db, 'Person', 'alice');
 * // Returns: { _elementId: '4:abc123:0', username: 'alice', age: 30 }
 *
 * @example
 * // Not found
 * const props = await getNodeProperties(db, 'Person', 'nonexistent');
 * // Returns: null
 */
export async function getNodeProperties(
  db: DatabaseConnection,
  label: string,
  name: string,
  config: ConfigSchema = DEFAULT_CONFIG,
  cache?: Cache
): Promise<NodePropertiesResult | null> {
  // Get all nodes for this label with their display names
  // This ensures consistent naming logic (sanitization, collision handling)
  // The getNodesByLabel call will use its own cache (nodes: TTL 30s)
  const nodes = await getNodesByLabel(db, label, config, cache);

  // Find the node with matching display name
  const node = nodes.find((n) => n.name === name);

  if (!node) {
    return null;
  }

  // Note: We don't cache individual node properties separately here because:
  // 1. The nodes list is already cached via getNodesByLabel
  // 2. Properties are included in the NodeQueryResult
  // 3. The lookup is O(n) in-memory (fast) after the nodes are cached
  // If we wanted separate caching for properties, we'd cache by elementId:
  // cache.set(cacheKey.props(node.elementId), result);

  // Return properties with _elementId as per PRD section 5.1
  return {
    _elementId: node.elementId,
    ...node.properties,
  };
}

/**
 * Get all distinct relationship types connected to a node.
 *
 * Returns both outgoing and incoming relationship types.
 *
 * @param db Database connection
 * @param label The node label
 * @param name The display name (filesystem directory name) to look up
 * @param config Configuration schema for naming
 * @param cache Optional cache instance for caching results (TTL: 10s for reltypes, 30s for nodes)
 * @returns Array of distinct relationship type names, or empty array if node not found or has no relationships
 *
 * @example
 * // Node alice has KNOWS (out) and WORKS_AT (out) relationships
 * const relTypes = await getRelationshipTypes(db, 'Person', 'alice');
 * // Returns: ['KNOWS', 'WORKS_AT']
 *
 * @example
 * // Node with no relationships
 * const relTypes = await getRelationshipTypes(db, 'Person', 'newuser');
 * // Returns: []
 */
export async function getRelationshipTypes(
  db: DatabaseConnection,
  label: string,
  name: string,
  config: ConfigSchema = DEFAULT_CONFIG,
  cache?: Cache
): Promise<string[]> {
  // First, find the node to get its elementId
  // This ensures consistent naming logic with the filesystem
  // The getNodesByLabel call will use its own cache (nodes: TTL 30s)
  const nodes = await getNodesByLabel(db, label, config, cache);
  const node = nodes.find((n) => n.name === name);

  if (!node) {
    return [];
  }

  // Check cache for relationship types
  const key = cacheKey.reltypes(node.elementId);
  if (cache) {
    const cached = cache.get<string[]>(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Query for distinct relationship types connected to this node
  // Using elementId(n) to match the specific node
  const result = await db.executeQuery<{ relType: string }>(
    `MATCH (n)-[r]-() WHERE elementId(n) = $elementId RETURN DISTINCT type(r) AS relType`,
    { elementId: node.elementId }
  );

  const relTypes = result.records.map((record) => record.relType);

  // Store in cache
  if (cache) {
    cache.set(key, relTypes);
  }

  return relTypes;
}

/**
 * Get relationships of a specific type and direction from a node.
 *
 * Returns target node info (name, label, elementId) plus relationship properties.
 * Target node names are determined using the same naming logic as getNodesByLabel.
 *
 * @param db Database connection
 * @param label The source node label
 * @param name The source node display name (filesystem directory name)
 * @param relType The relationship type (e.g., 'KNOWS', 'WORKS_AT')
 * @param direction The direction: 'OUT' for outgoing, 'IN' for incoming
 * @param config Configuration schema for naming
 * @param cache Optional cache instance for caching results (TTL: 10s)
 * @returns Array of relationship results with target info, or empty array if node not found
 *
 * @example
 * // Get Alice's outgoing KNOWS relationships
 * const rels = await getRelationships(db, 'Person', 'alice', 'KNOWS', 'OUT');
 * // Returns: [{
 * //   targetName: 'james',
 * //   targetLabel: 'Person',
 * //   targetElementId: '4:abc:1',
 * //   relElementId: '5:abc:7',
 * //   relProperties: { since: 2020 }
 * // }]
 *
 * @example
 * // Get Alice's incoming KNOWS relationships
 * const rels = await getRelationships(db, 'Person', 'alice', 'KNOWS', 'IN');
 * // Returns: [{ targetName: 'carol', targetLabel: 'Person', ... }]
 *
 * @example
 * // Cross-label relationship (Person WORKS_AT Company)
 * const rels = await getRelationships(db, 'Person', 'alice', 'WORKS_AT', 'OUT');
 * // Returns: [{ targetName: 'acme', targetLabel: 'Company', ... }]
 */
export async function getRelationships(
  db: DatabaseConnection,
  label: string,
  name: string,
  relType: string,
  direction: Direction,
  config: ConfigSchema = DEFAULT_CONFIG,
  cache?: Cache
): Promise<RelationshipQueryResult[]> {
  // First, find the source node to get its elementId
  // The getNodesByLabel call will use its own cache (nodes: TTL 30s)
  const nodes = await getNodesByLabel(db, label, config, cache);
  const sourceNode = nodes.find((n) => n.name === name);

  if (!sourceNode) {
    return [];
  }

  // Check cache for relationships
  const key = cacheKey.rels(sourceNode.elementId, relType, direction);
  if (cache) {
    const cached = cache.get<RelationshipQueryResult[]>(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Build the Cypher query based on direction
  // OUT: (n)-[r:TYPE]->(m) - n is start node, m is end node (target)
  // IN: (n)<-[r:TYPE]-(m) - n is end node, m is start node (target)
  const cypher =
    direction === 'OUT'
      ? `MATCH (n)-[r:\`${relType}\`]->(m) WHERE elementId(n) = $elementId
         RETURN elementId(r) AS relElementId, properties(r) AS relProperties,
                elementId(m) AS targetElementId, labels(m) AS targetLabels,
                properties(m) AS targetProperties`
      : `MATCH (n)<-[r:\`${relType}\`]-(m) WHERE elementId(n) = $elementId
         RETURN elementId(r) AS relElementId, properties(r) AS relProperties,
                elementId(m) AS targetElementId, labels(m) AS targetLabels,
                properties(m) AS targetProperties`;

  const result = await db.executeQuery<{
    relElementId: string;
    relProperties: Properties;
    targetElementId: string;
    targetLabels: string[];
    targetProperties: Properties;
  }>(cypher, { elementId: sourceNode.elementId });

  if (result.records.length === 0) {
    if (cache) {
      cache.set(key, []);
    }
    return [];
  }

  // For each target node, we need to determine its display name
  // The naming strategy depends on the target node's label
  const relationships: RelationshipQueryResult[] = [];

  for (const record of result.records) {
    // Use the first label as the primary label for naming purposes
    // (Neo4j nodes can have multiple labels, but we use the first one for directory structure)
    const targetLabel = record.targetLabels[0] || 'Unknown';

    // Determine target node's display name using the same naming logic
    const namingStrategy = getNamingStrategy(targetLabel, config);
    const propertyName = getPropertyName(targetLabel, config);

    let targetName: string;
    if (namingStrategy === 'property' && propertyName) {
      const propValue = record.targetProperties[propertyName];
      if (propValue === undefined) {
        targetName = sanitizeElementId(record.targetElementId, config.sanitization);
      } else {
        targetName = sanitize(propValue, config.sanitization);
      }
    } else {
      targetName = sanitizeElementId(record.targetElementId, config.sanitization);
    }

    relationships.push({
      targetName,
      targetLabel,
      targetElementId: record.targetElementId,
      relElementId: record.relElementId,
      relProperties: record.relProperties,
    });
  }

  // Handle collisions within the same label (targets with same display name)
  // Group by target label since collisions are per-label
  const byLabel = new Map<string, number[]>();
  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i]!;
    const indices = byLabel.get(rel.targetLabel) || [];
    indices.push(i);
    byLabel.set(rel.targetLabel, indices);
  }

  // Resolve collisions within each label group
  for (const [targetLabel, indices] of byLabel) {
    const items = indices.map((i) => ({
      baseName: relationships[i]!.targetName,
      elementId: relationships[i]!.targetElementId,
    }));

    const resolvedNames = resolveCollisions(items, targetLabel, config.collision);

    // Update with resolved names
    for (let j = 0; j < indices.length; j++) {
      relationships[indices[j]!]!.targetName = resolvedNames[j]!;
    }
  }

  // Store in cache
  if (cache) {
    cache.set(key, relationships);
  }

  return relationships;
}

/**
 * A single raw relationship row as returned by getNodeForMarkdown's Cypher
 * query, before any grouping/sorting/naming resolution (all done
 * client-side by groupRelationshipsForMarkdown).
 */
export interface MarkdownRelationshipRow {
  relType: string;
  direction: Direction;
  targetLabels: string[];
  targetElementId: string;
  targetProperties: Properties;
}

/**
 * Result of getNodeForMarkdown: a node's labels/properties plus every
 * relationship (both directions, all types) as raw, ungrouped rows.
 */
export interface NodeForMarkdownResult {
  labels: string[];
  properties: Properties;
  relationships: MarkdownRelationshipRow[];
}

interface RawMarkdownQueryRow {
  properties: Properties;
  labels: string[];
  outRows: Array<{
    relType: string;
    targetLabels: string[];
    targetElementId: string;
    targetProperties: Properties;
  }>;
  inRows: Array<{
    relType: string;
    targetLabels: string[];
    targetElementId: string;
    targetProperties: Properties;
  }>;
}

/**
 * Fetch a node's properties, labels, and every relationship (both
 * directions, all types) in exactly one Cypher round trip (REQ-F-032,
 * REQ-NF-002), for markdown-mode rendering. Replaces the
 * getNodeProperties + getRelationships pair for this use case.
 *
 * Profiled shape (PROFILE against a 4-node/4-relationship fixture): a
 * single NodeByElementIdSeek followed by one Expand(All) per direction
 * inside a RollUpApply (the COLLECT { } subquery) — no AllNodesScan, no
 * CartesianProduct. Grouping by relationship type/direction, sorting, and
 * target naming-strategy resolution are all done client-side by
 * groupRelationshipsForMarkdown, not in this query.
 */
export async function getNodeForMarkdown(
  db: DatabaseConnection,
  elementId: string,
  cache?: Cache
): Promise<NodeForMarkdownResult | null> {
  // Reuses the `props:` prefix: node and relationship elementIds are
  // drawn from disjoint id spaces (elementId prefixes "4:" vs "5:"), so
  // this can never collide with getRelationshipProperties' cache entries.
  const key = cacheKey.props(elementId);
  if (cache) {
    const cached = cache.get<NodeForMarkdownResult | null>(key);
    if (cached !== undefined) return cached;
  }

  const result = await db.executeQuery<RawMarkdownQueryRow>(
    `CYPHER 25
     MATCH (n) WHERE elementId(n) = $elementId
     RETURN properties(n) AS properties,
            labels(n) AS labels,
            COLLECT {
              MATCH (n)-[r]->(t)
              RETURN {
                relType: type(r),
                targetLabels: labels(t),
                targetElementId: elementId(t),
                targetProperties: properties(t)
              }
            } AS outRows,
            COLLECT {
              MATCH (n)<-[r]-(t)
              RETURN {
                relType: type(r),
                targetLabels: labels(t),
                targetElementId: elementId(t),
                targetProperties: properties(t)
              }
            } AS inRows`,
    { elementId }
  );

  const record = result.records[0];
  if (!record) {
    if (cache) cache.set(key, null);
    return null;
  }

  const relationships: MarkdownRelationshipRow[] = [
    ...record.outRows.map((row) => ({ ...row, direction: 'OUT' as Direction })),
    ...record.inRows.map((row) => ({ ...row, direction: 'IN' as Direction })),
  ];

  const nodeResult: NodeForMarkdownResult = {
    labels: record.labels,
    properties: record.properties,
    relationships,
  };

  if (cache) cache.set(key, nodeResult);
  return nodeResult;
}

/**
 * A relationship link resolved to its target's display name, grouped and
 * sorted for markdown rendering.
 */
export interface MarkdownRelationshipLink {
  type: string;
  direction: Direction;
  targetLabel: string;
  targetName: string;
  targetElementId: string;
}

/** One relationship-type/direction group of {@link MarkdownRelationshipLink}s. */
export interface MarkdownRelationshipGroup {
  /** Group key: the relationship type for OUT, `in_<TYPE>` for IN. */
  key: string;
  /** Links in this group, sorted by target label then target name. */
  links: MarkdownRelationshipLink[];
}

function compareByLabelThenName(a: MarkdownRelationshipLink, b: MarkdownRelationshipLink): number {
  if (a.targetLabel !== b.targetLabel) return a.targetLabel < b.targetLabel ? -1 : 1;
  if (a.targetName === b.targetName) return 0;
  return a.targetName < b.targetName ? -1 : 1;
}

/**
 * Resolves each raw relationship row's target display name using the same
 * naming-strategy logic (elementId vs. property, per-label overrides) as
 * getRelationships/getNodesByLabel, then groups by relationship
 * type/direction and sorts targets by label then name. Pure and
 * DB-independent so it's unit-testable without a live Neo4j instance.
 *
 * Collisions are resolved per target label across *all* of this node's
 * relationships (not just within one type/direction group), since two
 * differently-typed links pointing at same-named nodes of the same label
 * would otherwise render distinct link targets to the identical path.
 *
 * A multi-label target resolves via {@link chooseNodeLabel} (REQ-F-014), not
 * the raw `targetLabels[0]` returned by Neo4j, so a link to a multi-label
 * node always points at that node's one chosen-label path regardless of
 * which order this particular relationship's target labels came back in.
 */
export function groupRelationshipsForMarkdown(
  rows: MarkdownRelationshipRow[],
  config: ConfigSchema = DEFAULT_CONFIG
): MarkdownRelationshipGroup[] {
  const mode = config.mode.type;

  const links: MarkdownRelationshipLink[] = rows.map((row) => {
    const targetLabel =
      row.targetLabels.length > 0
        ? chooseNodeLabel(row.targetLabels, config.mode.markdown?.labels)
        : 'Unknown';
    const namingStrategy = getNamingStrategy(targetLabel, config);
    const propertyName = getPropertyName(targetLabel, config);

    let targetName: string;
    if (namingStrategy === 'property' && propertyName) {
      const propValue = row.targetProperties[propertyName];
      targetName =
        propValue === undefined
          ? sanitizeElementId(row.targetElementId, config.sanitization, mode)
          : sanitize(propValue, config.sanitization, mode);
    } else {
      targetName = sanitizeElementId(row.targetElementId, config.sanitization, mode);
    }

    return {
      type: row.relType,
      direction: row.direction,
      targetLabel,
      targetName,
      targetElementId: row.targetElementId,
    };
  });

  const indicesByLabel = new Map<string, number[]>();
  links.forEach((link, index) => {
    const indices = indicesByLabel.get(link.targetLabel);
    if (indices) {
      indices.push(index);
    } else {
      indicesByLabel.set(link.targetLabel, [index]);
    }
  });

  for (const [label, indices] of indicesByLabel) {
    const items = indices.map((index) => ({
      baseName: links[index]!.targetName,
      elementId: links[index]!.targetElementId,
    }));
    const resolvedNames = resolveCollisions(items, label, config.collision);
    indices.forEach((index, position) => {
      links[index]!.targetName = resolvedNames[position]!;
    });
  }

  const groups = new Map<string, MarkdownRelationshipLink[]>();
  for (const link of links) {
    const groupKey = link.direction === 'IN' ? `in_${link.type}` : link.type;
    const group = groups.get(groupKey);
    if (group) {
      group.push(link);
    } else {
      groups.set(groupKey, [link]);
    }
  }

  return Array.from(groups.keys())
    .sort()
    .map((groupKey) => ({
      key: groupKey,
      links: [...groups.get(groupKey)!].sort(compareByLabelThenName),
    }));
}

/**
 * Result from getRelationshipProperties: relationship properties with _elementId included.
 */
export interface RelationshipPropertiesResult {
  /** The database element ID, prefixed with underscore as per PRD */
  _elementId: string;
  /** All other properties spread into the result */
  [key: string]: PropertyValue;
}

/**
 * Get relationship properties by its elementId.
 *
 * Returns the relationship's properties with _elementId field included.
 *
 * @param db Database connection
 * @param relElementId The relationship's element ID
 * @param cache Optional cache instance for caching results (TTL: 10s)
 * @returns Relationship properties with _elementId, or null if not found
 *
 * @example
 * // Get properties for a relationship
 * const props = await getRelationshipProperties(db, '5:abc123:7');
 * // Returns: { _elementId: '5:abc123:7', since: 2020, weight: 0.8 }
 *
 * @example
 * // Not found
 * const props = await getRelationshipProperties(db, 'nonexistent');
 * // Returns: null
 */
export async function getRelationshipProperties(
  db: DatabaseConnection,
  relElementId: string,
  cache?: Cache
): Promise<RelationshipPropertiesResult | null> {
  // Check cache first
  const key = cacheKey.props(relElementId);
  if (cache) {
    const cached = cache.get<RelationshipPropertiesResult | null>(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Query for the relationship by its elementId
  // The relationship can be in any direction, so we use a generic pattern
  const result = await db.executeQuery<{
    elementId: string;
    properties: Properties;
  }>(
    `MATCH ()-[r]-() WHERE elementId(r) = $relElementId
     RETURN elementId(r) AS elementId, properties(r) AS properties
     LIMIT 1`,
    { relElementId }
  );

  // Check if relationship was found
  if (result.records.length === 0) {
    // Cache the null result too to avoid repeated queries
    if (cache) {
      cache.set(key, null);
    }
    return null;
  }

  const record = result.records[0]!;

  // Return properties with _elementId as per PRD section 5.2.4
  const props: RelationshipPropertiesResult = {
    _elementId: record.elementId,
    ...record.properties,
  };

  // Store in cache
  if (cache) {
    cache.set(key, props);
  }

  return props;
}

/**
 * Result row for listNodesForMarkdownIndex: a node's display name plus the
 * three OKF-mapped columns (title/timestamp/description) needed to build
 * index.md/log.md without any extra per-node query (REQ-F-064).
 */
export interface MarkdownIndexNodeResult {
  name: string;
  elementId: string;
  title?: PropertyValue;
  timestamp?: string;
  description: string | null;
}

const DEFAULT_DESCRIPTION_MAX_LENGTH = 160;

/**
 * Truncates a derived index description to a bounded length, appending an
 * ellipsis when content was cut. Pure so it's unit-testable without a
 * query.
 */
export function truncateDescription(
  text: string,
  maxLength: number = DEFAULT_DESCRIPTION_MAX_LENGTH
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

function descriptionValueToText(value: PropertyValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function resolveLabelListOverride(
  overrides: LabelPropertyListOverrides | undefined,
  label: string
): string[] | undefined {
  return overrides?.[label];
}

/**
 * Resolves the title/timestamp fallback list for a label. Duplicated from
 * fields.ts's resolveFallbackList (a trivial override-merge) rather than
 * imported, matching the existing per-module pattern (renderer.ts does the
 * same for textProperties).
 */
function resolveFieldFallbackList(
  field: 'title' | 'timestamp',
  fieldsConfig: MarkdownFieldsConfig,
  label: string
): string[] {
  return resolveLabelListOverride(fieldsConfig.overrides?.[field], label) ?? fieldsConfig[field];
}

function resolveTextPropertyList(textPropertiesConfig: TextPropertiesConfig, label: string): string[] {
  return resolveLabelListOverride(textPropertiesConfig.overrides, label) ?? textPropertiesConfig.default;
}

function coalesceClause(propertyNames: string[]): string {
  if (propertyNames.length === 0) return 'null';
  return `coalesce(${propertyNames.map((name) => `n.\`${name}\``).join(', ')})`;
}

/**
 * Builds the Cypher text for listNodesForMarkdownIndex. Exported (pure, no
 * I/O) so tests can assert the COALESCE clauses textually match the
 * configured fallback list order (REQ-F-064).
 */
export function buildMarkdownIndexQuery(
  label: string,
  titleFallbacks: string[],
  timestampFallbacks: string[],
  textPropertyFallbacks: string[]
): string {
  return `MATCH (n:\`${label}\`)
    RETURN elementId(n) AS elementId,
           properties(n) AS properties,
           labels(n) AS labels,
           ${coalesceClause(titleFallbacks)} AS title,
           ${coalesceClause(timestampFallbacks)} AS timestamp,
           ${coalesceClause(textPropertyFallbacks)} AS rawDescription`;
}

interface RawMarkdownIndexRow {
  elementId: string;
  properties: Properties;
  labels?: string[];
  title: PropertyValue;
  timestamp: PropertyValue;
  rawDescription: PropertyValue;
}

/**
 * Lists every node of a label with its display name plus mapped
 * title/timestamp/description columns, in one query per label (REQ-F-064),
 * so index.md/log.md generation needs no additional per-node queries
 * beyond this listing.
 */
export async function listNodesForMarkdownIndex(
  db: DatabaseConnection,
  label: string,
  fieldsConfig: MarkdownFieldsConfig,
  textPropertiesConfig: TextPropertiesConfig,
  config: ConfigSchema = DEFAULT_CONFIG,
  cache?: Cache
): Promise<MarkdownIndexNodeResult[]> {
  const key = cacheKey.markdownIndex(label);
  if (cache) {
    const cached = cache.get<MarkdownIndexNodeResult[]>(key);
    if (cached !== undefined) return cached;
  }

  const titleFallbacks = resolveFieldFallbackList('title', fieldsConfig, label);
  const timestampFallbacks = resolveFieldFallbackList('timestamp', fieldsConfig, label);
  const textPropertyFallbacks = resolveTextPropertyList(textPropertiesConfig, label);

  const cypher = buildMarkdownIndexQuery(label, titleFallbacks, timestampFallbacks, textPropertyFallbacks);
  const result = await db.executeQuery<RawMarkdownIndexRow>(cypher);

  if (result.records.length === 0) {
    if (cache) cache.set(key, []);
    return [];
  }

  // Naming/collision resolution mirrors getNodesByLabel, except sanitize is
  // given config.mode.type (like groupRelationshipsForMarkdown) rather than
  // getNodesByLabel's implicit 'classic' default, since this listing only
  // ever runs in markdown mode.
  const mode = config.mode.type;
  const namingStrategy = getNamingStrategy(label, config);
  const propertyName = getPropertyName(label, config);

  const items = result.records.map((record) => {
    let baseName: string;
    if (namingStrategy === 'property' && propertyName) {
      const propValue = record.properties[propertyName];
      baseName =
        propValue === undefined
          ? sanitizeElementId(record.elementId, config.sanitization, mode)
          : sanitize(propValue, config.sanitization, mode);
    } else {
      baseName = sanitizeElementId(record.elementId, config.sanitization, mode);
    }
    return { baseName, elementId: record.elementId, record };
  });

  // Collision resolution runs over every same-label node BEFORE the
  // chosen-label filter below, mirroring readdirMarkdownLabel's use of the
  // unfiltered getNodesByLabel result. Filtering first (as an earlier
  // version of this function did) would let a multi-label node's base name
  // drop out of the collision computation entirely, disagreeing with the
  // suffixed filename readdirMarkdownLabel/renderMarkdownNode actually use
  // for a different, single-label node sharing that base name.
  const resolvedNames = resolveCollisions(
    items.map(({ baseName, elementId }) => ({ baseName, elementId })),
    label,
    config.collision
  );

  // A multi-label node only counts toward its chosen label's listing
  // (REQ-F-014), not every label it carries, so index/log generation built
  // on this projection never lists (or double-counts) it under more than
  // one label.
  const configuredLabelOrder = config.mode.markdown?.labels;

  const nodes: MarkdownIndexNodeResult[] = items.reduce<MarkdownIndexNodeResult[]>(
    (acc, item, index) => {
      const { record } = item;
      if (chooseNodeLabel(record.labels ?? [label], configuredLabelOrder) !== label) return acc;

      const title = record.title === null ? undefined : record.title;
      const timestamp = record.timestamp === null ? undefined : toIsoTimestamp(record.timestamp);
      const description =
        record.rawDescription === null
          ? null
          : truncateDescription(descriptionValueToText(record.rawDescription));

      acc.push({
        name: resolvedNames[index]!,
        elementId: item.elementId,
        title,
        timestamp,
        description,
      });
      return acc;
    },
    []
  );

  if (cache) cache.set(key, nodes);
  return nodes;
}
