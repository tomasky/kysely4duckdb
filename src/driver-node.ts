import {
  DuckDBBitValue,
  DuckDBBlobValue,
  DuckDBConnection as NodeDuckDBConnection,
  DuckDBDateValue,
  DuckDBInstance,
  DuckDBIntervalValue,
  DuckDBListValue,
  DuckDBMapValue,
  DuckDBStructValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
} from "@duckdb/node-api";
import { CompiledQuery } from "kysely";
import type { DatabaseConnection, Driver, QueryResult } from "kysely";

import { isRowsReturningStatement } from "./helper/sql-statement";

export interface DuckDbNodeDriverConfig {
  /**
   * DuckDBInstance instance or a function returns a Promise of DuckDBInstance instance.
   */
  database: (() => Promise<DuckDBInstance>) | DuckDBInstance;
  /**
   * called when a connection is created.
   * @param conection DuckDBConnection instance that is created.
   * @returns Promise<void>
   */
  onCreateConnection?: (conection: NodeDuckDBConnection) => Promise<void>;
}

export class DuckDbNodeDriver implements Driver {
  readonly #config: DuckDbNodeDriverConfig;
  #db?: DuckDBInstance;

  constructor(config: DuckDbNodeDriverConfig) {
    this.#config = Object.freeze({ ...config });
  }

  async init(): Promise<void> {
    this.#db = (typeof this.#config.database === "function")
      ? await this.#config.database()
      : this.#config.database;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const conn = await this.#db!.connect();
    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(conn);
    }
    return new DuckDBConnection(conn);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN TRANSACTION"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    await (connection as DuckDBConnection).disconnect();
  }

  async destroy(): Promise<void> {
    this.#db?.closeSync();
  }
}

class DuckDBConnection implements DatabaseConnection {
  readonly #conn: NodeDuckDBConnection;

  constructor(conn: NodeDuckDBConnection) {
    this.#conn = conn;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const { sql, parameters } = compiledQuery;
    const result = await this.#conn.run(sql, parameters as any);
    const rows = (await result.getRowObjects()).map((r) => this.#convertRow(r));
    return this.formatToResult<O>(rows, this.isMutationQuery(compiledQuery, rows));
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const result = await this.#conn.stream(sql, parameters as any);
    const columnNames = result.deduplicatedColumnNames();

    while (true) {
      const chunk = await result.fetchChunk();
      if (chunk == null || chunk.rowCount === 0) {
        break;
      }

      const rows = chunk.getRowObjects(columnNames).map((r) => this.#convertRow(r));
      yield this.formatToResult<R>(rows, this.isMutationQuery(compiledQuery, rows));
    }
  }

  /**
   * DuckDB reports affected rows for DML as a single generated `Count` column,
   * which by shape alone is indistinguishable from `SELECT count(*) AS count`.
   * Prefer Kysely's parsed node kind and fall back to the result shape only for
   * raw SQL, where the node kind carries no information.
   */
  private isMutationQuery(compiledQuery: CompiledQuery, result: Record<string, unknown>[]): boolean {
    switch (compiledQuery.query.kind) {
      case "InsertQueryNode":
      case "UpdateQueryNode":
      case "DeleteQueryNode":
      case "MergeQueryNode":
        return true;
      case "SelectQueryNode":
        return false;
      default:
        return this.isMutationResult(compiledQuery.sql, result);
    }
  }

  private isMutationResult(sql: string, result: Record<string, unknown>[]): boolean {
    if (isRowsReturningStatement(sql)) {
      return false;
    }

    // Raw DML returns a single `Count` column holding the affected row count.
    if (result.length !== 1) {
      return false;
    }
    const keys = Object.keys(result[0]);
    return keys.length === 1 && keys[0].toLowerCase() === "count";
  }

  private formatToResult<O>(result: Record<string, unknown>[], isMutation: boolean): QueryResult<O> {
    if (!isMutation) {
      return { rows: result as O[] };
    }

    const row = result[0];
    const count = row == null ? undefined : (row as any)["Count"] ?? (row as any)["count"];
    const numAffectedRows = count == null ? undefined : BigInt(count);

    return {
      numChangedRows: numAffectedRows,
      numAffectedRows,
      insertId: undefined,
      rows: [],
    };
  }

  async disconnect(): Promise<void> {
    this.#conn.closeSync();
  }

  #convertRow(row: Record<string, unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      obj[k] = this.#convertValue(v as any);
    }
    return obj;
  }

  #convertValue(value: any): any {
    if (value == null) return value;
    if (value instanceof DuckDBBitValue) return value.toString();
    if (value instanceof DuckDBBlobValue) return Buffer.from(value.bytes);
    if (value instanceof DuckDBDateValue) {
      // DuckDB DATE represents a calendar date without time zone.
      // Use DuckDB's built-in decomposition to avoid string parsing.
      const { year, month, day } = value.toParts();
      return new Date(year, month - 1, day);
    }
    if (value instanceof DuckDBTimestampValue) {
      // DuckDB TIMESTAMP is timezone-naive. Use built-in parts and interpret as local time.
      const { date, time } = value.toParts();
      return new Date(
        date.year,
        date.month - 1,
        date.day,
        time.hour,
        time.min,
        time.sec,
        Math.floor(time.micros / 1000),
      );
    }
    if (value instanceof DuckDBTimestampTZValue) {
      // DuckDB TIMESTAMPTZ has an associated time zone. The driver returns ISO
      // strings with an offset; 'new Date(isoWithOffset)' yields the absolute
      // UTC moment, which is the desired behavior for JS Date.
      return new Date(value.toString());
    }
    if (value instanceof DuckDBIntervalValue) {
      return { months: value.months, days: value.days, micros: Number(value.micros) };
    }
    if (value instanceof DuckDBListValue) {
      return value.items.map((v) => this.#convertValue(v));
    }
    if (value instanceof DuckDBStructValue) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.entries)) {
        obj[k] = this.#convertValue(v);
      }
      return obj;
    }
    if (value instanceof DuckDBMapValue) {
      const entries = value.entries
        .map((e) => `${this.#convertValue(e.key)}=${this.#convertValue(e.value)}`)
        .join(", ");
      return `{${entries}}`;
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.#convertValue(v));
    }
    return value;
  }
}
