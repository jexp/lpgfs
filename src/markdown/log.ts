/**
 * Pure rendering logic for the virtual root /log.md file (markdown mode).
 *
 * Groups every rendered node that resolved a mapped `timestamp` (across all
 * rendered labels) by date (`## YYYY-MM-DD`, newest first), rendering each
 * as a `**Update** <link>` bullet in the configured link style. Multi-label
 * dedup and the "no resolvable timestamp" filtering happen upstream (in the
 * per-label `listNodesForMarkdownIndex` projection and its caller); this
 * module assumes every entry it's given already has a `timestamp`.
 */

import type { LinkStyle } from '../types/index.js';

/** One node contributing an entry to the log, with its rendered label. */
export interface LogSourceEntry {
  /** The label the node is rendered under (its chosen label, REQ-F-014). */
  label: string;
  /** The node's display name. */
  name: string;
  /** ISO 8601 mapped timestamp (from listNodesForMarkdownIndex). */
  timestamp: string;
}

/**
 * Body rendered when no node anywhere in the rendered graph resolves a
 * timestamp. Chosen over omitting /log.md entirely (the PRD's "zero
 * resolvable timestamps" Open Question) so the generated file set stays
 * uniform: /log.md always exists and always has a well-defined getattr
 * size, matching /index.md's unconditional presence, rather than making
 * ENOENT-vs-present depend on graph content.
 */
export const EMPTY_LOG_STUB = 'No entries have a resolvable timestamp yet.\n';

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Extracts the date-only portion (`YYYY-MM-DD`) from a mapped timestamp.
 * Handles both date-time strings (splits on the first `T`) and bare date
 * strings (already 10 characters). A non-ISO fallback value that's shorter
 * than a full date is used as-is, since it can't be meaningfully truncated
 * further.
 */
function extractDatePortion(timestamp: string): string {
  const tIndex = timestamp.indexOf('T');
  if (tIndex !== -1) return timestamp.slice(0, tIndex);
  return timestamp.length > 10 ? timestamp.slice(0, 10) : timestamp;
}

function renderLogLink(label: string, name: string, linkStyle: LinkStyle): string {
  if (linkStyle === 'wikilink') {
    return `[[${label}/${name}]]`;
  }
  return `/${label}/${name}.md`;
}

/**
 * Renders the full /log.md content from a flat list of timestamped entries
 * merged across every rendered label.
 */
export function renderRootLog(entries: LogSourceEntry[], linkStyle: LinkStyle): string {
  if (entries.length === 0) {
    return EMPTY_LOG_STUB;
  }

  const byDate = new Map<string, LogSourceEntry[]>();
  for (const entry of entries) {
    const date = extractDatePortion(entry.timestamp);
    const group = byDate.get(date);
    if (group) {
      group.push(entry);
    } else {
      byDate.set(date, [entry]);
    }
  }

  const datesDescending = Array.from(byDate.keys())
    .sort(compareStrings)
    .reverse();

  const sections = datesDescending.map((date) => {
    const items = [...byDate.get(date)!].sort((a, b) => {
      const byLabel = compareStrings(a.label, b.label);
      return byLabel !== 0 ? byLabel : compareStrings(a.name, b.name);
    });
    const bullets = items
      .map((item) => `- **Update** ${renderLogLink(item.label, item.name, linkStyle)}`)
      .join('\n');
    return `## ${date}\n\n${bullets}`;
  });

  return `${sections.join('\n\n')}\n`;
}
