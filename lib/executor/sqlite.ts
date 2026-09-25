// node:sqlite driver for the RunStore (a single local file owned by the executor).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "./store";

export function sqliteDriver(file: string): SqlDriver & { close(): void } {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return {
    kind: file === ":memory:" ? "sqlite-memory" : "sqlite",
    exec: async sql => { db.exec(sql); },
    all: async <T,>(sql: string, p: unknown[] = []) => db.prepare(sql).all(...(p as never[])) as T[],
    run: async (sql, p = []) => ({ changes: Number(db.prepare(sql).run(...(p as never[])).changes) }),
    close: () => db.close(),
  };
}
