import { describe, expect, it } from "vitest";
import { updateHarbourDatabase } from "../src/services/harbour";
import type { CloudflareEnv } from "../src/types";

function fakeDb(initial: Record<string, string>) {
  const table = new Map(Object.entries(initial));
  const statement = (sql: string) => ({
    bind: (...args: unknown[]) => ({ sql, args }),
    all: async () => ({ results: [...table].map(([id, name]) => ({ id, name })) }),
  });
  const db = {
    prepare: statement,
    batch: async (stmts: { sql: string; args: string[] }[]) => {
      for (const { sql, args } of stmts) {
        if (sql.includes("INSERT")) table.set(args[0], args[1]);
        else if (sql.includes("DELETE")) table.delete(args[0]);
      }
    },
  };
  return { env: { DB: db } as unknown as CloudflareEnv, table };
}

describe("updateHarbourDatabase", () => {
  it("adds, renames and deletes harbours", async () => {
    const { env, table } = fakeDb({ "1": "A", "2": "B", "3": "Gone" });
    const result = await updateHarbourDatabase({ "1": "A", "2": "B2", "4": "D" }, env);

    expect(result).toEqual({ upserted: 2, deleted: 1 });
    expect(Object.fromEntries(table)).toEqual({ "1": "A", "2": "B2", "4": "D" });
  });

  it("is a no-op when nothing changed", async () => {
    const { env } = fakeDb({ "1": "A" });
    expect(await updateHarbourDatabase({ "1": "A" }, env)).toEqual({ upserted: 0, deleted: 0 });
  });

  it("refuses an empty list instead of wiping the registry", async () => {
    const { env, table } = fakeDb({ "1": "A" });
    await expect(updateHarbourDatabase({}, env)).rejects.toThrow();
    expect(table.size).toBe(1);
  });

  it("handles more statements than one batch", async () => {
    const { env, table } = fakeDb({});
    const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [String(i), `H${i}`]));
    await updateHarbourDatabase(many, env);
    expect(table.size).toBe(120);
  });
});
