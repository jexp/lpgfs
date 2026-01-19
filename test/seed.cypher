// LPGFS Test Dataset
// Based on PRD Appendix A: Social network with Person and Company nodes
//
// This script seeds a Neo4j database with test data for LPGFS.
// Run with: cat seed.cypher | cypher-shell -u neo4j -p password
// Or: neo4j-admin database import ...
//
// IMPORTANT: This script clears existing data first.

// ============================================================
// CLEANUP: Remove all existing data (optional - comment out in production)
// ============================================================
MATCH (n) DETACH DELETE n;

// ============================================================
// CREATE NODES
// ============================================================

// Person nodes with username (for property naming strategy testing)
CREATE (alice:Person {
  username: 'alice',
  name: 'Alice',
  age: 30,
  email: 'alice@example.com'
});

CREATE (james:Person {
  username: 'james',
  name: 'James',
  age: 28,
  email: 'james@example.com'
});

CREATE (bob:Person {
  username: 'bob',
  name: 'Bob',
  age: 35,
  email: 'bob@example.com'
});

CREATE (carol:Person {
  username: 'carol',
  name: 'Carol',
  age: 32,
  email: 'carol@example.com'
});

// Node with no relationships (edge case section 8.3)
CREATE (newuser:Person {
  username: 'newuser',
  name: 'New User',
  age: 25
});

// Company node
CREATE (acme:Company {
  name: 'Acme Corp',
  founded: 1990,
  industry: 'Technology'
});

// Additional company for cross-label testing
CREATE (globex:Company {
  name: 'Globex Inc',
  founded: 2005,
  industry: 'Finance'
});

// ============================================================
// CREATE RELATIONSHIPS
// ============================================================

// KNOWS relationships (Person -> Person)
// alice knows james (since 2020)
MATCH (a:Person {username: 'alice'}), (j:Person {username: 'james'})
CREATE (a)-[:KNOWS {since: 2020, strength: 'close'}]->(j);

// alice knows bob (since 2018)
MATCH (a:Person {username: 'alice'}), (b:Person {username: 'bob'})
CREATE (a)-[:KNOWS {since: 2018, strength: 'casual'}]->(b);

// carol knows alice (since 2019)
MATCH (c:Person {username: 'carol'}), (a:Person {username: 'alice'})
CREATE (c)-[:KNOWS {since: 2019, strength: 'close'}]->(a);

// james knows bob (since 2017)
MATCH (j:Person {username: 'james'}), (b:Person {username: 'bob'})
CREATE (j)-[:KNOWS {since: 2017, strength: 'professional'}]->(b);

// bob knows carol (since 2021)
MATCH (b:Person {username: 'bob'}), (c:Person {username: 'carol'})
CREATE (b)-[:KNOWS {since: 2021, strength: 'casual'}]->(c);

// WORKS_AT relationships (Person -> Company, cross-label)
// alice works at acme
MATCH (a:Person {username: 'alice'}), (acme:Company {name: 'Acme Corp'})
CREATE (a)-[:WORKS_AT {role: 'Engineer', since: 2019}]->(acme);

// james works at acme
MATCH (j:Person {username: 'james'}), (acme:Company {name: 'Acme Corp'})
CREATE (j)-[:WORKS_AT {role: 'Manager', since: 2015}]->(acme);

// bob works at globex
MATCH (b:Person {username: 'bob'}), (globex:Company {name: 'Globex Inc'})
CREATE (b)-[:WORKS_AT {role: 'Analyst', since: 2020}]->(globex);

// carol works at globex
MATCH (c:Person {username: 'carol'}), (globex:Company {name: 'Globex Inc'})
CREATE (c)-[:WORKS_AT {role: 'Director', since: 2018}]->(globex);

// ============================================================
// EDGE CASES (Section 8)
// ============================================================

// 8.1: Multiple relationships of same type between same nodes
// alice has multiple TRANSFERRED relationships to james (different transactions)
MATCH (a:Person {username: 'alice'}), (j:Person {username: 'james'})
CREATE (a)-[:TRANSFERRED {amount: 100, date: '2023-01-15', description: 'Lunch'}]->(j);

MATCH (a:Person {username: 'alice'}), (j:Person {username: 'james'})
CREATE (a)-[:TRANSFERRED {amount: 250, date: '2023-02-20', description: 'Birthday gift'}]->(j);

MATCH (a:Person {username: 'alice'}), (j:Person {username: 'james'})
CREATE (a)-[:TRANSFERRED {amount: 50, date: '2023-03-01', description: 'Coffee'}]->(j);

// 8.2: Self-referential relationship
// alice manages herself (edge case)
MATCH (a:Person {username: 'alice'})
CREATE (a)-[:MANAGES {since: 2022, role: 'Self-employed consultant'}]->(a);

// bob follows himself (social media edge case)
MATCH (b:Person {username: 'bob'})
CREATE (b)-[:FOLLOWS {since: 2023}]->(b);

// ============================================================
// VERIFICATION QUERIES (optional - run separately)
// ============================================================

// To verify the data, run these queries:
// MATCH (n) RETURN labels(n), count(*);
// MATCH ()-[r]->() RETURN type(r), count(*);
// MATCH (p:Person) RETURN p.username, p.name, p.age ORDER BY p.username;
// MATCH (c:Company) RETURN c.name, c.founded ORDER BY c.name;
// MATCH (a)-[r:KNOWS]->(b) RETURN a.username, type(r), b.username, r.since;
// MATCH (p)-[r:WORKS_AT]->(c) RETURN p.username, r.role, c.name;

// ============================================================
// SUMMARY
// ============================================================
// Nodes created:
//   - 5 Person nodes: alice, james, bob, carol, newuser
//   - 2 Company nodes: acme, globex
//
// Relationships created:
//   - 5 KNOWS relationships (person to person)
//   - 4 WORKS_AT relationships (person to company, cross-label)
//   - 3 TRANSFERRED relationships (multiple between same nodes)
//   - 2 Self-referential relationships (MANAGES, FOLLOWS)
//
// Edge cases covered:
//   - Section 8.1: Multiple rels same type (TRANSFERRED alice->james x3)
//   - Section 8.2: Self-referential (alice MANAGES alice, bob FOLLOWS bob)
//   - Section 8.3: Node with no relationships (newuser)
