/**
 * LPGFS Markdown-Mode Path Parser
 *
 * Parses filesystem paths into MarkdownPathContext objects when
 * mode.type === 'markdown'. Unlike the classic parser, malformed or
 * out-of-scope paths are rejected with an ENOENT LpgfsError rather than
 * being passed through for the FUSE layer to validate.
 *
 * Path Resolution:
 * - /                    → { type: 'root' }
 * - /index.md            → { type: 'root-index' }
 * - /log.md              → { type: 'root-log' }
 * - /<Label>             → { type: 'label', label: 'Label' }
 * - /<Label>/index.md    → { type: 'label-index', label: 'Label' }
 * - /<Label>/<name>.md   → { type: 'node', label: 'Label', nodeName: 'name' }
 * - anything else        → throws LpgfsError(ENOENT)
 */

import { LpgfsError, POSIX_ERRORS } from '../types/index.js';
import type { MarkdownPathContext } from '../types/index.js';

export type { MarkdownPathContext, MarkdownPathType } from '../types/index.js';

/** Generated root-level index filename. */
export const ROOT_INDEX_FILENAME = 'index.md';

/** Generated root-level log filename. */
export const ROOT_LOG_FILENAME = 'log.md';

/** Extension used for rendered node files. */
const MARKDOWN_EXTENSION = '.md';

function enoent(path: string): never {
  throw new LpgfsError(`No such file or directory: ${path}`, POSIX_ERRORS.ENOENT);
}

/**
 * Strip the trailing ".md" extension from a filename.
 * Returns null if the filename does not end with ".md" or if the
 * remaining basename would be empty.
 */
function stripMarkdownExtension(filename: string): string | null {
  if (!filename.endsWith(MARKDOWN_EXTENSION)) {
    return null;
  }
  const base = filename.slice(0, -MARKDOWN_EXTENSION.length);
  return base.length > 0 ? base : null;
}

/**
 * Parse a filesystem path into a MarkdownPathContext object.
 *
 * @param path - The filesystem path to parse (e.g., "/Character/odysseus.md")
 * @returns MarkdownPathContext object describing the path
 * @throws LpgfsError with ENOENT for any path deeper than a node file,
 *   or otherwise malformed for markdown mode.
 *
 * @example
 * parseMarkdownPath('/') // { type: 'root' }
 * parseMarkdownPath('/index.md') // { type: 'root-index' }
 * parseMarkdownPath('/log.md') // { type: 'root-log' }
 * parseMarkdownPath('/Character') // { type: 'label', label: 'Character' }
 * parseMarkdownPath('/Character/index.md') // { type: 'label-index', label: 'Character' }
 * parseMarkdownPath('/Character/odysseus.md') // { type: 'node', label: 'Character', nodeName: 'odysseus' }
 */
export function parseMarkdownPath(path: string): MarkdownPathContext {
  const normalizedPath = path.replace(/\/+$/, '') || '/';

  if (normalizedPath === '/') {
    return { type: 'root' };
  }

  // Split on '/' without filtering out empty segments, so that
  // malformed paths like "//foo.md" or "/Label//node.md" are rejected
  // instead of being silently normalized into a valid path.
  const segments = normalizedPath.slice(1).split('/');

  if (segments.some((segment) => segment === '')) {
    enoent(path);
  }

  // 1 segment: /index.md, /log.md, or /<Label>
  if (segments.length === 1) {
    const segment0 = segments[0]!;
    if (segment0 === ROOT_INDEX_FILENAME) {
      return { type: 'root-index' };
    }
    if (segment0 === ROOT_LOG_FILENAME) {
      return { type: 'root-log' };
    }
    return { type: 'label', label: segment0 };
  }

  // 2 segments: /<Label>/index.md or /<Label>/<name>.md
  if (segments.length === 2) {
    const label = segments[0]!;
    const segment1 = segments[1]!;

    if (segment1 === ROOT_INDEX_FILENAME) {
      return { type: 'label-index', label };
    }

    const nodeName = stripMarkdownExtension(segment1);
    if (nodeName === null) {
      enoent(path);
    }
    return { type: 'node', label, nodeName };
  }

  // 3+ segments: nothing exists deeper than a node file in markdown mode
  enoent(path);
}
