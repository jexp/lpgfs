/**
 * Pure rendering of the generated OKF bundle-index files (REQ-F-060/061):
 * the virtual root `/index.md` and the per-label `/<Label>/index.md`.
 *
 * Both take already-projected data (rendered label list, or
 * MarkdownIndexNodeResult rows from listNodesForMarkdownIndex) so no
 * database access happens here — callers in src/fuse/handlers.ts own
 * fetching and caching.
 */

import { stringify as stringifyYaml } from 'yaml';
import type { LinkStyle } from '../types/index.js';
import { renderConceptLink, toBodyText } from './renderer.js';
import type { MarkdownIndexNodeResult } from '../db/queries.js';
import type { PropertyValue } from '../types/index.js';

export const OKF_VERSION = '0.1';

/**
 * Renders the virtual root `/index.md`: the only generated file allowed
 * frontmatter without a `type` key per OKF (it describes the bundle, not a
 * concept). One `## <Label>` section per rendered label, each with a
 * bullet-list link to that label's own `/<Label>/index.md`.
 */
export function renderRootIndex(renderedLabels: string[], linkStyle: LinkStyle): string {
  const frontmatter = stringifyYaml({ okf_version: OKF_VERSION });
  const sortedLabels = [...renderedLabels].sort();

  const sections = sortedLabels
    .map((label) => {
      const link = renderConceptLink(label, 'index', linkStyle);
      return `## ${label}\n\n- ${link}`;
    })
    .join('\n\n');

  const body = sortedLabels.length === 0 ? '' : `${sections}\n`;

  return `---\n${frontmatter}---\n\n${body}`;
}

function describeNode(node: MarkdownIndexNodeResult): string | null {
  const titleText = node.title === undefined ? null : propertyValueToText(node.title);
  const descriptionText = node.description ?? null;

  if (titleText && descriptionText) return `${titleText} — ${descriptionText}`;
  if (titleText) return titleText;
  if (descriptionText) return descriptionText;
  return null;
}

function propertyValueToText(value: PropertyValue): string | null {
  const text = toBodyText(value);
  return text === '' ? null : text;
}

/**
 * Renders a per-label `/<Label>/index.md`: no frontmatter (OKF reserves
 * index.md/log.md as unframed listing files), a bullet list of links to
 * every concept mounted under this label, each optionally followed by a
 * short derived description. A label with zero nodes still renders a
 * minimal valid (non-empty) file rather than erroring.
 */
export function renderLabelIndex(label: string, nodes: MarkdownIndexNodeResult[], linkStyle: LinkStyle): string {
  if (nodes.length === 0) {
    return `# ${label}\n\n*No concepts in this label.*\n`;
  }

  const sortedNodes = [...nodes].sort((a, b) => a.name.localeCompare(b.name));

  const items = sortedNodes
    .map((node) => {
      const link = renderConceptLink(label, node.name, linkStyle);
      const description = describeNode(node);
      return description ? `- ${link} — ${description}` : `- ${link}`;
    })
    .join('\n');

  return `# ${label}\n\n${items}\n`;
}
