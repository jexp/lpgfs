/**
 * Filename Sanitization
 *
 * Sanitizes property values for use as filesystem names.
 * Follows PRD section 8.4 (Property Value Sanitization).
 */

import {
  SanitizationConfig,
  DEFAULT_CONFIG,
  PropertyValue,
} from '../types/index.js';

/**
 * Default placeholder for empty or null values.
 */
const EMPTY_PLACEHOLDER = '_empty_';

/**
 * Sanitize a property value for use as a filename.
 *
 * Replaces characters that are invalid or problematic in filesystem names.
 * Uses the replacement map from the sanitization config.
 *
 * @param value - The property value to sanitize
 * @param config - Sanitization configuration (uses defaults if not provided)
 * @returns A sanitized string safe for use as a filename
 *
 * @example
 * sanitize('hello/world'); // 'hello_world'
 * sanitize('test:file'); // 'test_file'
 * sanitize(null); // '_empty_'
 * sanitize(''); // '_empty_'
 */
export function sanitize(
  value: PropertyValue,
  config?: SanitizationConfig
): string {
  // Use default config if not provided
  const sanitizationConfig = config ?? DEFAULT_CONFIG.sanitization!;
  const replaceMap = sanitizationConfig.replace;

  // Handle null/undefined
  if (value === null || value === undefined) {
    return EMPTY_PLACEHOLDER;
  }

  // Convert value to string
  let str = stringifyValue(value);

  // Handle empty string
  if (str === '') {
    return EMPTY_PLACEHOLDER;
  }

  // Apply character replacements
  for (const [char, replacement] of Object.entries(replaceMap)) {
    // Escape special regex characters in the search character
    const escapedChar = escapeRegExp(char);
    str = str.replace(new RegExp(escapedChar, 'g'), replacement);
  }

  // Trim leading/trailing whitespace and dots (problematic on some filesystems)
  str = str.trim().replace(/^\.+|\.+$/g, '_');

  // Handle result being empty after sanitization
  if (str === '' || str === '_') {
    return EMPTY_PLACEHOLDER;
  }

  return str;
}

/**
 * Convert a property value to a string representation.
 *
 * @param value - The value to stringify
 * @returns String representation of the value
 */
function stringifyValue(value: PropertyValue): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  // Arrays and objects - use JSON representation
  // This is a fallback; typically property naming uses scalar values
  return JSON.stringify(value);
}

/**
 * Escape special regex characters in a string.
 *
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp
 */
function escapeRegExp(str: string): string {
  // Escape all special regex characters
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a string is a valid filename after sanitization.
 *
 * A valid filename:
 * - Is not empty
 * - Does not contain forbidden characters
 * - Is not a reserved name (., ..)
 *
 * @param name - The filename to validate
 * @returns True if the filename is valid
 */
export function isValidFilename(name: string): boolean {
  if (!name || name === '' || name === '.' || name === '..') {
    return false;
  }

  // Check for any remaining forbidden characters
  const forbiddenChars = ['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'];
  for (const char of forbiddenChars) {
    if (name.includes(char)) {
      return false;
    }
  }

  return true;
}

/**
 * Sanitize an elementId for use as a filename.
 *
 * ElementIds in Neo4j have format like "4:abc123:0" which contains colons.
 * This function converts them to a filesystem-safe format.
 *
 * @param elementId - The database elementId
 * @param config - Optional sanitization config
 * @returns A sanitized elementId safe for use as a filename
 *
 * @example
 * sanitizeElementId('4:abc123:0'); // '4_abc123_0'
 */
export function sanitizeElementId(
  elementId: string,
  config?: SanitizationConfig
): string {
  return sanitize(elementId, config);
}
