/**
 * Configuration Parser
 *
 * Parses and validates .lpgfs.yaml configuration files.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  ConfigSchema,
  NamingConfig,
  NamingStrategy,
  SanitizationConfig,
  CollisionConfig,
  CollisionStrategy,
  DEFAULT_CONFIG,
  LpgfsError,
  POSIX_ERRORS,
} from '../types/index.js';

/**
 * Error thrown when configuration is invalid.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * ConfigParser handles loading and validating .lpgfs.yaml files.
 */
export class ConfigParser {
  /**
   * Load and parse a configuration file.
   *
   * @param filePath - Path to the .lpgfs.yaml file
   * @returns Parsed and validated ConfigSchema
   * @throws ConfigValidationError if the config is invalid
   * @throws LpgfsError with ENOENT if file doesn't exist
   */
  static async load(filePath: string): Promise<ConfigSchema> {
    if (!existsSync(filePath)) {
      throw new LpgfsError(
        `Config file not found: ${filePath}`,
        POSIX_ERRORS.ENOENT
      );
    }

    const content = await readFile(filePath, 'utf-8');
    return ConfigParser.parse(content);
  }

  /**
   * Load a configuration file, returning defaults if file doesn't exist.
   *
   * @param filePath - Path to the .lpgfs.yaml file
   * @returns Parsed config or defaults if file not found
   */
  static async loadOrDefault(filePath: string): Promise<ConfigSchema> {
    if (!existsSync(filePath)) {
      return structuredClone(DEFAULT_CONFIG);
    }

    const content = await readFile(filePath, 'utf-8');
    return ConfigParser.parse(content);
  }

  /**
   * Parse YAML content into a ConfigSchema.
   *
   * @param content - YAML string content
   * @returns Parsed and validated ConfigSchema
   * @throws ConfigValidationError if the config is invalid
   */
  static parse(content: string): ConfigSchema {
    let raw: unknown;

    try {
      raw = parseYaml(content);
    } catch (err) {
      throw new ConfigValidationError(
        `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Handle empty file
    if (raw === null || raw === undefined) {
      return structuredClone(DEFAULT_CONFIG);
    }

    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigValidationError(
        'Config must be an object, not an array or primitive'
      );
    }

    const rawConfig = raw as Record<string, unknown>;
    return ConfigParser.validate(rawConfig);
  }

  /**
   * Validate and merge raw config with defaults.
   *
   * @param raw - Raw parsed YAML object
   * @returns Validated ConfigSchema with defaults applied
   */
  private static validate(raw: Record<string, unknown>): ConfigSchema {
    const config: ConfigSchema = structuredClone(DEFAULT_CONFIG);

    // Validate naming section
    if (raw.naming !== undefined) {
      config.naming = ConfigParser.validateNaming(raw.naming);
    }

    // Validate sanitization section
    if (raw.sanitization !== undefined) {
      config.sanitization = ConfigParser.validateSanitization(raw.sanitization);
    }

    // Validate collision section
    if (raw.collision !== undefined) {
      config.collision = ConfigParser.validateCollision(raw.collision);
    }

    return config;
  }

  /**
   * Validate the naming configuration section.
   */
  private static validateNaming(raw: unknown): NamingConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('naming must be an object');
    }

    const rawNaming = raw as Record<string, unknown>;
    const naming: NamingConfig = { default: 'elementId' };

    // Validate default strategy
    if (rawNaming.default !== undefined) {
      if (!ConfigParser.isNamingStrategy(rawNaming.default)) {
        throw new ConfigValidationError(
          `naming.default must be 'elementId' or 'property', got: ${rawNaming.default}`
        );
      }
      naming.default = rawNaming.default;
    }

    // Validate overrides
    if (rawNaming.overrides !== undefined) {
      if (
        typeof rawNaming.overrides !== 'object' ||
        rawNaming.overrides === null ||
        Array.isArray(rawNaming.overrides)
      ) {
        throw new ConfigValidationError('naming.overrides must be an object');
      }

      const rawOverrides = rawNaming.overrides as Record<string, unknown>;
      naming.overrides = {};

      // Validate node overrides
      if (rawOverrides.nodes !== undefined) {
        if (
          typeof rawOverrides.nodes !== 'object' ||
          rawOverrides.nodes === null ||
          Array.isArray(rawOverrides.nodes)
        ) {
          throw new ConfigValidationError(
            'naming.overrides.nodes must be an object'
          );
        }

        naming.overrides.nodes = {};
        const rawNodes = rawOverrides.nodes as Record<string, unknown>;

        for (const [label, override] of Object.entries(rawNodes)) {
          if (
            typeof override !== 'object' ||
            override === null ||
            Array.isArray(override)
          ) {
            throw new ConfigValidationError(
              `naming.overrides.nodes.${label} must be an object`
            );
          }

          const rawOverride = override as Record<string, unknown>;

          if (typeof rawOverride.property !== 'string') {
            throw new ConfigValidationError(
              `naming.overrides.nodes.${label}.property must be a string`
            );
          }

          naming.overrides.nodes[label] = {
            property: rawOverride.property,
          };
        }
      }

      // Validate relationship overrides
      if (rawOverrides.relationships !== undefined) {
        if (
          typeof rawOverrides.relationships !== 'object' ||
          rawOverrides.relationships === null ||
          Array.isArray(rawOverrides.relationships)
        ) {
          throw new ConfigValidationError(
            'naming.overrides.relationships must be an object'
          );
        }

        naming.overrides.relationships = {};
        const rawRels = rawOverrides.relationships as Record<string, unknown>;

        for (const [relType, strategy] of Object.entries(rawRels)) {
          if (!ConfigParser.isNamingStrategy(strategy)) {
            throw new ConfigValidationError(
              `naming.overrides.relationships.${relType} must be 'elementId' or 'property', got: ${strategy}`
            );
          }
          naming.overrides.relationships[relType] = strategy;
        }
      }
    }

    return naming;
  }

  /**
   * Validate the sanitization configuration section.
   */
  private static validateSanitization(raw: unknown): SanitizationConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('sanitization must be an object');
    }

    const rawSanitization = raw as Record<string, unknown>;

    // Start with defaults and merge user config
    const sanitization: SanitizationConfig = {
      replace: { ...DEFAULT_CONFIG.sanitization!.replace },
    };

    if (rawSanitization.replace !== undefined) {
      if (
        typeof rawSanitization.replace !== 'object' ||
        rawSanitization.replace === null ||
        Array.isArray(rawSanitization.replace)
      ) {
        throw new ConfigValidationError('sanitization.replace must be an object');
      }

      const rawReplace = rawSanitization.replace as Record<string, unknown>;

      for (const [char, replacement] of Object.entries(rawReplace)) {
        if (typeof replacement !== 'string') {
          throw new ConfigValidationError(
            `sanitization.replace["${char}"] must be a string, got: ${typeof replacement}`
          );
        }
        sanitization.replace[char] = replacement;
      }
    }

    return sanitization;
  }

  /**
   * Validate the collision configuration section.
   */
  private static validateCollision(raw: unknown): CollisionConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('collision must be an object');
    }

    const rawCollision = raw as Record<string, unknown>;
    const collision: CollisionConfig = { strategy: 'suffix_elementId' };

    if (rawCollision.strategy !== undefined) {
      if (!ConfigParser.isCollisionStrategy(rawCollision.strategy)) {
        throw new ConfigValidationError(
          `collision.strategy must be 'suffix_elementId' or 'fail', got: ${rawCollision.strategy}`
        );
      }
      collision.strategy = rawCollision.strategy;
    }

    return collision;
  }

  /**
   * Type guard for NamingStrategy.
   */
  private static isNamingStrategy(value: unknown): value is NamingStrategy {
    return value === 'elementId' || value === 'property';
  }

  /**
   * Type guard for CollisionStrategy.
   */
  private static isCollisionStrategy(
    value: unknown
  ): value is CollisionStrategy {
    return value === 'suffix_elementId' || value === 'fail';
  }

  /**
   * Serialize a ConfigSchema back to YAML string.
   *
   * @param config - Configuration to serialize
   * @returns YAML string representation
   */
  static toYaml(config: ConfigSchema): string {
    return stringifyYaml(config);
  }
}
