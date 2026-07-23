/**
 * Round-trip test for the Odyssey fixture vault (test/fixtures/odyssey/,
 * REQ-F-042): constructs the graph described by import.cypher directly as
 * in-memory data structures (no FUSE, no live Neo4j), runs it through the
 * same rendering pipeline src/fuse/handlers.ts uses in production
 * (chooseNodeLabel -> groupRelationshipsForMarkdown -> renderNodeMarkdown,
 * and the index/log generators), and asserts the output matches every
 * fixture file byte-for-byte after trailing-whitespace/final-newline
 * normalization.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  chooseNodeLabel,
  groupRelationshipsForMarkdown,
  truncateDescription,
  type MarkdownIndexNodeResult,
  type MarkdownRelationshipRow,
} from '../db/queries.js';
import { DEFAULT_CONFIG, DEFAULT_MARKDOWN_MODE_CONFIG, type ConfigSchema, type Properties } from '../types/index.js';
import { propertyFallbackFieldResolver } from './fields.js';
import { renderLabelIndex, renderRootIndex } from './index-renderer.js';
import { renderRootLog, type LogSourceEntry } from './log.js';
import { renderNodeMarkdown, toBodyText, type MarkdownRelationshipLink } from './renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '..', 'test', 'fixtures', 'odyssey');

function readFixture(...segments: string[]): string {
  return readFileSync(join(FIXTURE_ROOT, ...segments), 'utf-8');
}

/** Strips trailing whitespace per line and collapses trailing newlines to exactly one. */
function normalize(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');
}

function expectMatchesFixture(actual: string, ...segments: string[]): void {
  const expected = readFixture(...segments);
  expect(normalize(actual)).toBe(normalize(expected));
}

// ---------------------------------------------------------------------
// Graph state implied by test/fixtures/odyssey/import.cypher
// ---------------------------------------------------------------------

interface FixtureNode {
  elementId: string;
  labels: string[];
  name: string;
  properties: Properties;
}

interface FixtureRelationship {
  type: string;
  from: string;
  to: string;
}

const nodes: FixtureNode[] = [
  {
    elementId: 'char-odysseus',
    labels: ['Character', 'Hero'],
    name: 'Odysseus',
    properties: {
      name: 'Odysseus',
      title: 'King of Ithaca',
      role: 'protagonist',
      updated: '2026-03-15T12:00:00Z',
      tags: 'hero',
      summary: 'King of Ithaca, renowned for his cunning and endurance.',
      content:
        'After the fall of Troy, Odysseus wandered for ten years before returning home to reclaim his kingdom and his family.',
    },
  },
  {
    elementId: 'char-penelope',
    labels: ['Character'],
    name: 'Penelope',
    properties: {
      name: 'Penelope',
      role: 'queen',
      updated: '2026-04-20T10:00:00Z',
      tags: ['loyalty', 'patience'],
      summary: 'Queen of Ithaca, who outwitted her suitors while awaiting her husband.',
    },
  },
  {
    elementId: 'char-telemachus',
    labels: ['Character'],
    name: 'Telemachus',
    properties: {
      name: 'Telemachus',
      role: 'prince',
      lastUpdated: '2026-04-20T11:00:00Z',
      summary: "Son of Odysseus and Penelope, who comes of age during his father's absence.",
    },
  },
  {
    elementId: 'char-circe',
    labels: ['Character'],
    name: 'Circe',
    properties: {
      name: 'Circe',
      title: 'Enchantress of Aeaea',
      type: 'Sorceress',
      modified: '2026-03-15T15:00:00Z',
      categories: ['sorceress', 'divine'],
      summary: 'A goddess-sorceress who transforms sailors into swine on her island.',
    },
  },
  {
    elementId: 'char-calypso',
    labels: ['Character'],
    name: 'Calypso',
    properties: {
      name: 'Calypso',
      role: 'nymph',
      summary: 'A nymph who keeps Odysseus on her island for seven years.',
    },
  },
  {
    elementId: 'char-nausicaa',
    labels: ['Character'],
    name: 'Nausicaa',
    properties: {
      name: 'Nausicaa',
      role: 'princess',
      summary: 'Princess of the Phaeacians, who finds Odysseus shipwrecked on Scheria.',
    },
  },
  {
    elementId: 'char-eumaeus',
    labels: ['Character'],
    name: 'Eumaeus',
    properties: {
      name: 'Eumaeus',
      role: 'swineherd',
    },
  },
  {
    elementId: 'place-ithaca',
    labels: ['Place'],
    name: 'Ithaca',
    properties: {
      name: 'Ithaca',
      updated: '2026-05-05T08:00:00Z',
      summary: 'A rocky island kingdom in the Ionian Sea, home of Odysseus.',
    },
  },
  {
    elementId: 'place-troy',
    labels: ['Place'],
    name: 'Troy',
    properties: {
      name: 'Troy',
      updated: '2026-02-01T09:30:00Z',
      summary: 'A fortified city in Asia Minor, site of the decade-long Trojan War.',
    },
  },
  {
    elementId: 'place-aeaea',
    labels: ['Place'],
    name: 'Aeaea',
    properties: {
      name: 'Aeaea',
      lastUpdated: '2026-03-15T14:00:00Z',
      summary: 'The island home of the sorceress Circe.',
    },
  },
  {
    elementId: 'place-ogygia',
    labels: ['Place'],
    name: 'Ogygia',
    properties: {
      name: 'Ogygia',
      summary: 'A remote island where the nymph Calypso dwells.',
    },
  },
  {
    elementId: 'place-scheria',
    labels: ['Place'],
    name: 'Scheria',
    properties: {
      name: 'Scheria',
      summary: 'The homeland of the seafaring Phaeacians.',
    },
  },
  {
    elementId: 'creature-polyphemus',
    labels: ['Creature'],
    name: 'Polyphemus',
    properties: {
      name: 'Polyphemus',
      role: 'cyclops',
      summary: 'A man-eating cyclops, son of Poseidon, blinded by Odysseus.',
    },
  },
  {
    elementId: 'creature-thesirens',
    labels: ['Creature'],
    name: 'TheSirens',
    properties: {
      name: 'TheSirens',
      summary: 'Enchanting creatures whose song lures sailors to their doom.',
    },
  },
  {
    elementId: 'creature-scylla',
    labels: ['Creature'],
    name: 'Scylla',
    properties: {
      name: 'Scylla',
      summary: 'A six-headed sea monster who preys on passing sailors.',
    },
  },
  {
    elementId: 'creature-charybdis',
    labels: ['Creature'],
    name: 'Charybdis',
    properties: {
      name: 'Charybdis',
      summary: 'A deadly whirlpool that swallows ships whole.',
    },
  },
  {
    elementId: 'event-trojanwar',
    labels: ['Event'],
    name: 'TrojanWar',
    properties: {
      name: 'TrojanWar',
      updated: '2026-02-01T08:00:00Z',
      tags: 'war',
      summary: 'The decade-long war between the Achaeans and the city of Troy.',
    },
  },
  {
    elementId: 'event-fallOfTroy',
    labels: ['Event'],
    name: 'FallOfTroy',
    properties: {
      name: 'FallOfTroy',
      lastUpdated: '2026-02-01T10:00:00Z',
      summary: 'The night Troy fell to the Achaeans by the ruse of the wooden horse.',
    },
  },
  {
    elementId: 'event-nostos',
    labels: ['Event'],
    name: 'Nostos',
    properties: {
      name: 'Nostos',
      created: '2026-04-20T09:00:00Z',
      summary: "Odysseus's ten-year homeward journey from Troy to Ithaca.",
    },
  },
  {
    elementId: 'event-nekyia',
    labels: ['Event'],
    name: 'Nekyia',
    properties: {
      name: 'Nekyia',
      summary: "Odysseus's descent into the underworld to consult the dead.",
    },
  },
];

const relationships: FixtureRelationship[] = [
  { type: 'RULES', from: 'Odysseus', to: 'Ithaca' },
  { type: 'MARRIED_TO', from: 'Odysseus', to: 'Penelope' },
  { type: 'PARENT_OF', from: 'Odysseus', to: 'Telemachus' },
  { type: 'FOUGHT_IN', from: 'Odysseus', to: 'TrojanWar' },
  { type: 'UNDERTOOK', from: 'Odysseus', to: 'Nostos' },
  { type: 'UNDERTOOK', from: 'Odysseus', to: 'Nekyia' },
  { type: 'VISITED', from: 'Odysseus', to: 'Aeaea' },
  { type: 'VISITED', from: 'Odysseus', to: 'Ogygia' },
  { type: 'VISITED', from: 'Odysseus', to: 'Scheria' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'Circe' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'Calypso' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'Polyphemus' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'TheSirens' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'Scylla' },
  { type: 'ENCOUNTERED', from: 'Odysseus', to: 'Charybdis' },
  { type: 'AWAITS', from: 'Penelope', to: 'Odysseus' },
  { type: 'PARENT_OF', from: 'Penelope', to: 'Telemachus' },
  { type: 'RULES', from: 'Penelope', to: 'Ithaca' },
  { type: 'CHILD_OF', from: 'Telemachus', to: 'Odysseus' },
  { type: 'RESIDES_IN', from: 'Telemachus', to: 'Ithaca' },
  { type: 'RULES', from: 'Circe', to: 'Aeaea' },
  { type: 'RULES', from: 'Calypso', to: 'Ogygia' },
  { type: 'RESIDES_IN', from: 'Nausicaa', to: 'Scheria' },
  { type: 'SERVES', from: 'Eumaeus', to: 'Odysseus' },
  { type: 'RESIDES_IN', from: 'Eumaeus', to: 'Ithaca' },
  { type: 'SITE_OF', from: 'Troy', to: 'TrojanWar' },
  { type: 'SITE_OF', from: 'Troy', to: 'FallOfTroy' },
  { type: 'PRECEDED', from: 'TrojanWar', to: 'FallOfTroy' },
  { type: 'LED_TO', from: 'FallOfTroy', to: 'Nostos' },
  { type: 'INCLUDED', from: 'Nostos', to: 'Nekyia' },
];

const nodesByName = new Map(nodes.map((node) => [node.name, node]));

// ---------------------------------------------------------------------
// Config documented in test/fixtures/odyssey/README.md: library defaults
// plus an explicit labels allow-list and per-label `name` naming overrides.
// ---------------------------------------------------------------------

const LABELS = ['Character', 'Place', 'Creature', 'Event'];

const config: ConfigSchema = {
  naming: {
    default: 'elementId',
    overrides: {
      nodes: {
        Character: { property: 'name' },
        Place: { property: 'name' },
        Creature: { property: 'name' },
        Event: { property: 'name' },
      },
    },
  },
  sanitization: DEFAULT_CONFIG.sanitization,
  collision: DEFAULT_CONFIG.collision,
  mode: {
    type: 'markdown',
    markdown: {
      ...DEFAULT_MARKDOWN_MODE_CONFIG,
      labels: LABELS,
    },
  },
};

const markdownConfig = config.mode.markdown!;

// ---------------------------------------------------------------------
// Rendering pipeline mirroring src/fuse/handlers.ts's renderMarkdownNode
// and src/db/queries.ts's listNodesForMarkdownIndex.
// ---------------------------------------------------------------------

function buildRelationshipRows(node: FixtureNode): MarkdownRelationshipRow[] {
  const outRows: MarkdownRelationshipRow[] = relationships
    .filter((rel) => rel.from === node.name)
    .map((rel) => {
      const target = nodesByName.get(rel.to)!;
      return {
        relType: rel.type,
        direction: 'OUT' as const,
        targetLabels: target.labels,
        targetElementId: target.elementId,
        targetProperties: target.properties,
      };
    });
  const inRows: MarkdownRelationshipRow[] = relationships
    .filter((rel) => rel.to === node.name)
    .map((rel) => {
      const source = nodesByName.get(rel.from)!;
      return {
        relType: rel.type,
        direction: 'IN' as const,
        targetLabels: source.labels,
        targetElementId: source.elementId,
        targetProperties: source.properties,
      };
    });
  return [...outRows, ...inRows];
}

function renderFixtureNode(node: FixtureNode): string {
  const chosenLabel = chooseNodeLabel(node.labels, markdownConfig.labels);
  const orderedLabels = [chosenLabel, ...node.labels.filter((label) => label !== chosenLabel)];
  const groups = groupRelationshipsForMarkdown(buildRelationshipRows(node), config);
  const relationshipLinks: MarkdownRelationshipLink[] = groups.flatMap((group) => group.links);

  return renderNodeMarkdown({
    labels: orderedLabels,
    properties: node.properties,
    relationships: relationshipLinks,
    config: markdownConfig,
    fieldResolver: propertyFallbackFieldResolver,
  });
}

function firstPresentTextProperty(properties: Properties, label: string): string | undefined {
  const names = markdownConfig.textProperties.overrides?.[label] ?? markdownConfig.textProperties.default;
  return names.find(
    (name) =>
      Object.prototype.hasOwnProperty.call(properties, name) &&
      properties[name] !== undefined &&
      properties[name] !== null
  );
}

function buildIndexNodesForLabel(label: string): MarkdownIndexNodeResult[] {
  return nodes
    .filter((node) => chooseNodeLabel(node.labels, markdownConfig.labels) === label)
    .map((node) => {
      const resolved = propertyFallbackFieldResolver.resolve([label], node.properties, markdownConfig.fields);
      const textProperty = firstPresentTextProperty(node.properties, label);
      const description = textProperty
        ? truncateDescription(toBodyText(node.properties[textProperty]!))
        : null;

      return {
        name: node.name,
        elementId: node.elementId,
        title: resolved.title,
        timestamp: resolved.timestamp,
        description,
      };
    });
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('Odyssey fixture round-trip', () => {
  describe.each(nodes.map((node) => [chooseNodeLabel(node.labels, markdownConfig.labels), node.name] as const))(
    '%s/%s.md',
    (label, name) => {
      it('matches the fixture file exactly', () => {
        const node = nodesByName.get(name)!;
        const rendered = renderFixtureNode(node);
        expectMatchesFixture(rendered, label, `${name}.md`);
      });
    }
  );

  it('renders the root /index.md exactly', () => {
    const rendered = renderRootIndex(LABELS, markdownConfig.linkStyle);
    expectMatchesFixture(rendered, 'index.md');
  });

  it.each(LABELS)('renders the /%s/index.md exactly', (label) => {
    const rendered = renderLabelIndex(label, buildIndexNodesForLabel(label), markdownConfig.linkStyle);
    expectMatchesFixture(rendered, label, 'index.md');
  });

  it('renders the root /log.md exactly', () => {
    const entries: LogSourceEntry[] = LABELS.flatMap((label) =>
      buildIndexNodesForLabel(label)
        .filter((node): node is MarkdownIndexNodeResult & { timestamp: string } => node.timestamp !== undefined)
        .map((node) => ({ label, name: node.name, timestamp: node.timestamp }))
    );
    const rendered = renderRootLog(entries, markdownConfig.linkStyle);
    expectMatchesFixture(rendered, 'log.md');
  });
});
