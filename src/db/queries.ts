/**
 * Database Queries
 *
 * Cypher queries for fetching graph data from Neo4j.
 */

import type { DatabaseConnection } from './connection.js';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  NamingStrategy,
  NodeQueryResult,
  Properties,
  PropertyValue,
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
