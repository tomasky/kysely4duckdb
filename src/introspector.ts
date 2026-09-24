import { sql } from "kysely";
import type {
  DatabaseIntrospector,
  DatabaseMetadataOptions,
  Kysely,
  SchemaMetadata,
  TableMetadata,
} from "kysely";
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from "kysely/migration";

export class DuckDbIntrospector implements DatabaseIntrospector {
  readonly #db: Kysely<any>;

  constructor(db: Kysely<any>) {
    this.#db = db;
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    let rawSchemas = await this.#db
      .selectFrom("information_schema.schemata")
      .select("schema_name")
      .$castTo<RawSchemaMetadata>()
      .execute();

    return rawSchemas.map((it) => ({ name: it.schema_name }));
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    let query = this.#db
      .selectFrom("information_schema.columns as columns")
      .innerJoin("information_schema.tables as tables", (b) =>
        b
          .onRef("columns.TABLE_CATALOG", "=", "tables.TABLE_CATALOG")
          .onRef("columns.TABLE_SCHEMA", "=", "tables.TABLE_SCHEMA")
          .onRef("columns.TABLE_NAME", "=", "tables.TABLE_NAME"))
      .select([
        "columns.COLUMN_NAME",
        "columns.COLUMN_DEFAULT",
        "columns.TABLE_NAME",
        "columns.TABLE_SCHEMA",
        "tables.TABLE_TYPE",
        "columns.IS_NULLABLE",
        "columns.DATA_TYPE",
      ])
      .where("columns.TABLE_SCHEMA", "=", sql`current_schema()`)
      .orderBy("columns.TABLE_NAME")
      .orderBy("columns.ORDINAL_POSITION")
      .$castTo<RawColumnMetadata>();

    if (!options.withInternalKyselyTables) {
      query = query
        .where("columns.TABLE_NAME", "!=", DEFAULT_MIGRATION_TABLE)
        .where("columns.TABLE_NAME", "!=", DEFAULT_MIGRATION_LOCK_TABLE);
    }

    const rawColumns = await query.execute();
    return this.#parseTableMetadata(rawColumns);
  }

  #parseTableMetadata(columns: RawColumnMetadata[]): TableMetadata[] {
    return columns.reduce<TableMetadata[]>((tables, it) => {
      let table = tables.find((tbl) => tbl.name === it.table_name);

      if (!table) {
        table = Object.freeze({
          name: it.table_name,
          isView: it.table_type === "view",
          // DuckDB has no foreign tables (no FDW), so this is always false.
          isForeign: false,
          schema: it.table_schema,
          columns: [],
        });

        tables.push(table);
      }

      table.columns.push(
        Object.freeze({
          name: it.column_name,
          dataType: it.data_type,
          isNullable: it.is_nullable === "YES",
          isAutoIncrementing: false,
          hasDefaultValue: it.column_default !== null,
        }),
      );

      return tables;
    }, []);
  }
}

interface RawSchemaMetadata {
  schema_name: string;
}

interface RawColumnMetadata {
  column_name: string;
  column_default: any;
  table_name: string;
  table_schema: string;
  table_type: string;
  is_nullable: "YES" | "NO";
  data_type: string;
}
