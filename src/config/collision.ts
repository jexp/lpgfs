/**
 * Collision Handling
 *
 * Handles filename collisions when multiple nodes/relationships
 * produce the same display name.
 * Follows PRD section 5.3 (Collision Handling).
 */

import {
  CollisionConfig,
  CollisionStrategy,
  DEFAULT_CONFIG,
} from '../types/index.js';
import { sanitizeElementId } from './sanitize.js';

/**
 * Error thrown when collision strategy is 'fail' and a collision occurs.
 */
export class CollisionError extends Error {
  /** The conflicting name */
  public readonly conflictingName: string;

  /** The context where collision occurred */
  public readonly context: string;

  /** The elementId that caused the collision */
  public readonly elementId: string;

  constructor(conflictingName: string, context: string, elementId: string) {
    super(
      `Name collision: "${conflictingName}" already exists in ${context}. ` +
        `Duplicate elementId: ${elementId}. ` +
        `Configure collision.strategy: 'suffix_elementId' to auto-resolve, ` +
        `or use a unique property for naming.`
    );
    this.name = 'CollisionError';
    this.conflictingName = conflictingName;
    this.context = context;
    this.elementId = elementId;
  }
}

/**
 * Tracks used names and resolves collisions for a specific context
 * (e.g., a label directory or relationship type directory).
 */
export class CollisionResolver {
  /** Map of base name to count of uses */
  private readonly usedNames: Map<string, number> = new Map();

  /** Map of elementId to assigned name (for reverse lookup) */
  private readonly elementIdToName: Map<string, string> = new Map();

  /** Collision handling configuration */
  private readonly config: CollisionConfig;

  /** Context name for error messages (e.g., "Person", "KNOWS/OUT") */
  private readonly context: string;

  /**
   * Create a new collision resolver for a specific context.
   *
   * @param context - Context name for error messages
   * @param config - Collision configuration (uses defaults if not provided)
   */
  constructor(context: string, config?: CollisionConfig) {
    this.context = context;
    this.config = config ?? DEFAULT_CONFIG.collision!;
  }

  /**
   * Resolve a name, handling collisions according to the configured strategy.
   *
   * @param baseName - The base name before collision resolution
   * @param elementId - The database elementId (used for suffix strategy)
   * @returns The resolved unique name
   * @throws CollisionError if strategy is 'fail' and name is already used
   *
   * @example
   * const resolver = new CollisionResolver('Person');
   * resolver.resolve('alice', '4:abc:0'); // 'alice'
   * resolver.resolve('alice', '4:abc:1'); // 'alice_4_abc_1' (with suffix_elementId)
   */
  resolve(baseName: string, elementId: string): string {
    // Check if this elementId was already resolved
    const existingName = this.elementIdToName.get(elementId);
    if (existingName !== undefined) {
      return existingName;
    }

    // Check if name is already used
    const useCount = this.usedNames.get(baseName) ?? 0;

    if (useCount === 0) {
      // First use - no collision
      this.usedNames.set(baseName, 1);
      this.elementIdToName.set(elementId, baseName);
      return baseName;
    }

    // Collision detected - apply strategy
    return this.handleCollision(baseName, elementId, useCount);
  }

  /**
   * Handle a collision using the configured strategy.
   */
  private handleCollision(
    baseName: string,
    elementId: string,
    useCount: number
  ): string {
    switch (this.config.strategy) {
      case 'suffix_elementId':
        return this.applySuffixStrategy(baseName, elementId, useCount);

      case 'fail':
        throw new CollisionError(baseName, this.context, elementId);

      default:
        // Exhaustive check - TypeScript will error if new strategies are added
        const _exhaustive: never = this.config.strategy;
        throw new Error(`Unknown collision strategy: ${_exhaustive}`);
    }
  }

  /**
   * Apply the suffix_elementId collision strategy.
   * Appends _<sanitizedElementId> to create a unique name.
   */
  private applySuffixStrategy(
    baseName: string,
    elementId: string,
    _useCount: number
  ): string {
    const sanitizedId = sanitizeElementId(elementId);
    const resolvedName = `${baseName}_${sanitizedId}`;

    // Update tracking
    this.usedNames.set(baseName, (this.usedNames.get(baseName) ?? 0) + 1);
    this.elementIdToName.set(elementId, resolvedName);

    return resolvedName;
  }

  /**
   * Get the resolved name for an elementId.
   *
   * @param elementId - The database elementId
   * @returns The resolved name, or undefined if not resolved
   */
  getName(elementId: string): string | undefined {
    return this.elementIdToName.get(elementId);
  }

  /**
   * Check if a name has been used.
   *
   * @param name - The name to check
   * @returns True if the name has been used
   */
  hasName(name: string): boolean {
    return this.usedNames.has(name);
  }

  /**
   * Reset the resolver, clearing all tracked names.
   */
  clear(): void {
    this.usedNames.clear();
    this.elementIdToName.clear();
  }
}

/**
 * Convenience function to resolve names for a batch of items.
 * Creates a resolver, processes all items, and returns the resolved names.
 *
 * @param items - Array of items with baseName and elementId
 * @param context - Context name for error messages
 * @param config - Collision configuration (uses defaults if not provided)
 * @returns Array of resolved names in the same order as input
 *
 * @example
 * const names = resolveCollisions([
 *   { baseName: 'alice', elementId: '4:abc:0' },
 *   { baseName: 'alice', elementId: '4:abc:1' },
 *   { baseName: 'bob', elementId: '4:abc:2' },
 * ], 'Person');
 * // ['alice', 'alice_4_abc_1', 'bob']
 */
export function resolveCollisions(
  items: Array<{ baseName: string; elementId: string }>,
  context: string,
  config?: CollisionConfig
): string[] {
  const resolver = new CollisionResolver(context, config);
  return items.map((item) => resolver.resolve(item.baseName, item.elementId));
}

/**
 * Create a collision resolver for a specific context.
 * Useful when you need to resolve names incrementally.
 *
 * @param context - Context name for error messages
 * @param config - Collision configuration
 * @returns A new CollisionResolver instance
 */
export function createCollisionResolver(
  context: string,
  config?: CollisionConfig
): CollisionResolver {
  return new CollisionResolver(context, config);
}
