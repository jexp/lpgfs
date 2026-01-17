/**
 * Database Queries
 *
 * Cypher queries for fetching graph data from Neo4j.
 */

import type { DatabaseConnection } from './connection.js';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  Direction,
  NamingStrategy,
  NodeQueryResult,
  Properties,
  PropertyValue,
  RelationshipQueryResult,
} from '../types/index.js';
import { sanitize, sanitizeElementId } from '../config/sanitize.js';
import { resolveCollisions } from '../config/collision.js';

/**
 * Get all node labels in the database.
 *
 * @param db Database connection
 * @returns Array of label names
 */
export async function getLabels(db: DatabaseConnection): Promise<string[]> {
  const result = await db.executeQuery<{ label: string }>(
    'CALL db.labels() YIELD label RETURN label'
  );

  return result.records.map((record) => record.label);
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
 * Get all nodes of a given label with display names.
 *
 * @param db Database connection
 * @param label The node label to query
 * @param config Configuration schema for naming
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
  config: ConfigSchema = DEFAULT_CONFIG
): Promise<NodeQueryResult[]> {
  // Query all nodes with the given label
  // Using backticks to safely escape the label name in Cypher
  const result = await db.executeQuery<{
    elementId: string;
    properties: Properties;
  }>(
    `MATCH (n:\`${label}\`) RETURN elementId(n) AS elementId, properties(n) AS properties`
  );

  // Handle empty result
  if (result.records.length === 0) {
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
    };
  });

  // Resolve collisions
  const resolvedNames = resolveCollisions(
    items.map(({ baseName, elementId }) => ({ baseName, elementId })),
    label,
    config.collision
  );

  // Build final results (arrays have same length, so index is always valid)
  return items.map((item, index) => ({
    name: resolvedNames[index]!,
    elementId: item.elementId,
    properties: item.properties,
  }));
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
  config: ConfigSchema = DEFAULT_CONFIG
): Promise<NodePropertiesResult | null> {
  // Get all nodes for this label with their display names
  // This ensures consistent naming logic (sanitization, collision handling)
  const nodes = await getNodesByLabel(db, label, config);

  // Find the node with matching display name
  const node = nodes.find((n) => n.name === name);

  if (!node) {
    return null;
  }

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
  config: ConfigSchema = DEFAULT_CONFIG
): Promise<string[]> {
  // First, find the node to get its elementId
  // This ensures consistent naming logic with the filesystem
  const nodes = await getNodesByLabel(db, label, config);
  const node = nodes.find((n) => n.name === name);

  if (!node) {
    return [];
  }

  // Query for distinct relationship types connected to this node
  // Using elementId(n) to match the specific node
  const result = await db.executeQuery<{ relType: string }>(
    `MATCH (n)-[r]-() WHERE elementId(n) = $elementId RETURN DISTINCT type(r) AS relType`,
    { elementId: node.elementId }
  );

  return result.records.map((record) => record.relType);
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
  config: ConfigSchema = DEFAULT_CONFIG
): Promise<RelationshipQueryResult[]> {
  // First, find the source node to get its elementId
  const nodes = await getNodesByLabel(db, label, config);
  const sourceNode = nodes.find((n) => n.name === name);

  if (!sourceNode) {
    return [];
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

  return relationships;
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
  relElementId: string
): Promise<RelationshipPropertiesResult | null> {
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
    return null;
  }

  const record = result.records[0]!;

  // Return properties with _elementId as per PRD section 5.2.4
  return {
    _elementId: record.elementId,
    ...record.properties,
  };
}
