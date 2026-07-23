// LPGFS markdown-mode fixture: the Odyssey vault (test/fixtures/odyssey/)
//
// Reproduces the exact graph rendered by the 20 concept .md files plus
// index.md/log.md in this directory, under the config documented in
// README.md. Naming property for every label is `name` (matches
// naming.overrides.nodes.<Label>.property: 'name' in that config).

MATCH (n) DETACH DELETE n;

// ---------------------------------------------------------------------
// CONSTRAINTS (uniqueness on the naming property per label)
// ---------------------------------------------------------------------
CREATE CONSTRAINT odyssey_character_name IF NOT EXISTS FOR (n:Character) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT odyssey_place_name IF NOT EXISTS FOR (n:Place) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT odyssey_creature_name IF NOT EXISTS FOR (n:Creature) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT odyssey_event_name IF NOT EXISTS FOR (n:Event) REQUIRE n.name IS UNIQUE;

// ---------------------------------------------------------------------
// NODES
// ---------------------------------------------------------------------

// Character (7) — Odysseus carries a second label (Hero) to exercise
// task-009's first-label-wins rule: mode.markdown.labels below is
// [Character, Place, Creature, Event], so he still renders once under
// Character/Odysseus.md, never under a mounted Hero/ directory.
CREATE (:Character:Hero {
  name: 'Odysseus',
  title: 'King of Ithaca',
  role: 'protagonist',
  updated: '2026-03-15T12:00:00Z',
  tags: 'hero',
  summary: 'King of Ithaca, renowned for his cunning and endurance.',
  content: 'After the fall of Troy, Odysseus wandered for ten years before returning home to reclaim his kingdom and his family.'
});

CREATE (:Character {
  name: 'Penelope',
  role: 'queen',
  updated: '2026-04-20T10:00:00Z',
  tags: ['loyalty', 'patience'],
  summary: 'Queen of Ithaca, who outwitted her suitors while awaiting her husband.'
});

CREATE (:Character {
  name: 'Telemachus',
  role: 'prince',
  lastUpdated: '2026-04-20T11:00:00Z',
  summary: 'Son of Odysseus and Penelope, who comes of age during his father\'s absence.'
});

// Circe carries a literal `type` property, exercising task-013's clash
// rule: the label wins the `type` frontmatter key and this property is
// demoted to `type_property: Sorceress`.
CREATE (:Character {
  name: 'Circe',
  title: 'Enchantress of Aeaea',
  type: 'Sorceress',
  modified: '2026-03-15T15:00:00Z',
  categories: ['sorceress', 'divine'],
  summary: 'A goddess-sorceress who transforms sailors into swine on her island.'
});

CREATE (:Character {
  name: 'Calypso',
  role: 'nymph',
  summary: 'A nymph who keeps Odysseus on her island for seven years.'
});

CREATE (:Character {
  name: 'Nausicaa',
  role: 'princess',
  summary: 'Princess of the Phaeacians, who finds Odysseus shipwrecked on Scheria.'
});

// Eumaeus has no title/timestamp/tags source properties and no
// configured text property (summary/text/content) — his file renders
// frontmatter-only with an empty body.
CREATE (:Character {
  name: 'Eumaeus',
  role: 'swineherd'
});

// Place (5)
CREATE (:Place {
  name: 'Ithaca',
  updated: '2026-05-05T08:00:00Z',
  summary: 'A rocky island kingdom in the Ionian Sea, home of Odysseus.'
});

CREATE (:Place {
  name: 'Troy',
  updated: '2026-02-01T09:30:00Z',
  summary: 'A fortified city in Asia Minor, site of the decade-long Trojan War.'
});

CREATE (:Place {
  name: 'Aeaea',
  lastUpdated: '2026-03-15T14:00:00Z',
  summary: 'The island home of the sorceress Circe.'
});

CREATE (:Place {
  name: 'Ogygia',
  summary: 'A remote island where the nymph Calypso dwells.'
});

CREATE (:Place {
  name: 'Scheria',
  summary: 'The homeland of the seafaring Phaeacians.'
});

// Creature (4)
CREATE (:Creature {
  name: 'Polyphemus',
  role: 'cyclops',
  summary: 'A man-eating cyclops, son of Poseidon, blinded by Odysseus.'
});

CREATE (:Creature {
  name: 'TheSirens',
  summary: 'Enchanting creatures whose song lures sailors to their doom.'
});

CREATE (:Creature {
  name: 'Scylla',
  summary: 'A six-headed sea monster who preys on passing sailors.'
});

CREATE (:Creature {
  name: 'Charybdis',
  summary: 'A deadly whirlpool that swallows ships whole.'
});

// Event (4)
CREATE (:Event {
  name: 'TrojanWar',
  updated: '2026-02-01T08:00:00Z',
  tags: 'war',
  summary: 'The decade-long war between the Achaeans and the city of Troy.'
});

CREATE (:Event {
  name: 'FallOfTroy',
  lastUpdated: '2026-02-01T10:00:00Z',
  summary: 'The night Troy fell to the Achaeans by the ruse of the wooden horse.'
});

CREATE (:Event {
  name: 'Nostos',
  created: '2026-04-20T09:00:00Z',
  summary: 'Odysseus\'s ten-year homeward journey from Troy to Ithaca.'
});

CREATE (:Event {
  name: 'Nekyia',
  summary: 'Odysseus\'s descent into the underworld to consult the dead.'
});

// ---------------------------------------------------------------------
// RELATIONSHIPS
// ---------------------------------------------------------------------

MATCH (odysseus:Character {name: 'Odysseus'}), (ithaca:Place {name: 'Ithaca'})
CREATE (odysseus)-[:RULES]->(ithaca);

MATCH (odysseus:Character {name: 'Odysseus'}), (penelope:Character {name: 'Penelope'})
CREATE (odysseus)-[:MARRIED_TO]->(penelope);

MATCH (odysseus:Character {name: 'Odysseus'}), (telemachus:Character {name: 'Telemachus'})
CREATE (odysseus)-[:PARENT_OF]->(telemachus);

MATCH (odysseus:Character {name: 'Odysseus'}), (trojanWar:Event {name: 'TrojanWar'})
CREATE (odysseus)-[:FOUGHT_IN]->(trojanWar);

MATCH (odysseus:Character {name: 'Odysseus'}), (nostos:Event {name: 'Nostos'})
CREATE (odysseus)-[:UNDERTOOK]->(nostos);

MATCH (odysseus:Character {name: 'Odysseus'}), (nekyia:Event {name: 'Nekyia'})
CREATE (odysseus)-[:UNDERTOOK]->(nekyia);

MATCH (odysseus:Character {name: 'Odysseus'}), (aeaea:Place {name: 'Aeaea'})
CREATE (odysseus)-[:VISITED]->(aeaea);

MATCH (odysseus:Character {name: 'Odysseus'}), (ogygia:Place {name: 'Ogygia'})
CREATE (odysseus)-[:VISITED]->(ogygia);

MATCH (odysseus:Character {name: 'Odysseus'}), (scheria:Place {name: 'Scheria'})
CREATE (odysseus)-[:VISITED]->(scheria);

MATCH (odysseus:Character {name: 'Odysseus'}), (circe:Character {name: 'Circe'})
CREATE (odysseus)-[:ENCOUNTERED]->(circe);

MATCH (odysseus:Character {name: 'Odysseus'}), (calypso:Character {name: 'Calypso'})
CREATE (odysseus)-[:ENCOUNTERED]->(calypso);

MATCH (odysseus:Character {name: 'Odysseus'}), (polyphemus:Creature {name: 'Polyphemus'})
CREATE (odysseus)-[:ENCOUNTERED]->(polyphemus);

MATCH (odysseus:Character {name: 'Odysseus'}), (sirens:Creature {name: 'TheSirens'})
CREATE (odysseus)-[:ENCOUNTERED]->(sirens);

MATCH (odysseus:Character {name: 'Odysseus'}), (scylla:Creature {name: 'Scylla'})
CREATE (odysseus)-[:ENCOUNTERED]->(scylla);

MATCH (odysseus:Character {name: 'Odysseus'}), (charybdis:Creature {name: 'Charybdis'})
CREATE (odysseus)-[:ENCOUNTERED]->(charybdis);

MATCH (penelope:Character {name: 'Penelope'}), (odysseus:Character {name: 'Odysseus'})
CREATE (penelope)-[:AWAITS]->(odysseus);

MATCH (penelope:Character {name: 'Penelope'}), (telemachus:Character {name: 'Telemachus'})
CREATE (penelope)-[:PARENT_OF]->(telemachus);

MATCH (penelope:Character {name: 'Penelope'}), (ithaca:Place {name: 'Ithaca'})
CREATE (penelope)-[:RULES]->(ithaca);

MATCH (telemachus:Character {name: 'Telemachus'}), (odysseus:Character {name: 'Odysseus'})
CREATE (telemachus)-[:CHILD_OF]->(odysseus);

MATCH (telemachus:Character {name: 'Telemachus'}), (ithaca:Place {name: 'Ithaca'})
CREATE (telemachus)-[:RESIDES_IN]->(ithaca);

MATCH (circe:Character {name: 'Circe'}), (aeaea:Place {name: 'Aeaea'})
CREATE (circe)-[:RULES]->(aeaea);

MATCH (calypso:Character {name: 'Calypso'}), (ogygia:Place {name: 'Ogygia'})
CREATE (calypso)-[:RULES]->(ogygia);

MATCH (nausicaa:Character {name: 'Nausicaa'}), (scheria:Place {name: 'Scheria'})
CREATE (nausicaa)-[:RESIDES_IN]->(scheria);

MATCH (eumaeus:Character {name: 'Eumaeus'}), (odysseus:Character {name: 'Odysseus'})
CREATE (eumaeus)-[:SERVES]->(odysseus);

MATCH (eumaeus:Character {name: 'Eumaeus'}), (ithaca:Place {name: 'Ithaca'})
CREATE (eumaeus)-[:RESIDES_IN]->(ithaca);

MATCH (troy:Place {name: 'Troy'}), (trojanWar:Event {name: 'TrojanWar'})
CREATE (troy)-[:SITE_OF]->(trojanWar);

MATCH (troy:Place {name: 'Troy'}), (fallOfTroy:Event {name: 'FallOfTroy'})
CREATE (troy)-[:SITE_OF]->(fallOfTroy);

MATCH (trojanWar:Event {name: 'TrojanWar'}), (fallOfTroy:Event {name: 'FallOfTroy'})
CREATE (trojanWar)-[:PRECEDED]->(fallOfTroy);

MATCH (fallOfTroy:Event {name: 'FallOfTroy'}), (nostos:Event {name: 'Nostos'})
CREATE (fallOfTroy)-[:LED_TO]->(nostos);

MATCH (nostos:Event {name: 'Nostos'}), (nekyia:Event {name: 'Nekyia'})
CREATE (nostos)-[:INCLUDED]->(nekyia);

// ---------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------
// Nodes: 20 (7 Character incl. 1 multi-label, 5 Place, 4 Creature, 4 Event)
// Relationships: 30 (all one-directional per pair, matching the .md
// fixtures' includeIncoming: false default — every relationship above is
// rendered only on its source node's file, never as an in_<TYPE> key)
MATCH (n) RETURN labels(n) AS labels, count(n) AS count ORDER BY labels;
