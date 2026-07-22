/**
 * In-Memory Cache with TTL
 *
 * Caching layer to reduce database queries using lru-cache.
 */

import { LRUCache } from 'lru-cache';
import {
  type CacheKeyPrefix,
  type CacheTTLConfig,
  DEFAULT_CACHE_TTL,
} from '../types/index.js';

/**
 * Cache options.
 */
export interface CacheOptions {
  /** Maximum number of entries in the cache */
  maxSize?: number;
  /** TTL configuration in seconds */
  ttl?: Partial<CacheTTLConfig>;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Default cache options.
 */
const DEFAULT_OPTIONS: Required<Omit<CacheOptions, 'ttl'>> & {
  ttl: CacheTTLConfig;
} = {
  maxSize: 10000,
  ttl: DEFAULT_CACHE_TTL,
  debug: false,
};

/**
 * Cache key builder type for creating cache keys.
 */
export type CacheKeyBuilder = {
  /** Build a key for label list */
  labels: () => string;
  /** Build a key for nodes of a label */
  nodes: (label: string) => string;
  /** Build a key for node properties */
  props: (elementId: string) => string;
  /** Build a key for relationship types of a node */
  reltypes: (elementId: string) => string;
  /** Build a key for relationships of a node */
  rels: (elementId: string, relType: string, direction: string) => string;
  /** Build a key for the markdown-mode index projection of a label */
  markdownIndex: (label: string) => string;
  /** Build a key for a node's rendered markdown (markdown mode) */
  markdown: (elementId: string) => string;
  /** Build a key for the rendered virtual root /index.md content */
  markdownRootIndex: () => string;
  /** Build a key for a rendered virtual /<Label>/index.md content */
  markdownLabelIndex: (label: string) => string;
  /** Build a key for the generated root /log.md content (markdown mode) */
  markdownLog: () => string;
};

/**
 * Cache key builder utility.
 */
export const cacheKey: CacheKeyBuilder = {
  labels: () => 'labels',
  nodes: (label: string) => `nodes:${label}`,
  props: (elementId: string) => `props:${elementId}`,
  reltypes: (elementId: string) => `reltypes:${elementId}`,
  rels: (elementId: string, relType: string, direction: string) =>
    `rels:${elementId}:${relType}:${direction}`,
  // Prefixed with "nodes:" (not a new prefix) so it shares the label-listing
  // TTL bucket per REQ-F-063, without needing a CacheKeyPrefix change.
  markdownIndex: (label: string) => `nodes:mdindex:${label}`,
  markdown: (elementId: string) => `markdown:${elementId}`,
  // Rendered index.md content, distinct from markdownIndex's raw
  // title/timestamp/description projection above; still "nodes:"-prefixed
  // for the same label-listing TTL bucket per REQ-F-063.
  markdownRootIndex: () => 'nodes:mdindexpage:root',
  markdownLabelIndex: (label: string) => `nodes:mdindexpage:${label}`,
  // Same "nodes:" prefix as markdownIndex, for the same reason: /log.md is
  // built entirely from listNodesForMarkdownIndex's per-label projections,
  // so it shares their TTL bucket (REQ-F-063) rather than a new one.
  markdownLog: () => 'nodes:mdlog',
};

/**
 * Cache value type - wraps unknown values.
 * Using a wrapper type to satisfy lru-cache's constraint that V extends {}.
 */
type CacheValue = { data: unknown };

/**
 * In-memory cache with TTL support.
 *
 * Uses lru-cache for efficient caching with automatic TTL-based expiration.
 */
export class Cache {
  private cache: LRUCache<string, CacheValue>;
  private options: Required<Omit<CacheOptions, 'ttl'>> & { ttl: CacheTTLConfig };

  constructor(options: CacheOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      ttl: {
        ...DEFAULT_CACHE_TTL,
        ...options.ttl,
      },
    };

    this.cache = new LRUCache<string, CacheValue>({
      max: this.options.maxSize,
      // TTL is set per-entry in set() calls
      ttlAutopurge: true,
    });
  }

  /**
   * Get a value from the cache.
   *
   * @param key Cache key
   * @returns The cached value or undefined if not found/expired
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (this.options.debug) {
      if (entry !== undefined) {
        console.log(`[lpgfs:cache] HIT: ${key}`);
      } else {
        console.log(`[lpgfs:cache] MISS: ${key}`);
      }
    }

    return entry?.data as T | undefined;
  }

  /**
   * Set a value in the cache.
   *
   * @param key Cache key
   * @param value Value to cache
   * @param ttlSeconds TTL in seconds (optional, defaults based on key prefix)
   */
  set<T>(key: string, value: T, ttlSeconds?: number): void {
    const ttl = ttlSeconds ?? this.getTtlForKey(key);

    this.cache.set(key, { data: value }, { ttl: ttl * 1000 });

    if (this.options.debug) {
      console.log(`[lpgfs:cache] SET: ${key} (TTL: ${ttl}s)`);
    }
  }

  /**
   * Check if a key exists in the cache (and is not expired).
   *
   * @param key Cache key
   * @returns True if the key exists
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete a specific key from the cache.
   *
   * @param key Cache key
   * @returns True if the key was deleted
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);

    if (this.options.debug && deleted) {
      console.log(`[lpgfs:cache] DELETE: ${key}`);
    }

    return deleted;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();

    if (this.options.debug) {
      console.log('[lpgfs:cache] CLEAR: all entries removed');
    }
  }

  /**
   * Get the number of entries currently in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get the TTL configuration.
   */
  get ttlConfig(): CacheTTLConfig {
    return this.options.ttl;
  }

  /**
   * Determine the TTL for a key based on its prefix.
   */
  private getTtlForKey(key: string): number {
    const prefix = key.split(':')[0] as CacheKeyPrefix;

    switch (prefix) {
      case 'labels':
        return this.options.ttl.labels;
      case 'nodes':
        return this.options.ttl.nodes;
      case 'props':
        return this.options.ttl.properties;
      case 'reltypes':
        return this.options.ttl.relationships;
      case 'rels':
        return this.options.ttl.relationships;
      case 'markdown':
        return this.options.ttl.properties;
      default:
        // Default to properties TTL for unknown keys
        return this.options.ttl.properties;
    }
  }
}

/**
 * Create a new cache instance.
 *
 * @param options Cache options
 * @returns Cache instance
 */
export function createCache(options?: CacheOptions): Cache {
  return new Cache(options);
}
