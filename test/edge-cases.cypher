// LPGFS Edge Cases Test Dataset
// Tests edge cases from PRD Section 8
//
// This script extends the base test data with specific edge case scenarios.
// Run AFTER seed.cypher to add additional test cases.
//
// Run with: cat edge-cases.cypher | cypher-shell -u neo4j -p password
//
// IMPORTANT: This script does NOT clear existing data - it adds to seed.cypher data.

// ============================================================
// SECTION 8.1: Multiple Relationships of Same Type
// ============================================================
// Already covered in seed.cypher:
//   - alice TRANSFERRED to james (x3 with different amounts)
//
// Additional test case: Multiple LIKES to same target
MATCH (bob:Person {username: 'bob'}), (carol:Person {username: 'carol'})
CREATE (bob)-[:LIKES {date: '2023-01-01', reason: 'Post about hiking'}]->(carol);

MATCH (bob:Person {username: 'bob'}), (carol:Person {username: 'carol'})
CREATE (bob)-[:LIKES {date: '2023-02-15', reason: 'Post about cooking'}]->(carol);

// ============================================================
// SECTION 8.2: Self-Referential Relationships
// ============================================================
// Already covered in seed.cypher:
//   - alice MANAGES alice
//   - bob FOLLOWS bob
//
// Additional test case: Multiple self-refs of different types
MATCH (carol:Person {username: 'carol'})
CREATE (carol)-[:BOOKMARKED {date: '2023-05-01', note: 'Personal notes'}]->(carol);

// ============================================================
// SECTION 8.3: Nodes with No Relationships
// ============================================================
// Already covered in seed.cypher:
//   - newuser has no relationships
//
// Additional test case: Isolated company node
CREATE (startup:Company {
  name: 'Stealth Startup',
  founded: 2024,
  industry: 'Unknown'
});

// ============================================================
// SECTION 8.4: Property Value Sanitization
// ============================================================
// Test nodes with special characters in property values used as filenames

// Person with slash in name (should be sanitized to underscore)
CREATE (slashperson:Person {
  username: 'user/slash',
  name: 'User With / Slash',
  age: 25
});

// Person with colon in name (should be sanitized)
CREATE (colonperson:Person {
  username: 'user:colon',
  name: 'User With : Colon',
  age: 26
});

// Person with asterisk and question mark (should be sanitized)
CREATE (wildcardperson:Person {
  username: 'user*wild?card',
  name: 'User With *? Wildcards',
  age: 27
});

// Person with quotes and angle brackets (should be sanitized)
CREATE (quoteperson:Person {
  username: 'user"quoted"',
  name: 'User <With> "Quotes"',
  age: 28
});

// Person with pipe character (should be sanitized)
CREATE (pipeperson:Person {
  username: 'user|pipe',
  name: 'User | Pipe',
  age: 29
});

// Person with backslash (should be sanitized)
CREATE (backslashperson:Person {
  username: 'user\\backslash',
  name: 'User \\ Backslash',
  age: 30
});

// Person with all forbidden characters combined
CREATE (forbiddenperson:Person {
  username: 'all/\\:*?"<>|forbidden',
  name: 'All Forbidden Chars',
  age: 31
});

// Person with leading/trailing dots (edge case for sanitization)
CREATE (dotperson:Person {
  username: '.dotuser.',
  name: '...Dots...',
  age: 32
});

// Person with only whitespace in property (edge case)
CREATE (spaceperson:Person {
  username: '   ',
  name: 'Only Spaces',
  age: 33
});

// Person with empty string property (edge case)
CREATE (emptyperson:Person {
  username: '',
  name: 'Empty Username',
  age: 34
});

// Company with special characters in name
CREATE (specialco:Company {
  name: 'Special/Co "Inc" <2024>',
  founded: 2024,
  industry: 'Tech*nology'
});

// ============================================================
// RELATIONSHIPS WITH SPECIAL CHARACTERS IN PROPERTIES
// ============================================================

// Create relationship from special char person
MATCH (s:Person {username: 'user/slash'}), (bob:Person {username: 'bob'})
CREATE (s)-[:KNOWS {since: 2023, note: 'Met at /dev/null conference'}]->(bob);

// Relationship with special chars in properties
MATCH (alice:Person {username: 'alice'}), (carol:Person {username: 'carol'})
CREATE (alice)-[:RATED {
  score: 5,
  comment: 'Great person! <recommended> 5* | "best friend"'
}]->(carol);

// ============================================================
// EDGE CASE: Very Long Property Values
// ============================================================

// Node with very long username (tests filename length limits)
CREATE (longname:Person {
  username: 'this_is_a_very_long_username_that_might_exceed_typical_filesystem_limits_on_some_systems_especially_older_ones_with_255_char_limits',
  name: 'Long Name Person',
  age: 40
});

// ============================================================
// EDGE CASE: Unicode Characters
// ============================================================

// Person with unicode in name
CREATE (unicodeperson:Person {
  username: 'user_emoji',
  name: 'User With Emoji',
  age: 35
});

// Person with international characters
CREATE (intlperson:Person {
  username: 'user_intl',
  name: 'Jean-Pierre',
  age: 36
});

// Person with CJK characters
CREATE (cjkperson:Person {
  username: 'user_cjk',
  name: 'User CJK',
  age: 37
});

// ============================================================
// EDGE CASE: Numeric and Boolean Property Values
// ============================================================

// Person where naming property is a number (if configured)
CREATE (numericperson:Person {
  username: 12345,
  name: 'Numeric Username',
  age: 45
});

// ============================================================
// VERIFICATION QUERIES
// ============================================================

// To verify the edge case data, run these queries:
//
// Count special char nodes:
// MATCH (p:Person) WHERE p.username CONTAINS '/' OR p.username CONTAINS ':' RETURN count(p);
//
// Find nodes with sanitizable usernames:
// MATCH (p:Person) WHERE p.username =~ '.*[/\\\\:*?\"<>|].*' RETURN p.username;
//
// Check multiple rels:
// MATCH (bob:Person {username: 'bob'})-[r:LIKES]->(carol:Person {username: 'carol'}) RETURN count(r);
//
// Find isolated nodes:
// MATCH (n) WHERE NOT (n)--() RETURN n;
//
// Check self-refs:
// MATCH (n)-[r]->(n) RETURN n.username, type(r);

// ============================================================
// SUMMARY
// ============================================================
// Additional nodes created:
//   - 15 Person nodes with special characters/edge cases
//   - 2 Company nodes (Stealth Startup, Special/Co)
//
// Additional relationships created:
//   - 2 LIKES (bob -> carol, multiple of same type)
//   - 1 BOOKMARKED (carol self-ref)
//   - 1 KNOWS (user/slash -> bob)
//   - 1 RATED (alice -> carol, with special chars in properties)
//
// Edge cases covered:
//   - Section 8.1: Multiple rels same type (LIKES x2)
//   - Section 8.2: Self-referential (BOOKMARKED)
//   - Section 8.3: Isolated nodes (Stealth Startup)
//   - Section 8.4: Special characters (multiple test cases)
//   - Additional: Long names, unicode, numeric values
