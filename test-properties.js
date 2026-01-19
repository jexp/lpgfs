#!/usr/bin/env node

// Simple test to check node properties retrieval
import { connect } from './dist/db/connection.js';

async function test() {
  // Connect to Neo4j
  const db = await connect({
    uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
    debug: true,
  });

  try {
    console.log('\n=== Testing properties() function ===\n');

    // Test query
    const result = await db.executeQuery(
      `MATCH (n:Person) RETURN elementId(n) AS elementId, properties(n) AS properties LIMIT 1`
    );

    if (result.records.length > 0) {
      const record = result.records[0];
      console.log('Record:', JSON.stringify(record, null, 2));
      console.log('\nProperties type:', typeof record.properties);
      console.log('Properties constructor:', record.properties?.constructor?.name);
      console.log('Properties keys:', Object.keys(record.properties || {}));
      console.log('Properties entries:', Object.entries(record.properties || {}));
    } else {
      console.log('No Person nodes found');
    }
  } finally {
    await db.close();
  }
}

test().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
