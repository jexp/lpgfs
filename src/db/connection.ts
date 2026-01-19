/**
 * Neo4j Database Connection
 *
 * Manages Neo4j database connections with connection pooling and retry logic.
 */

import neo4j, {
  Driver,
  Session,
  Record as Neo4jRecord,
  Neo4jError,
  isRetriableError,
} from 'neo4j-driver';
import { LpgfsError, POSIX_ERRORS, type Properties } from '../types/index.js';

/**
 * Connection options for the database.
 */
export interface ConnectionOptions {
  /** Database connection URI (e.g., neo4j://localhost:7687) */
  uri: string;
  /** Database username */
  username?: string;
  /** Database password */
  password?: string;
  /** Maximum number of retry attempts on failure */
  maxRetries?: number;
  /** Delay between retry attempts in milliseconds */
  retryDelayMs?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Default connection options.
 */
const DEFAULT_OPTIONS: Required<Omit<ConnectionOptions, 'uri' | 'username' | 'password'>> = {
  maxRetries: 3,
  retryDelayMs: 1000,
  connectionTimeoutMs: 30000,
  debug: false,
};

/**
 * Query result type for executeQuery.
 */
export interface QueryResult<T = Properties> {
  records: T[];
  summary: {
    counters: {
      nodesCreated: number;
      nodesDeleted: number;
      relationshipsCreated: number;
      relationshipsDeleted: number;
    };
  };
}

/**
 * Manages Neo4j database connections with connection pooling and retry logic.
 *
 * The neo4j-driver handles connection pooling internally, so this class
 * focuses on providing a clean interface with retry logic.
 */
export class DatabaseConnection {
  private driver: Driver | null = null;
  private options: Required<Omit<ConnectionOptions, 'username' | 'password'>> & {
    username?: string;
    password?: string;
  };
  private connected = false;

  constructor(options: ConnectionOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /**
   * Initialize the database connection.
   * Creates the driver instance but does not verify connectivity.
   */
  async connect(): Promise<void> {
    if (this.driver) {
      return;
    }

    const { uri, username, password, connectionTimeoutMs, debug } = this.options;

    // Create auth token if credentials provided
    const authToken =
      username && password ? neo4j.auth.basic(username, password) : undefined;

    // Configure driver options
    const config = {
      connectionTimeout: connectionTimeoutMs,
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: connectionTimeoutMs,
      ...(debug && { logging: neo4j.logging.console('debug') }),
    };

    try {
      this.driver = neo4j.driver(uri, authToken, config);

      // Verify connectivity with retry
      await this.verifyConnectivity();
      this.connected = true;

      if (debug) {
        console.log(`[lpgfs] Connected to Neo4j at ${uri}`);
      }
    } catch (error) {
      // Clean up on failure
      if (this.driver) {
        await this.driver.close();
        this.driver = null;
      }
      throw error;
    }
  }

  /**
   * Verify database connectivity with retry logic.
   */
  private async verifyConnectivity(): Promise<void> {
    const { maxRetries, retryDelayMs, debug } = this.options;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!this.driver) {
          throw new Error('Driver not initialized');
        }

        await this.driver.verifyConnectivity();
        return;
      } catch (error) {
        lastError = error as Error;

        if (debug) {
          console.log(
            `[lpgfs] Connection attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
          );
        }

        // Check if error is retriable
        if (error instanceof Neo4jError && !isRetriableError(error)) {
          // Non-retriable error, throw immediately
          throw this.wrapError(error);
        }

        if (attempt < maxRetries) {
          // Wait before retry
          await this.sleep(retryDelayMs * attempt);
        }
      }
    }

    // All retries exhausted
    throw this.wrapError(lastError!);
  }

  /**
   * Execute a Cypher query with retry logic.
   *
   * @param cypher The Cypher query string
   * @param params Query parameters
   * @returns Query result with records
   */
  async executeQuery<T = Properties>(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<QueryResult<T>> {
    if (!this.driver || !this.connected) {
      throw new LpgfsError('Database not connected', POSIX_ERRORS.EIO);
    }

    const { maxRetries, retryDelayMs, debug } = this.options;

    let lastError: Error | null = null;
    let session: Session | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        session = this.driver.session({ defaultAccessMode: neo4j.session.READ });

        const result = await session.run(cypher, params);

        // Transform records to plain objects
        const records = result.records.map((record: Neo4jRecord) => {
          const obj: Record<string, unknown> = {};
          record.keys.forEach((key) => {
            if (typeof key === 'string') {
              obj[key] = this.transformValue(record.get(key));
            }
          });
          return obj as T;
        });

        return {
          records,
          summary: {
            counters: {
              nodesCreated: result.summary.counters.updates().nodesCreated,
              nodesDeleted: result.summary.counters.updates().nodesDeleted,
              relationshipsCreated: result.summary.counters.updates().relationshipsCreated,
              relationshipsDeleted: result.summary.counters.updates().relationshipsDeleted,
            },
          },
        };
      } catch (error) {
        lastError = error as Error;

        if (debug) {
          console.log(
            `[lpgfs] Query attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
          );
        }

        // Check if error is retriable
        if (error instanceof Neo4jError && !isRetriableError(error)) {
          throw this.wrapError(error);
        }

        if (attempt < maxRetries) {
          await this.sleep(retryDelayMs * attempt);
        }
      } finally {
        if (session) {
          await session.close();
          session = null;
        }
      }
    }

    throw this.wrapError(lastError!);
  }

  /**
   * Transform Neo4j values to plain JavaScript values.
   */
  private transformValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle Neo4j Integer
    if (neo4j.isInt(value)) {
      return neo4j.integer.toNumber(value);
    }

    // Handle Neo4j Node
    if (neo4j.graph.isNode(value)) {
      const node = value as neo4j.Node;
      return {
        elementId: node.elementId,
        labels: node.labels,
        properties: this.transformValue(node.properties),
      };
    }

    // Handle Neo4j Relationship
    if (neo4j.graph.isRelationship(value)) {
      const rel = value as neo4j.Relationship;
      return {
        elementId: rel.elementId,
        type: rel.type,
        startNodeElementId: rel.startNodeElementId,
        endNodeElementId: rel.endNodeElementId,
        properties: this.transformValue(rel.properties),
      };
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((v) => this.transformValue(v));
    }

    // Handle plain objects (properties)
    // Neo4j returns properties as plain objects, but nested values may need transformation
    if (typeof value === 'object' && value !== null) {
      const obj: Record<string, unknown> = {};

      // Iterate over all own enumerable properties
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          obj[key] = this.transformValue((value as Record<string, unknown>)[key]);
        }
      }

      return obj;
    }

    return value;
  }

  /**
   * Wrap an error as an LpgfsError with appropriate POSIX code.
   */
  private wrapError(error: Error): LpgfsError {
    if (error instanceof LpgfsError) {
      return error;
    }

    // Map Neo4j errors to POSIX codes
    if (error instanceof Neo4jError) {
      // Connection errors map to ENOENT (unreachable)
      if (
        error.code === 'ServiceUnavailable' ||
        error.code === 'SessionExpired' ||
        error.message.includes('connection')
      ) {
        return new LpgfsError(
          `Database unreachable: ${error.message}`,
          POSIX_ERRORS.ENOENT
        );
      }
    }

    // Default to EIO for other database errors
    return new LpgfsError(`Database error: ${error.message}`, POSIX_ERRORS.EIO);
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if the connection is established.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.connected = false;

      if (this.options.debug) {
        console.log('[lpgfs] Disconnected from Neo4j');
      }
    }
  }
}

/**
 * Create a new database connection.
 *
 * @param options Connection options
 * @returns DatabaseConnection instance (not yet connected)
 */
export function createConnection(options: ConnectionOptions): DatabaseConnection {
  return new DatabaseConnection(options);
}

/**
 * Create and connect to the database.
 *
 * @param options Connection options
 * @returns Connected DatabaseConnection instance
 */
export async function connect(options: ConnectionOptions): Promise<DatabaseConnection> {
  const connection = new DatabaseConnection(options);
  await connection.connect();
  return connection;
}
