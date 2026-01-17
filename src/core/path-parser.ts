/**
 * LPGFS Path Parser
 *
 * Parses filesystem paths into PathContext objects for determining
 * which database query to execute.
 *
 * Path Resolution (Section 12.3):
 * - /                              → { type: 'root' }
 * - /.lpgfs.yaml                   → { type: 'properties', isConfigFile: true }
 * - /Person                        → { type: 'label', label: 'Person' }
 * - /Person/alice                  → { type: 'node', label: 'Person', nodeName: 'alice' }
 * - /Person/alice/.properties.json → { type: 'properties', ..., isPropertiesFile: true }
 * - /Person/alice/KNOWS            → { type: 'reltype', ..., relType: 'KNOWS' }
 * - /Person/alice/KNOWS/OUT        → { type: 'direction', ..., direction: 'OUT' }
 * - /Person/alice/KNOWS/OUT/james  → { type: 'target', ..., targetName: 'james' }
 * - /Person/alice/KNOWS/OUT/.james.json → { type: 'properties', ..., isRelPropertiesFile: true }
 */

import type { PathContext, Direction } from '../types/index.js';

/**
 * Configuration file name at the filesystem root.
 */
export const CONFIG_FILENAME = '.lpgfs.yaml';

/**
 * Node properties file name.
 */
export const PROPERTIES_FILENAME = '.properties.json';

/**
 * Valid relationship directions.
 */
const VALID_DIRECTIONS: readonly Direction[] = ['OUT', 'IN'] as const;

/**
 * Check if a string is a valid direction.
 */
function isDirection(value: string): value is Direction {
  return VALID_DIRECTIONS.includes(value as Direction);
}

/**
 * Check if a filename is a relationship properties file (e.g., .james.json).
 * Must start with a dot, end with .json, and not be .properties.json.
 */
function isRelPropertiesFilename(filename: string): boolean {
  return (
    filename.startsWith('.') &&
    filename.endsWith('.json') &&
    filename !== PROPERTIES_FILENAME
  );
}

/**
 * Extract the target name from a relationship properties filename.
 * e.g., ".james.json" → "james"
 */
export function extractTargetFromRelPropertiesFilename(
  filename: string
): string | null {
  if (!isRelPropertiesFilename(filename)) {
    return null;
  }
  // Remove leading "." and trailing ".json"
  return filename.slice(1, -5);
}

/**
 * Parse a filesystem path into a PathContext object.
 *
 * @param path - The filesystem path to parse (e.g., "/Person/alice/KNOWS/OUT/james")
 * @returns PathContext object describing the path
 *
 * @example
 * parsePath('/') // { type: 'root' }
 * parsePath('/Person') // { type: 'label', label: 'Person' }
 * parsePath('/Person/alice') // { type: 'node', label: 'Person', nodeName: 'alice' }
 * parsePath('/Person/alice/.properties.json') // { type: 'properties', label: 'Person', nodeName: 'alice', isPropertiesFile: true }
 * parsePath('/Person/alice/KNOWS') // { type: 'reltype', label: 'Person', nodeName: 'alice', relType: 'KNOWS' }
 * parsePath('/Person/alice/KNOWS/OUT') // { type: 'direction', label: 'Person', nodeName: 'alice', relType: 'KNOWS', direction: 'OUT' }
 * parsePath('/Person/alice/KNOWS/OUT/james') // { type: 'target', label: 'Person', nodeName: 'alice', relType: 'KNOWS', direction: 'OUT', targetName: 'james' }
 * parsePath('/Person/alice/KNOWS/OUT/.james.json') // { type: 'properties', label: 'Person', nodeName: 'alice', relType: 'KNOWS', direction: 'OUT', targetName: 'james', isRelPropertiesFile: true }
 */
export function parsePath(path: string): PathContext {
  // Normalize path: remove trailing slash, handle empty path
  const normalizedPath = path.replace(/\/+$/, '') || '/';

  // Root path
  if (normalizedPath === '/') {
    return { type: 'root' };
  }

  // Split path into segments (remove empty first segment from leading /)
  const segments = normalizedPath.split('/').filter((s) => s !== '');

  // Handle config file at root
  if (segments.length === 1 && segments[0] === CONFIG_FILENAME) {
    return { type: 'properties', isConfigFile: true };
  }

  // Build context based on number of segments
  // Segment 0: label
  // Segment 1: nodeName or .properties.json
  // Segment 2: relType
  // Segment 3: direction (OUT/IN)
  // Segment 4: targetName or .targetName.json

  const label = segments[0];

  // 1 segment: /Label
  if (segments.length === 1) {
    return { type: 'label', label };
  }

  const segment1 = segments[1];

  // 2 segments: /Label/nodeName or /Label/.properties.json (invalid - properties is under node)
  if (segments.length === 2) {
    // Check if this is an attempt to access .properties.json directly under label (invalid path)
    if (segment1 === PROPERTIES_FILENAME) {
      // This is an invalid path - .properties.json should be under a node
      // Return as node type with nodeName being .properties.json
      // The FUSE layer will handle returning ENOENT
      return { type: 'node', label, nodeName: segment1 };
    }
    return { type: 'node', label, nodeName: segment1 };
  }

  const nodeName = segment1;
  const segment2 = segments[2];

  // 3 segments: /Label/nodeName/.properties.json or /Label/nodeName/relType
  if (segments.length === 3) {
    if (segment2 === PROPERTIES_FILENAME) {
      return {
        type: 'properties',
        label,
        nodeName,
        isPropertiesFile: true,
      };
    }
    return { type: 'reltype', label, nodeName, relType: segment2 };
  }

  const relType = segment2;
  // segments[3] is guaranteed to exist since segments.length >= 4 at this point
  const segment3 = segments[3]!;

  // 4 segments: /Label/nodeName/relType/direction
  if (segments.length === 4) {
    if (isDirection(segment3)) {
      return {
        type: 'direction',
        label,
        nodeName,
        relType,
        direction: segment3,
      };
    }
    // Invalid direction - treat as direction anyway, FUSE layer handles validation
    return {
      type: 'direction',
      label,
      nodeName,
      relType,
      direction: segment3 as Direction,
    };
  }

  // Validate direction for 5+ segments
  if (!isDirection(segment3)) {
    // Invalid path structure, but return what we can parse
    return {
      type: 'direction',
      label,
      nodeName,
      relType,
      direction: segment3 as Direction,
    };
  }

  const direction = segment3;
  // segments[4] is guaranteed to exist since segments.length >= 5 at this point
  const segment4 = segments[4]!;

  // 5 segments: /Label/nodeName/relType/direction/targetName or .../.targetName.json
  if (segments.length === 5) {
    if (isRelPropertiesFilename(segment4)) {
      const targetName = extractTargetFromRelPropertiesFilename(segment4);
      return {
        type: 'properties',
        label,
        nodeName,
        relType,
        direction,
        targetName: targetName || undefined,
        isRelPropertiesFile: true,
      };
    }
    return {
      type: 'target',
      label,
      nodeName,
      relType,
      direction,
      targetName: segment4,
    };
  }

  // 6+ segments: paths beyond target (e.g., following symlink)
  // For symlink traversal, we only need to return the target context
  // The symlink resolution will handle the rest
  const targetName = segment4;

  // Check if segment 5 is .properties.json (reading target node's properties via symlink)
  if (segments.length === 6 && segments[5] === PROPERTIES_FILENAME) {
    return {
      type: 'properties',
      label,
      nodeName,
      relType,
      direction,
      targetName,
      isPropertiesFile: true,
    };
  }

  // For deeper paths, return target context
  // These paths are typically resolved via symlink traversal
  return {
    type: 'target',
    label,
    nodeName,
    relType,
    direction,
    targetName,
  };
}

/**
 * Generate a cache key from a PathContext for caching purposes.
 *
 * @param context - The PathContext to generate a key for
 * @returns A string key suitable for caching
 */
export function pathContextToCacheKey(context: PathContext): string {
  const parts: string[] = [context.type];

  if (context.label) parts.push(context.label);
  if (context.nodeName) parts.push(context.nodeName);
  if (context.relType) parts.push(context.relType);
  if (context.direction) parts.push(context.direction);
  if (context.targetName) parts.push(context.targetName);

  return parts.join(':');
}
