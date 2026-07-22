/**
 * Property-fallback implementation of the {@link FieldResolver} interface
 * (REQ-F-050/051/052): for each of title/timestamp/tags, walks a configured
 * ordered list of property names and maps the first one present on the
 * node to the canonical frontmatter key.
 */

import type { MarkdownFieldsConfig, Properties, PropertyValue } from '../types/index.js';
import type { FieldResolver, ResolvedFields } from './renderer.js';

type MappedField = 'title' | 'timestamp' | 'tags';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absSeconds = Math.abs(offsetSeconds);
  return `${sign}${pad(Math.floor(absSeconds / 3600))}:${pad(Math.floor((absSeconds % 3600) / 60))}`;
}

function isPlainObject(value: PropertyValue): value is Record<string, PropertyValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects the plain-object shape produced by db/connection.ts's generic
 * temporal transform (Neo4j Date/DateTime/Time/LocalDateTime/LocalTime,
 * with Integer sub-fields already converted to plain numbers).
 */
function isTemporalShape(value: Record<string, PropertyValue>): boolean {
  const hasDate = typeof value.year === 'number' && typeof value.month === 'number' && typeof value.day === 'number';
  const hasTime = typeof value.hour === 'number' && typeof value.minute === 'number' && typeof value.second === 'number';
  return hasDate || hasTime;
}

function temporalToIso(value: Record<string, PropertyValue>): string {
  const hasDate = typeof value.year === 'number';
  const hasTime = typeof value.hour === 'number';

  let result = '';
  if (hasDate) {
    const year = value.year as number;
    const yearPart = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
    result += `${yearPart}-${pad((value.month as number) ?? 1)}-${pad((value.day as number) ?? 1)}`;
  }
  if (hasTime) {
    let timePart = `${pad(value.hour as number)}:${pad((value.minute as number) ?? 0)}:${pad((value.second as number) ?? 0)}`;
    if (typeof value.nanosecond === 'number') {
      timePart += `.${pad(Math.floor(value.nanosecond / 1_000_000), 3)}`;
    }
    result += hasDate ? `T${timePart}` : timePart;
  }
  if (typeof value.timeZoneOffsetSeconds === 'number') {
    result += formatOffset(value.timeZoneOffsetSeconds);
  }
  return result;
}

/**
 * Serializes a resolved timestamp property value as an ISO 8601 string
 * (REQ-F-052), reusing the temporal-transform shape db/connection.ts
 * already produces for other properties rather than re-implementing
 * Neo4j temporal decoding.
 */
export function toIsoTimestamp(value: PropertyValue): string {
  if (typeof value === 'string') return value;
  if (isPlainObject(value) && isTemporalShape(value)) return temporalToIso(value);
  if (typeof value === 'number') {
    try {
      return new Date(value).toISOString();
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function resolveFallbackList(
  field: MappedField,
  fieldsConfig: MarkdownFieldsConfig,
  label: string | undefined
): string[] {
  const override = label ? fieldsConfig.overrides?.[field]?.[label] : undefined;
  return override ?? fieldsConfig[field];
}

function findFirstPresentProperty(names: string[], properties: Properties): string | undefined {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) continue;
    const value = properties[name];
    if (value === undefined || value === null) continue;
    return name;
  }
  return undefined;
}

/**
 * Default {@link FieldResolver}: maps title/timestamp/tags from ordered
 * per-label (or default) property fallback lists.
 */
export const propertyFallbackFieldResolver: FieldResolver = {
  resolve(labels: string[], properties: Properties, fieldsConfig: MarkdownFieldsConfig): ResolvedFields {
    const label = labels[0];
    const consumedProperties = new Set<string>();
    const resolved: ResolvedFields = { consumedProperties };

    const titleSource = findFirstPresentProperty(
      resolveFallbackList('title', fieldsConfig, label),
      properties
    );
    if (titleSource !== undefined) {
      resolved.title = properties[titleSource]!;
      consumedProperties.add(titleSource);
    }

    const timestampSource = findFirstPresentProperty(
      resolveFallbackList('timestamp', fieldsConfig, label),
      properties
    );
    if (timestampSource !== undefined) {
      resolved.timestamp = toIsoTimestamp(properties[timestampSource]!);
      consumedProperties.add(timestampSource);
    }

    const tagsSource = findFirstPresentProperty(
      resolveFallbackList('tags', fieldsConfig, label),
      properties
    );
    if (tagsSource !== undefined) {
      const value = properties[tagsSource]!;
      resolved.tags = Array.isArray(value) ? value : [value];
      consumedProperties.add(tagsSource);
    }

    return resolved;
  },
};
