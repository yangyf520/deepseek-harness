declare module 'oracledb' {
  const OUT_FORMAT_OBJECT: number
  function createPool(config: unknown): Promise<Pool>
  interface Pool { getConnection(): Promise<Connection>; close(): Promise<void> }
  interface Connection {
    execute(sql: string, binds?: unknown[] | Record<string, unknown>, opts?: unknown): Promise<Result>
    close(): Promise<void>
  }
  interface Result {
    rows?: Record<string, unknown>[]
    metaData?: Array<{ name: string; dbType?: unknown }>
  }
  export { OUT_FORMAT_OBJECT, createPool, Pool, Connection, Result }
}

declare module 'mssql' {
  interface config {
    server: string
    port: number
    database: string
    user: string
    password: string
    options?: { encrypt?: boolean; trustServerCertificate?: boolean }
  }
  class ConnectionPool {
    constructor(config: config)
    connect(): Promise<ConnectionPool>
    request(): Request
    close(): Promise<void>
  }
  class Request {
    input(name: string, value: unknown): Request
    query(sql: string): Promise<Result>
  }
  interface Result {
    recordset: Record<string, unknown>[]
    rowsAffected: number[]
  }
  export { ConnectionPool, config, Request, Result }
}
