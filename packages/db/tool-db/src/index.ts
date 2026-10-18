/**
 * Model-facing database query tools. Reads `DATABASE_URL` from the environment
 * and exposes `db_query`, `db_tables`, `db_schema` for the agent to inspect
 * and query a relational database.
 *
 * Supported drivers (auto-detected from URL scheme):
 * - `postgres://` / `postgresql://` → `postgres` (porsager/postgres)
 * - `mysql://` → `mysql2`
 * - `sqlite://` / `file:` → `better-sqlite3`
 * - `oracle://` → `oracledb`
 * - `mssql://` / `sqlserver://` → `mssql` (tedious)
 *
 * @module @deepseek-ai/dsh-tool-db
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const name = 'tool-db'
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** Block mutation statements at the tool level (default true). */
  readOnly?: boolean
  /** Per-query timeout in milliseconds (default 30 000). */
  queryTimeout?: number
  /** Maximum rows returned per query (default 1000). */
  maxRows?: number
}

export const Config: z<Config> = z.object({
  readOnly: z.boolean().default(true),
  queryTimeout: z.number().default(30_000),
  maxRows: z.number().default(1000),
})

/* ------------------------------------------------------------------ types */

type Driver = 'postgres' | 'sqlite' | 'mysql' | 'oracle' | 'mssql'

interface QueryResult {
  rows: Record<string, unknown>[]
  fields: { name: string; type: string }[]
}

type Executor = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  listTables: () => Promise<{ name: string; type: string }[]>
  describeTable: (table: string) => Promise<{
    name: string
    type: string
    nullable: boolean
    default: string | null
    pk: boolean
  }[]>
  close: () => Promise<void> | void
}

/* --------------------------------------------------------------- plugin */

export function apply(ctx: Context, config: Config): void {
  const readOnly = config.readOnly !== false
  const timeout = config.queryTimeout ?? 30_000
  const maxRows = config.maxRows ?? 1000
  const url = process.env.DATABASE_URL
  if (!url) {
    ctx.logger.warn('tool-db: DATABASE_URL is not set — database tools will not be available')
    return
  }

  const driver = parseDriver(url)
  if (!driver) {
    ctx.logger.warn('tool-db: unsupported DATABASE_URL scheme — database tools will not be available')
    return
  }

  const executor = createExecutor(driver, url)
  ctx.effect(() => () => { executor.close() })

  /* Destructive-SQL guard: always deny DROP/TRUNCATE via pre-execute waterfall. */
  const DESTRUCTIVE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i
  ctx.on('tools/pre-execute', (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (exec.name !== 'db_query') return next()
    const sql = typeof exec.arguments === 'object' && exec.arguments !== null
      ? (exec.arguments as Record<string, unknown>).sql : undefined
    if (typeof sql === 'string' && DESTRUCTIVE.test(stripSqlComments(sql))) {
      return Promise.resolve({
        kind: 'deny',
        reason: 'destructive statements (DROP/TRUNCATE) are not allowed through the agent; run them manually',
      })
    }
    return next()
  })

  ctx.systemPrompt.section({
    name: 'tool:db',
    order: 1800,
    text: [
      `Connected to a **${driver}** database (${readOnly ? 'read-only' : 'read-write'}).`,
      'Use `db_tables` to discover tables, `db_schema` to inspect columns, then `db_query` for SQL.',
      readOnly ? 'Mutation statements (INSERT/UPDATE/DELETE/DROP/TRUNCATE) are blocked by policy.' : '',
    ].filter(Boolean).join(' '),
  })

  /* db_query */
  ctx.tools.register(defineTool({
    name: 'db_query',
    description: `Execute a SQL query against the ${driver} database and return result rows.`,
    timeoutMs: timeout,
    parameters: {
      sql: { type: 'string', required: true, description: 'SQL query to execute' },
      params: {
        type: 'array',
        description: 'Positional parameters ($1, $2 for Postgres; ?, ? for MySQL/SQLite)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: { type: 'array', required: true },
          rowCount: { type: 'number', required: true },
          fields: { type: 'array', required: true },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: value.rows.length === 0
          ? '0 rows returned'
          : `${value.rowCount} row(s)${value.truncated ? ' (truncated)' : ''}\n${JSON.stringify(value.rows, null, 2)}`,
      }],
    },
    async execute(args) {
      if (!args.sql?.trim()) throw new Error('sql must be a non-empty string')
      if (readOnly && isMutation(args.sql)) {
        throw new Error('database is configured as read-only; mutation statements are not allowed')
      }
      const result = await executor.query(args.sql, args.params ?? undefined)
      const truncated = result.rows.length > maxRows
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema projects branded JSON type
        rows: sanitize(truncated ? result.rows.slice(0, maxRows) : result.rows) as any,
        rowCount: result.rows.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- field metadata varies per driver
        fields: result.fields as any,
        truncated,
      }
    },
  }))

  /* db_tables */
  ctx.tools.register(defineTool({
    name: 'db_tables',
    description: 'List all tables in the connected database.',
    timeoutMs: timeout,
    parameters: {},
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{
        type: 'text' as const,
        text: value.length === 0 ? 'No tables found' : `${value.length} table(s):\n${JSON.stringify(value, null, 2)}`,
      }],
    },
    async execute() {
      return sanitize(await executor.listTables())
    },
  }))

  /* db_schema */
  ctx.tools.register(defineTool({
    name: 'db_schema',
    description: 'Show column names, types, and constraints for a database table.',
    timeoutMs: timeout,
    parameters: {
      table: { type: 'string', required: true, description: 'Table name' },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{
        type: 'text' as const,
        text: value.length === 0
          ? 'Table not found or has no columns'
          : `${value.length} column(s):\n${JSON.stringify(value, null, 2)}`,
      }],
    },
    async execute(args) {
      if (!args.table?.trim()) throw new Error('table must be a non-empty string')
      return sanitize(await executor.describeTable(args.table))
    },
  }))
}

/* -------------------------------------------------------- shared helpers */

/** Strip SQL block/line comments so mutation regex cannot be fooled. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
}

/** Mutation check that survives comment/CTE obfuscation. */
const MUTATION = /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|MERGE|EXEC(UTE)?|CALL)\b/i
const CTE_MUTATION = /\bWITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|MERGE|REPLACE)\b/i

function isMutation(sql: string): boolean {
  const clean = stripSqlComments(sql)
  return MUTATION.test(clean) || CTE_MUTATION.test(clean)
}

function parseDriver(url: string): Driver | undefined {
  const scheme = url.split(':')[0]?.toLowerCase()
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres'
  if (scheme === 'mysql') return 'mysql'
  if (scheme === 'sqlite' || scheme === 'file') return 'sqlite'
  if (scheme === 'oracle') return 'oracle'
  if (scheme === 'mssql' || scheme === 'sqlserver') return 'mssql'
  return process.env.DB_DRIVER as Driver | undefined
}

function createExecutor(driver: Driver, url: string): Executor {
  try {
    switch (driver) {
      case 'postgres': return pgExecutor(url)
      case 'sqlite': return sqliteExecutor(url)
      case 'mysql': return mysqlExecutor(url)
      case 'oracle': return oracleExecutor(url)
      case 'mssql': return mssqlExecutor(url)
    }
  } catch (err) {
    const pkg: Record<Driver, string> = {
      postgres: 'postgres', sqlite: 'better-sqlite3', mysql: 'mysql2',
      oracle: 'oracledb', mssql: 'mssql',
    }
    throw new Error(
      `tool-db: the "${driver}" driver failed to load — install it with: pnpm add ${pkg[driver]}`,
      { cause: err },
    )
  }
}

/** Deep-clone through JSON to strip Proxy wrappers and non-serializable types. */
function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** Validate a table/column identifier to prevent SQL injection. */
function assertIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    throw new Error(`invalid identifier: ${name}`)
  }
}

/** Map raw column rows to the standard ColMeta shape. */
function toColMeta(rows: Record<string, unknown>[]) {
  return rows.map(r => ({
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    nullable: r.nullable === true || r.nullable === 1 || r.nullable === 'YES' || r.nullable === 'Y',
    default: r.default == null ? null : String(r.default).trim(),
    pk: r.pk === true || r.pk === 1,
  }))
}

/* -------------------------------------------------------- query dispatch */

/* -------------------------------------------------------- PostgreSQL */

function pgExecutor(url: string): Executor {
  const postgres = require('postgres') as (url: string) => import('postgres').Sql
  const sql = postgres(url)

  return {
    async query(sqlText, params) {
      const result = await sql.unsafe(sqlText, params as never[])
      const meta = (result as unknown as { columns?: Array<{ name: string; type: number }> }).columns
      return {
        rows: Array.from(result) as Record<string, unknown>[],
        fields: (meta ?? []).map(f => ({ name: f.name, type: String(f.type) })),
      }
    },
    async listTables() {
      return Array.from(await sql.unsafe(
        `SELECT table_name AS name, table_type AS type
           FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name`,
      )) as { name: string; type: string }[]
    },
    async describeTable(table) {
      const rows = Array.from(await sql.unsafe(
        `SELECT c.column_name AS name, c.data_type AS type,
                c.is_nullable = 'YES' AS nullable, c.column_default AS "default",
                COALESCE((SELECT true FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                 WHERE tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
                   AND kcu.column_name = c.column_name), false) AS pk
           FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = $1
          ORDER BY c.ordinal_position`,
        [table],
      )) as Record<string, unknown>[]
      return toColMeta(rows)
    },
    close: async () => { await sql.end() },
  }
}

/* -------------------------------------------------------- SQLite */

function sqliteExecutor(url: string): Executor {
  const path = url.replace(/^sqlite:\/\//, '').replace(/^file:\/\//, '')
  if (path !== ':memory:') void mkdir(dirname(path), { recursive: true })

  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  return {
    async query(sqlText, params) {
      const stmt = db.prepare(sqlText)
      if (stmt.reader) {
        const rows = stmt.all(...(params ?? [])) as Record<string, unknown>[]
        const fields = rows[0] ? Object.keys(rows[0]).map(name => ({ name, type: 'TEXT' })) : []
        return { rows, fields }
      }
      stmt.run(...(params ?? []))
      return { rows: [], fields: [{ name: 'changes', type: 'INTEGER' }] }
    },
    async listTables() {
      return db.prepare(
        'SELECT name, type FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name',
      ).all() as { name: string; type: string }[]
    },
    async describeTable(table) {
      assertIdentifier(table)
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string
        type: string
        notnull: number
        dflt_value: unknown
        pk: number
      }[]
      return cols.map(c => ({
        name: c.name,
        type: sqliteAffinity(c.type),
        nullable: c.notnull === 0,
        default: c.dflt_value === null ? null : String(c.dflt_value),
        pk: c.pk > 0,
      }))
    },
    close: () => { db.close() },
  }
}

function sqliteAffinity(decl: string): string {
  const upper = decl.toUpperCase()
  if (upper.includes('INT')) return 'INTEGER'
  if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('CLOB')) return 'TEXT'
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL'
  if (upper.includes('BOOL')) return 'INTEGER'
  return decl || 'BLOB'
}

/* -------------------------------------------------------- MySQL */

function mysqlExecutor(url: string): Executor {
  const mysql = require('mysql2/promise') as { createPool: (config: unknown) => import('mysql2/promise').Pool }
  const parsed = new URL(url)
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  })

  return {
    async query(sqlText, params) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 params are declared any[] upstream
      const [rows, fields] = await pool.execute(sqlText, (params ?? []) as any)
      return {
        rows: (Array.isArray(rows) ? rows : []) as Record<string, unknown>[],
        fields: Array.isArray(fields)
          ? (fields as Array<{ name: string; type: number }>).map(f => ({ name: f.name, type: String(f.type) }))
          : [],
      }
    },
    async listTables() {
      const [rows] = await pool.execute(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
      )
      return rows as { name: string; type: string }[]
    },
    async describeTable(table) {
      const [rows] = await pool.execute(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type,
                IF(IS_NULLABLE = 'YES', 1, 0) AS nullable,
                COLUMN_DEFAULT AS \`default\`,
                IF(COLUMN_KEY = 'PRI', 1, 0) AS pk
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [table],
      )
      return toColMeta(rows as Record<string, unknown>[])
    },
    close: async () => { await pool.end() },
  }
}

/* -------------------------------------------------------- Oracle */

function oracleExecutor(url: string): Executor {
  const oracledb = require('oracledb') as typeof import('oracledb')
  const parsed = new URL(url)
  const connectString = parsed.hostname + (parsed.port ? `:${parsed.port}` : '') + parsed.pathname

  let pool: import('oracledb').Pool | undefined
  const getPool = async () => pool ??= await oracledb.createPool({
    connectionString: connectString,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  })

  const run = async <T>(fn: (conn: import('oracledb').Connection) => Promise<T>): Promise<T> => {
    const conn = await (await getPool()).getConnection()
    try { return await fn(conn) } finally { await conn.close() }
  }

  const exec = (conn: import('oracledb').Connection, sql: string, binds?: unknown[] | Record<string, unknown>) =>
    conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })

  return {
    async query(sqlText, params) {
      return run(async (conn) => {
        const result = await exec(conn, sqlText, params ?? [])
        return {
          rows: (result.rows ?? []) as Record<string, unknown>[],
          fields: (result.metaData ?? []).map(m => ({ name: m.name, type: String(m.dbType ?? '') })),
        }
      })
    },
    async listTables() {
      return run(async (conn) => {
        const result = await exec(conn, 'SELECT table_name AS "name", \'BASE TABLE\' AS "type" FROM user_tables ORDER BY table_name')
        return (result.rows ?? []) as { name: string; type: string }[]
      })
    },
    async describeTable(table) {
      return run(async (conn) => {
        const result = await exec(conn,
          `SELECT c.column_name AS "name", c.data_type AS "type",
                  CASE WHEN c.nullable = 'Y' THEN 1 ELSE 0 END AS "nullable",
                  c.data_default AS "default",
                  CASE WHEN cc.column_name IS NOT NULL THEN 1 ELSE 0 END AS "pk"
             FROM all_tab_columns c
             LEFT JOIN (SELECT acc.table_name, acc.column_name
                 FROM all_constraints ac JOIN all_cons_columns acc
                   ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
                WHERE ac.constraint_type = 'P') cc
               ON cc.table_name = c.table_name AND cc.column_name = c.column_name
            WHERE c.owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AND c.table_name = :t
            ORDER BY c.column_id`,
          { t: table.toUpperCase() },
        )
        return toColMeta((result.rows ?? []) as Record<string, unknown>[])
      })
    },
    close: async () => { if (pool) await pool.close() },
  }
}

/* -------------------------------------------------------- SQL Server */

function mssqlExecutor(url: string): Executor {
  const { ConnectionPool } = require('mssql') as typeof import('mssql')
  const parsed = new URL(url)
  const cfg: import('mssql').config = {
    server: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 1433,
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    options: {
      encrypt: parsed.searchParams.get('encrypt') !== 'false',
      trustServerCertificate: parsed.searchParams.get('trustServerCertificate') === 'true',
    },
  }

  let pool: import('mssql').ConnectionPool | undefined
  const getPool = async () => pool ??= await new ConnectionPool(cfg).connect()

  return {
    async query(sqlText, params) {
      const p = await getPool()
      const req = p.request()
      ;(params ?? []).forEach((v, i) => { req.input(`p${i}`, v) })
      const mappedSql = (params ?? []).reduce<string>((s, _, i) => s.replace(/\?/, `@p${i}`), sqlText)
      const result = await req.query(mappedSql)
      const rs = result.recordset as Record<string, unknown>[] & { columns?: Record<string, { type?: unknown }> }
      const rows = (rs ?? []) as Record<string, unknown>[]
      const fields = Object.entries(rs?.columns ?? {}).map(([name, meta]) => ({
        name, type: String(meta?.type ?? 'NVARCHAR'),
      }))
      return { rows, fields }
    },
    async listTables() {
      const p = await getPool()
      const result = await p.request().query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
           FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = DB_NAME() ORDER BY TABLE_NAME`,
      )
      return (result.recordset ?? []) as { name: string; type: string }[]
    },
    async describeTable(table) {
      const p = await getPool()
      const result = await p.request().input('tableName', table).query(
        `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type,
                CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS nullable,
                c.COLUMN_DEFAULT AS [default],
                CASE WHEN tc.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 1 ELSE 0 END AS pk
           FROM INFORMATION_SCHEMA.COLUMNS c
           LEFT JOIN (SELECT kcu.COLUMN_NAME, kcu.TABLE_NAME, tc.CONSTRAINT_TYPE
               FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                 ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') tc
             ON tc.TABLE_NAME = c.TABLE_NAME AND tc.COLUMN_NAME = c.COLUMN_NAME
          WHERE c.TABLE_CATALOG = DB_NAME() AND c.TABLE_NAME = @tableName
          ORDER BY c.ORDINAL_POSITION`,
      )
      return toColMeta((result.recordset ?? []) as Record<string, unknown>[])
    },
    close: async () => { if (pool) await pool.close() },
  }
}
