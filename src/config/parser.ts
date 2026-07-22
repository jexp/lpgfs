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
  ModeConfig,
  ModeType,
  MarkdownModeConfig,
  LinkStyle,
  TextPropertiesConfig,
  MarkdownFieldsConfig,
  LabelPropertyListOverrides,
  DEFAULT_CONFIG,
  DEFAULT_MARKDOWN_MODE_CONFIG,
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

    // Validate mode section
    if (raw.mode !== undefined) {
      config.mode = ConfigParser.validateMode(raw.mode);
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
   * Validate the mode configuration section.
   */
  private static validateMode(raw: unknown): ModeConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('mode must be an object');
    }

    const rawMode = raw as Record<string, unknown>;
    const mode: ModeConfig = { type: 'classic' };

    if (rawMode.type !== undefined) {
      if (!ConfigParser.isModeType(rawMode.type)) {
        throw new ConfigValidationError(
          `mode.type must be 'classic' or 'markdown', got: ${rawMode.type}`
        );
      }
      mode.type = rawMode.type;
    }

    if (rawMode.markdown !== undefined) {
      mode.markdown = ConfigParser.validateMarkdownMode(rawMode.markdown);
    } else if (mode.type === 'markdown') {
      mode.markdown = structuredClone(DEFAULT_MARKDOWN_MODE_CONFIG);
    }

    return mode;
  }

  /**
   * Validate the mode.markdown configuration section.
   */
  private static validateMarkdownMode(raw: unknown): MarkdownModeConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('mode.markdown must be an object');
    }

    const rawMarkdown = raw as Record<string, unknown>;
    const markdown: MarkdownModeConfig = structuredClone(
      DEFAULT_MARKDOWN_MODE_CONFIG
    );

    if (rawMarkdown.labels !== undefined) {
      markdown.labels = ConfigParser.validateStringArray(
        rawMarkdown.labels,
        'mode.markdown.labels'
      );
    }

    if (rawMarkdown.linkStyle !== undefined) {
      if (!ConfigParser.isLinkStyle(rawMarkdown.linkStyle)) {
        throw new ConfigValidationError(
          `mode.markdown.linkStyle must be 'wikilink' or 'markdown', got: ${rawMarkdown.linkStyle}`
        );
      }
      markdown.linkStyle = rawMarkdown.linkStyle;
    }

    if (rawMarkdown.includeIncoming !== undefined) {
      if (typeof rawMarkdown.includeIncoming !== 'boolean') {
        throw new ConfigValidationError(
          'mode.markdown.includeIncoming must be a boolean'
        );
      }
      markdown.includeIncoming = rawMarkdown.includeIncoming;
    }

    if (rawMarkdown.textProperties !== undefined) {
      markdown.textProperties = ConfigParser.validateTextProperties(
        rawMarkdown.textProperties
      );
    }

    if (rawMarkdown.fields !== undefined) {
      markdown.fields = ConfigParser.validateMarkdownFields(
        rawMarkdown.fields
      );
    }

    return markdown;
  }

  /**
   * Validate the mode.markdown.textProperties configuration section.
   */
  private static validateTextProperties(raw: unknown): TextPropertiesConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError(
        'mode.markdown.textProperties must be an object'
      );
    }

    const rawTextProperties = raw as Record<string, unknown>;
    const textProperties: TextPropertiesConfig = {
      default: [...DEFAULT_MARKDOWN_MODE_CONFIG.textProperties.default],
    };

    if (rawTextProperties.default !== undefined) {
      textProperties.default = ConfigParser.validateStringArray(
        rawTextProperties.default,
        'mode.markdown.textProperties.default'
      );
    }

    if (rawTextProperties.overrides !== undefined) {
      textProperties.overrides = ConfigParser.validateLabelPropertyListOverrides(
        rawTextProperties.overrides,
        'mode.markdown.textProperties.overrides'
      );
    }

    return textProperties;
  }

  /**
   * Validate the mode.markdown.fields configuration section.
   */
  private static validateMarkdownFields(raw: unknown): MarkdownFieldsConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError('mode.markdown.fields must be an object');
    }

    const rawFields = raw as Record<string, unknown>;
    const fields: MarkdownFieldsConfig = {
      title: [...DEFAULT_MARKDOWN_MODE_CONFIG.fields.title],
      timestamp: [...DEFAULT_MARKDOWN_MODE_CONFIG.fields.timestamp],
      tags: [...DEFAULT_MARKDOWN_MODE_CONFIG.fields.tags],
    };

    for (const field of ['title', 'timestamp', 'tags'] as const) {
      if (rawFields[field] !== undefined) {
        fields[field] = ConfigParser.validateStringArray(
          rawFields[field],
          `mode.markdown.fields.${field}`
        );
      }
    }

    if (rawFields.overrides !== undefined) {
      if (
        typeof rawFields.overrides !== 'object' ||
        rawFields.overrides === null ||
        Array.isArray(rawFields.overrides)
      ) {
        throw new ConfigValidationError(
          'mode.markdown.fields.overrides must be an object'
        );
      }

      const rawOverrides = rawFields.overrides as Record<string, unknown>;
      fields.overrides = {};

      for (const field of ['title', 'timestamp', 'tags'] as const) {
        if (rawOverrides[field] !== undefined) {
          fields.overrides[field] =
            ConfigParser.validateLabelPropertyListOverrides(
              rawOverrides[field],
              `mode.markdown.fields.overrides.${field}`
            );
        }
      }
    }

    return fields;
  }

  /**
   * Validate a per-label property list override map, e.g.
   * `{ Character: ['description', 'story'] }`.
   */
  private static validateLabelPropertyListOverrides(
    raw: unknown,
    path: string
  ): LabelPropertyListOverrides {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigValidationError(`${path} must be an object`);
    }

    const rawOverrides = raw as Record<string, unknown>;
    const overrides: LabelPropertyListOverrides = {};

    for (const [label, value] of Object.entries(rawOverrides)) {
      overrides[label] = ConfigParser.validateStringArray(
        value,
        `${path}.${label}`
      );
    }

    return overrides;
  }

  /**
   * Validate that a value is an array of strings.
   */
  private static validateStringArray(raw: unknown, path: string): string[] {
    if (!Array.isArray(raw)) {
      throw new ConfigValidationError(`${path} must be an array of strings`);
    }

    for (const entry of raw) {
      if (typeof entry !== 'string') {
        throw new ConfigValidationError(`${path} must be an array of strings`);
      }
    }

    return raw as string[];
  }

  /**
   * Type guard for NamingStrategy.
   */
  private static isNamingStrategy(value: unknown): value is NamingStrategy {
    return value === 'elementId' || value === 'property';
  }

  /**
   * Type guard for ModeType.
   */
  private static isModeType(value: unknown): value is ModeType {
    return value === 'classic' || value === 'markdown';
  }

  /**
   * Type guard for LinkStyle.
   */
  private static isLinkStyle(value: unknown): value is LinkStyle {
    return value === 'wikilink' || value === 'markdown';
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
