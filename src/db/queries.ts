/**
 * Database Queries
 *
 * Cypher queries for fetching graph data from Neo4j.
 */

import type { DatabaseConnection } from './connection.js';

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
