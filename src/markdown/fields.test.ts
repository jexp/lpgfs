/**
 * Tests for the property-fallback FieldResolver implementation.
 */

import { describe, it, expect } from 'vitest';
import { propertyFallbackFieldResolver } from './fields.js';
import { DEFAULT_MARKDOWN_MODE_CONFIG, type MarkdownFieldsConfig, type Properties } from '../types/index.js';

function fields(overrides: Partial<MarkdownFieldsConfig> = {}): MarkdownFieldsConfig {
  return {
    ...DEFAULT_MARKDOWN_MODE_CONFIG.fields,
    ...overrides,
  };
}

describe('propertyFallbackFieldResolver', () => {
  it('resolves timestamp from "updated" and from "lastUpdated" to the same canonical key', () => {
    const withUpdated: Properties = { updated: '2026-01-01T00:00:00.000Z' };
    const withLastUpdated: Properties = { lastUpdated: '2026-02-02T00:00:00.000Z' };

    const a = propertyFallbackFieldResolver.resolve(['Person'], withUpdated, fields());
    const b = propertyFallbackFieldResolver.resolve(['Person'], withLastUpdated, fields());

    expect(a.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(b.timestamp).toBe('2026-02-02T00:00:00.000Z');
    expect(a.consumedProperties.has('updated')).toBe(true);
    expect(b.consumedProperties.has('lastUpdated')).toBe(true);
  });

  it('reports the consumed source property so it is not duplicated in remaining frontmatter', () => {
    const properties: Properties = { title: 'Alice', name: 'Bob' };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields());

    expect(resolved.title).toBe('Alice');
    expect(resolved.consumedProperties.has('title')).toBe(true);
    expect(resolved.consumedProperties.has('name')).toBe(false);
  });

  it('omits a field entirely when the node matches none of its fallbacks', () => {
    const properties: Properties = { unrelated: 'value' };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields());

    expect(resolved.title).toBeUndefined();
    expect(resolved.timestamp).toBeUndefined();
    expect(resolved.tags).toBeUndefined();
    expect(resolved.consumedProperties.size).toBe(0);
  });

  it('coerces a scalar tags value into a single-item list', () => {
    const properties: Properties = { tags: 'solo' };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields());

    expect(resolved.tags).toEqual(['solo']);
  });

  it('leaves an already-list tags value as-is', () => {
    const properties: Properties = { tags: ['a', 'b'] };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields());

    expect(resolved.tags).toEqual(['a', 'b']);
  });

  it('disables a mapping when its fallback list is explicitly empty', () => {
    const properties: Properties = { title: 'Alice', name: 'Bob' };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields({ title: [] }));

    expect(resolved.title).toBeUndefined();
    expect(resolved.consumedProperties.has('title')).toBe(false);
  });

  it('applies per-label overrides for a mapped field', () => {
    const properties: Properties = { headline: 'Breaking News', title: 'Ignored' };
    const config = fields({
      overrides: {
        title: { Article: ['headline'] },
      },
    });

    const articleResult = propertyFallbackFieldResolver.resolve(['Article'], properties, config);
    const personResult = propertyFallbackFieldResolver.resolve(['Person'], properties, config);

    expect(articleResult.title).toBe('Breaking News');
    expect(articleResult.consumedProperties.has('headline')).toBe(true);
    expect(personResult.title).toBe('Ignored');
  });

  it('serializes a date-only temporal-transformed timestamp property as an ISO date', () => {
    const properties: Properties = { updated: { year: 2026, month: 1, day: 15 } };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe('2026-01-15');
  });

  it('serializes a datetime-with-offset temporal-transformed timestamp property as ISO 8601', () => {
    const properties: Properties = {
      updated: {
        year: 2026,
        month: 1,
        day: 15,
        hour: 9,
        minute: 30,
        second: 5,
        nanosecond: 123000000,
        timeZoneOffsetSeconds: 3600,
      },
    };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe('2026-01-15T09:30:05.123+01:00');
  });

  it('serializes a time-only temporal-transformed value without a spurious date prefix', () => {
    const properties: Properties = {
      updated: { hour: 14, minute: 5, second: 9, nanosecond: 500000000 },
    };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe('14:05:09.500');
  });

  it('formats a negative timezone offset', () => {
    const properties: Properties = {
      updated: {
        year: 2026,
        month: 6,
        day: 1,
        hour: 8,
        minute: 0,
        second: 0,
        timeZoneOffsetSeconds: -19800,
      },
    };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe('2026-06-01T08:00:00-05:30');
  });

  it('serializes a numeric epoch-millis timestamp value as an ISO string', () => {
    const properties: Properties = { updated: 1767225600000 };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe(new Date(1767225600000).toISOString());
  });

  it('falls back to JSON serialization for a non-temporal object timestamp value', () => {
    const properties: Properties = { updated: { months: 1, days: 2, seconds: 3, nanoseconds: 0 } };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe(JSON.stringify({ months: 1, days: 2, seconds: 3, nanoseconds: 0 }));
  });

  it('handles a negative (proleptic) year without producing a malformed date', () => {
    const properties: Properties = { updated: { year: -5, month: 3, day: 1 } };
    const resolved = propertyFallbackFieldResolver.resolve(['Event'], properties, fields());

    expect(resolved.timestamp).toBe('-0005-03-01');
  });

  it('leaves a null-typed fallback candidate skipped and falls through to the next', () => {
    const properties: Properties = { updated: null, lastUpdated: '2026-03-03T00:00:00.000Z' };
    const resolved = propertyFallbackFieldResolver.resolve(['Person'], properties, fields());

    expect(resolved.timestamp).toBe('2026-03-03T00:00:00.000Z');
    expect(resolved.consumedProperties.has('updated')).toBe(false);
    expect(resolved.consumedProperties.has('lastUpdated')).toBe(true);
  });
});
