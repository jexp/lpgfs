# PRD: Markdown Mode (Obsidian-compatible, OKF-aware)

## Overview

Add a mount-time **markdown mode** to LPGFS that renders graph nodes as a markdown vault instead of the current JSON/symlink layout. Each node becomes a `.md` file whose YAML frontmatter carries the node's properties and links to related nodes; the node's label becomes a folder; a unique naming property (or elementId fallback) becomes the filename; and one or more configured *text properties* form the markdown body. The mount can cover all labels or a configured subset.

The default output is **Obsidian-compatible** (wikilinks resolve in Obsidian's graph view, backlinks, Dataview) and simultaneously **OKF-conformant** (Open Knowledge Format v0.1 — Google Cloud's "directory of markdown files with YAML frontmatter" bundle spec): every file has parseable frontmatter with a non-empty `type` key. The mount also renders OKF's reserved bundle files — a root `index.md` (with `okf_version`), per-label `index.md` listings, and a `log.md` derived from node timestamps — all virtual and therefore never stale. Recommended OKF fields (`title`, `timestamp`, `tags`) are mapped from node properties via per-field ordered fallback lists, the same pattern used for naming. An optional link-style setting switches from wikilinks to OKF's bundle-relative markdown links. The filesystem remains strictly read-only.

A test dataset — an Odyssey wiki of 20 hand-authored markdown fixture files plus a Cypher import script — validates rendering end-to-end via round-trip comparison.

## Goals

- Render nodes as markdown files: `/<Label>/<name>.md` (label = folder, unique name = filename; concept ID `Label/name` matches OKF's path-minus-extension convention).
- Properties → YAML frontmatter attributes (scalars, lists; Neo4j temporal/spatial values serialized as strings).
- Relationships → frontmatter keys per relationship type containing links to target nodes; default quoted wikilinks (`"[[Label/name]]"`) for Obsidian resolution.
- Every file carries `type: <Label>` in frontmatter (required by OKF; a useful property in Obsidian).
- Configurable list of text properties per filesystem (globally and per-label) that compose the markdown body, concatenated in config order.
- Optional label filter: mount all labels or only a configured set.
- Auto-generate OKF bundle files: root `index.md` (bundle overview, `okf_version: "0.1"`), per-label `index.md` (concept listings with short descriptions), and root `log.md` (date-grouped node updates derived from mapped timestamps).
- Map OKF/Obsidian recommended fields — `title`, `timestamp`, `tags` — from node properties using configurable per-field fallback lists checked per node (e.g. `timestamp: [updated, lastUpdated, modified, created]`).
- Ship a 20-file Odyssey example vault + Cypher import script and an integration test that validates byte-level (normalized) round-trip rendering using Docker + neo4j-cli.

## Non-Goals

- Write support (creating/editing markdown writes back to the graph) — the filesystem stays read-only (`EROFS`).
- Subgraph composition (a markdown document composed from a central node plus a rel-type traversal) — explicitly a **later phase**; the design should not preclude it.
- Rendering relationship properties in markdown (relationship property files are dropped in this mode for v1).
- Body link/Relations sections (frontmatter-only links in v1).
- Obsidian plugin functionality, `.obsidian/` vault settings generation.
- OKF `resource`/`Citations` conventions and non-markdown bundle assets.
- Real-time updates beyond the existing cache-TTL behavior.

## Requirements

### Functional Requirements

**Mode activation**

- REQ-F-001: A new config section `mode` in `.lpgfs.yaml` selects the layout: `mode.type: classic | markdown` (default `classic`, preserving current behavior exactly).
- REQ-F-002: A CLI flag `--mode <classic|markdown>` on `lpgfs mount` overrides the config file value.
- REQ-F-003: In markdown mode the root lists one directory per rendered label, the generated `/index.md` and `/log.md`, plus the existing read-only `/.lpgfs.yaml` config file.

**Layout & naming**

- REQ-F-010: Each node renders as `/<Label>/<name>.md` — label = folder, node display name = filename with `.md` extension.
- REQ-F-011: Filenames reuse the existing naming subsystem (naming strategy, per-label property overrides, sanitization, collision handling). The naming property is expected to be unique per label (unique-constraint semantics); collisions follow the configured collision strategy.
- REQ-F-012: Additional sanitization in markdown mode: characters illegal in Obsidian filenames/wikilinks (`[`, `]`, `#`, `^`, `|`) are added to the default replacement map.
- REQ-F-013: An optional `mode.markdown.labels: [<Label>, ...]` filters which labels are rendered; empty/absent = all labels. Links pointing at nodes of excluded labels are still rendered (unresolved links are permitted — in Obsidian they show as unresolved; OKF explicitly allows broken links as "not-yet-written knowledge").
- REQ-F-014: Multi-label nodes render under their first label by default (deterministic: alphabetical or first-in-config), not duplicated.

**Markdown content**

- REQ-F-020: Frontmatter contains all node properties except the configured text properties (which move to the body). Property values serialize as YAML scalars/lists; Neo4j Integer/Float/temporal/point values use the same transformation rules as the existing `.properties.json` rendering, emitted as YAML.
- REQ-F-021: Frontmatter always includes `type: <Label>` as the first key (OKF's single required field). If a node property named `type` exists, the property value wins and a warning is logged (or the label is emitted under `label:` instead — decide in implementation, test the chosen rule).
- REQ-F-022: For each relationship type on a node, frontmatter gets a key with a list of links to the target nodes. Outgoing relationships are always rendered; incoming relationships are rendered under an `in_<TYPE>` key when `mode.markdown.includeIncoming: true` (default `false`).
- REQ-F-023: Link style is configurable via `mode.markdown.linkStyle: wikilink | markdown` (default `wikilink`):
  - `wikilink`: quoted `"[[Label/name]]"` (Obsidian-native; vault-relative target, no `.md` extension).
  - `markdown`: bundle-relative absolute path `/Label/name.md` (OKF-recommended link form).
- REQ-F-024: `mode.markdown.textProperties` configures which properties form the body: a global ordered list plus per-label overrides (same override shape as `naming.overrides.nodes`). Example:
  ```yaml
  mode:
    type: markdown
    markdown:
      linkStyle: wikilink
      textProperties:
        default: [summary, text, content]
        overrides:
          Character: [description, story]
      fields:
        title: [title, name]
        timestamp: [updated, lastUpdated, modified, created]
        tags: [tags, categories]
  ```
- REQ-F-025: Body composition: all configured text properties present on the node are concatenated in config order, separated by blank lines. When more than one text property is present, each section is preceded by a `## <propertyName>` heading; a single present property renders bare (no heading).
- REQ-F-026: A node with none of the configured text properties renders with frontmatter only and an empty body.
- REQ-F-027: Rendered files report accurate byte sizes in `getattr` (size = rendered content length), so `cat`, editors, and Obsidian read the full content.
- REQ-F-028: Output is OKF v0.1 conformant: every rendered `.md` file has parseable YAML frontmatter with a non-empty `type`; the reserved filenames `index.md` and `log.md` are used only for the generated bundle files (a node whose sanitized name would be `index` or `log` gets a collision-style suffix).

**Recommended field mapping (title, timestamp, tags)**

- REQ-F-050: `mode.markdown.fields` maps OKF/Obsidian recommended frontmatter fields to node properties. Each target field (`title`, `timestamp`, `tags`) has an ordered fallback list of property names, checked per node — the first property that exists on the node wins (mirroring the naming-property fallback pattern). Defaults: `title: [title, name]`, `timestamp: [updated, lastUpdated, modified, created]`, `tags: [tags, categories]`. Per-label overrides use the same shape as `textProperties.overrides`.
- REQ-F-051: A mapped value is emitted under the canonical key (`title:`, `timestamp:`, `tags:`) and the source property is omitted from frontmatter (no duplication). If the source property is already named canonically, it simply stays. Nodes matching none of the fallbacks omit the canonical key (OKF consumers must tolerate missing optional fields).
- REQ-F-052: `timestamp` values serialize as ISO 8601 strings (reusing the existing temporal transformation); `tags` list values pass through as a YAML list, scalar values become a single-item list. Setting a field's list to `[]` disables that mapping.

**Generated bundle files (index.md, log.md)**

- REQ-F-060: The root directory contains a generated virtual `/index.md`: frontmatter with `okf_version: "0.1"` (root index is the only file allowed frontmatter without `type` per OKF; include a `type: bundle` anyway for uniformity unless it conflicts with conformance testing), followed by one section per rendered label with a bullet list linking each label's `index.md`.
- REQ-F-061: Each label directory contains a generated virtual `/<Label>/index.md` (no frontmatter, per OKF reserved-file rules): a bullet list of links to every concept in the label, each with a short description when derivable (first mapped `title` + truncated first text property, else bare link). Uses the configured link style.
- REQ-F-062: The root directory contains a generated virtual `/log.md` derived from mapped `timestamp` values: entries grouped under `## YYYY-MM-DD` headings, newest first, each entry a bullet `**Update** <link to concept>`. Nodes without a resolvable timestamp are omitted. If no node resolves a timestamp, `log.md` renders with an explanatory single line (or is omitted — decide in implementation, test the chosen rule).
- REQ-F-063: Generated files are read-only virtual files like everything else: correct `getattr` sizes, cached with the label-listing TTL, regenerated after cache expiry (never stale relative to the cache window).
- REQ-F-064: Index/log generation must not trigger per-node property queries beyond what listings already fetch — reuse/extend the node-list query to return the mapped title/timestamp/description columns in one round trip per label.

**Read-only & FUSE behavior**

- REQ-F-030: All write operations continue returning `EROFS`.
- REQ-F-031: Path parsing for markdown mode produces its own `PathContext` shape (root/label/markdown-file) and rejects deeper paths with `ENOENT`.
- REQ-F-032: Rendered markdown is cached with the existing cache subsystem (properties + relationships TTLs); a node's markdown requires at most two queries (properties, relationships).

**Odyssey example vault & validation**

- REQ-F-040: `test/fixtures/odyssey/` contains 20 hand-authored markdown concept files across several labels (e.g. `Character/`, `Place/`, `Creature/`, `Event/`) with frontmatter properties (including `type`, mapped `title`/`timestamp`/`tags` where sensible), per-rel-type links, and body text — a coherent mini-wiki of the Odyssey — plus expected `index.md` and `log.md` files.
- REQ-F-041: `test/fixtures/odyssey/import.cypher` creates the equivalent graph (constraints on the naming property per label, nodes, relationships) such that mounting in markdown mode reproduces the fixtures.
- REQ-F-042: A fixture-level unit test renders each imported node through the markdown renderer (mock/db-level, no FUSE) and compares against the fixture file after normalization (trailing-whitespace/final-newline normalization; frontmatter key order must be deterministic: `type` first, then mapped fields (`title`, `timestamp`, `tags`), then remaining properties alphabetical, then relationship keys alphabetical). Fixtures for the generated `index.md` files and `log.md` are included in the round-trip comparison.
- REQ-F-043: An integration test script (Docker-based, using neo4j-cli to run an ephemeral Neo4j container and pipe `import.cypher`) mounts the FS in markdown mode and diffs the mounted tree against `test/fixtures/odyssey/` (documented in `test/manual.md` or automated where the environment allows; credentials via `integration.env` if needed).

### Non-Functional Requirements

- REQ-NF-001: `classic` mode behavior and performance are unchanged (no regression in existing tests).
- REQ-NF-002: Rendering one markdown file issues ≤2 Cypher queries (properties + relationships) with caching; label listing reuses existing node-list queries.
- REQ-NF-003: Deterministic output: identical graph + config always renders byte-identical files (stable key ordering, stable link ordering — targets sorted alphabetically).
- REQ-NF-004: New code follows existing module layout (`src/markdown/` renderer + extensions in `src/core/`/`src/fuse/`), TypeScript strict, vitest unit tests colocated, try-catch-wrapped FUSE callbacks per AGENTS.md learnings.
- REQ-NF-005: YAML frontmatter emitted via the existing `yaml` dependency (no new runtime deps).

## Technical Considerations

- **Path parser**: `src/core/path-parser.ts` currently encodes the classic hierarchy. Introduce a mode-aware parser (or a second parser selected at daemon startup) producing `{ type: 'root' | 'label' | 'mdfile', label?, nodeName? }`. Filenames must be stripped of `.md` before node lookup.
- **Renderer module**: new `src/markdown/renderer.ts` — pure function `(properties, relationships, config) → string` for easy unit testing; frontmatter via `yaml.stringify` with explicit key ordering; wikilinks quoted to survive YAML; link-style strategy injected from config.
- **Queries**: reuse `getNodeProperties` and `getRelationships`; relationship query already returns target label + display name needed for `Label/name` links. Verify incoming-relationship naming resolution reuses the target node's label naming override.
- **getattr sizing**: classic mode computes JSON size on stat; markdown mode must render (and cache) markdown at `getattr` time for correct sizes — cache the rendered string keyed by node elementId so `read` reuses it.
- **Config**: extend `ConfigSchema` + `ConfigParser` validation with the `mode` section; defaults keep `classic`. CLI flag plumbs through `MountOptions`.
- **Multi-label nodes**: existing queries are label-scoped; ensure a node with labels `[Hero, Character]` doesn't render twice when both labels are mounted (document v1 behavior: it appears under each mounted label — or dedupe; decide in implementation, test either way). *(flagged in Open Questions)*
- **OKF alignment (v0.1 draft)**: OKF = directory tree of markdown files with YAML frontmatter; only `type` is required; unknown keys must be tolerated; links are untyped markdown links, bundle-relative absolute form recommended; `index.md`/`log.md` are reserved (index = section-grouped bullet lists of links with short descriptions; log = date-grouped entries, newest first, `YYYY-MM-DD` headings); conformance is deliberately permissive. Our typed per-rel-type frontmatter link keys are a valid OKF *extension* (OKF links normally live in body prose — our frontmatter keys are producer-defined extension keys, which consumers must preserve).
- **Index/log query cost**: `log.md` needs mapped timestamps for *all* rendered nodes; with per-field fallback lists this is a `coalesce(n.updated, n.lastUpdated, ...)` projection added to the existing label-listing query — one query per label, cached. Root `index.md` needs only the label list. Label `index.md` descriptions reuse the same extended listing projection (title + first text property truncated).
- **Odyssey fixtures**: author fixtures first, derive `import.cypher` from them, then use the round-trip test to lock rendering semantics — fixtures act as the executable spec.
- **Docker/neo4j-cli**: use the neo4j-cli skill's ephemeral container flow (`neo4j-cli dbms` create/run emitting `.env`) for the integration test; Docker is available in the dev environment.
- **Future subgraph composition**: keep the renderer's input a plain data structure (node + relations) so a later "compose from central node + rel-type traversal" feature can feed it a merged structure without FUSE-layer changes.
- **Resolver seam for computed fields**: implement v1 field/text resolution behind a resolver interface (property-fallback resolver now; Cypher resolver later — see Future Extensions) so config can later accept `{cypher: ...}` in place of a property name without renderer changes.

## Acceptance Criteria

- [ ] `lpgfs mount --mode markdown` (or `mode.type: markdown` in `.lpgfs.yaml`) renders `/<Label>/<name>.md` files; default mount remains classic with all existing tests green.
- [ ] Frontmatter starts with `type: <Label>`, contains node properties (minus body text properties) and per-rel-type lists of links; output is deterministic and OKF v0.1 conformant.
- [ ] `linkStyle: wikilink` (default) emits quoted `"[[Label/name]]"`; `linkStyle: markdown` emits `/Label/name.md` bundle-relative links.
- [ ] `mode.markdown.textProperties` (default + per-label overrides) controls body composition; multiple present properties concatenate in order with `## <property>` headings; single property renders bare.
- [ ] `mode.markdown.labels` restricts rendered labels; unset renders all.
- [ ] `title`/`timestamp`/`tags` are mapped per node from configurable ordered fallback lists (first existing property wins, source property not duplicated, missing = omitted).
- [ ] Root `/index.md` (with `okf_version: "0.1"`), per-label `/<Label>/index.md` listings, and `/log.md` (date-grouped, newest-first, from mapped timestamps) are generated as virtual read-only files with correct sizes, without per-node extra queries.
- [ ] All write operations in markdown mode return `EROFS`; unknown/deep paths return `ENOENT`; `getattr` sizes match rendered byte length.
- [ ] `test/fixtures/odyssey/` holds 20 concept files + expected `index.md`/`log.md` files + `import.cypher`; the renderer round-trip unit test reproduces all fixtures (normalized).
- [ ] Integration path documented/automated: ephemeral Neo4j via neo4j-cli Docker, import script applied, mounted tree diffs clean against fixtures.
- [ ] Unit tests cover: config parsing of the `mode` section, markdown path parsing, frontmatter serialization edge cases (special chars, temporal values, list properties, `type` property clash), sanitization of Obsidian-illegal characters, reserved-filename avoidance (`index`/`log`), empty-body nodes, incoming-links option, both link styles, field-mapping fallback order (e.g. node with `updated` vs node with only `lastUpdated`), scalar→list tags coercion, index/log generation edge cases (empty label, no timestamps anywhere).

## Future Extensions (design for, don't build)

- **Cypher-computed fields**: any mapped field (`title`, `timestamp`, `tags`) and any text-body entry may alternatively be defined as a Cypher fragment instead of a property fallback list. The system auto-generates the anchor prefix (`MATCH (n) WHERE elementId(n) = $nodeElementId`, prepended at execution time) — the user writes only the suffix, with `n` pre-bound to the current node, and the query's single column becomes the value:
  ```yaml
  fields:
    timestamp:
      cypher: "MATCH (n)-[:HAS_REVISION]->(r) RETURN max(r.date)"
    tags:
      cypher: "MATCH (n)-[:IN_CATEGORY]->(c) RETURN collect(c.name)"
  textProperties:
    default:
      - summary                                   # property shorthand (current behavior)
      - cypher: "MATCH (n)-[:HAS_SECTION]->(s) RETURN s.text ORDER BY s.position"
  ```
  List-returning text queries concatenate rows (blank-line separated) within that body section. (Same fragment convention as neo4j-graphrag's `retrieval_query`: a pre-bound variable + user-supplied traversal suffix.)
- **Cypher-computed frontmatter attributes**: a general `computedAttributes` map (global + per-label) where each key is a frontmatter attribute name and the value a Cypher fragment (same pre-bound `n` convention); a query returning a map spreads into multiple frontmatter keys. Computed attributes render after mapped fields, before relationship keys.
- **Whole-node render query**: instead of per-field fragments, a single `renderQuery` (global, with optional per-label overrides) computes the entire rendered node in one round trip. Same pre-bound `n`; the query returns one row with well-known columns that fully drive the renderer:
  ```yaml
  mode:
    markdown:
      renderQuery:
        default: |
          RETURN n.name AS title,
                 properties(n) AS frontmatter,
                 [(n)-[:APPEARS_IN]->(e) | e.name] AS links_APPEARS_IN,
                 [n.summary, n.text] AS textSections
        overrides:
          Character: "..."
  ```
  Contract: `frontmatter` (map), `textSections` (list of strings, null entries skipped), optional `title`/`timestamp`/`tags`, and `links_<KEY>` columns (lists of `Label/name` strings or node references) that become per-key frontmatter link lists. Anything the query doesn't return falls back to the default pipeline (properties + relationships). This subsumes per-field fragments for power users while keeping one query per file (replaces the ≤2-query default); it is also the natural stepping stone to subgraph composition.
- **Design hook for v1**: the renderer already takes a plain resolved-values data structure; field/text resolution sits behind a small resolver interface so a `CypherFieldResolver` (per-field fragments) or `RenderQueryResolver` (whole-node query) can be added next to the `PropertyFallbackResolver` without touching the renderer. Cache computed values with the properties TTL. (Caveats to settle then: read-only enforcement on user-supplied fragments — reject write clauses / run in read transactions; per-node query cost/batching; timeouts; validating the renderQuery column contract with a clear error at mount time.)
- **Subgraph/document composition**: compose a markdown file (or folder structure) from a central node plus a rel-type traversal — same renderer, merged input structure (already noted in Technical Considerations).

## Out of Scope

- Write-back of markdown edits to the graph.
- Subgraph/document composition (central node + rel-type traversal into one file or folder structure) — planned follow-up.
- Relationship property rendering in markdown mode.
- Generated `.obsidian/` vault configuration, Dataview/plugin-specific metadata.
- OKF `resource`/`Citations` conventions and non-markdown bundle assets.
- Vector/semantic features, embeddings, or search.

## Open Questions

- Multi-label nodes: render under every mounted label (duplicate files, identical content) or dedupe to the first label? V1 leans "first label wins" (REQ-F-014) — confirm during implementation if the label-scoped queries make dedupe expensive.
- `type` property clash rule (REQ-F-021): property wins with label under `label:`, or label wins with property under `type_property:`? Pick one during implementation and test it.
- Should `in_<TYPE>` incoming keys instead be merged into the same `<TYPE>` key? Current decision: separate `in_` prefix to avoid direction ambiguity, off by default.
- Root `index.md` frontmatter: OKF says the root index is the only index allowed frontmatter (`okf_version`) — does it also need/permit `type`? Verify against the spec text during implementation; lean minimal (`okf_version` only).
- `log.md` with zero resolvable timestamps: omit the file or render a stub line? Pick one and test it.
- Should `tags` additionally include the node's extra labels (beyond the folder label)? Deferred to keep the mapping purely property-driven in v1; noted as a natural extension.
