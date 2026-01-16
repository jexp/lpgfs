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
