declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  on(event: string, listener: (...args: any[]) => void): void;
};

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(value: string): { digest(encoding: "hex"): string };
    digest(encoding: "hex"): string;
  };
  export function createHmac(algorithm: string, key: string): {
    update(value: string): { digest(encoding: "hex"): string };
    digest(encoding: "hex"): string;
  };
  export function randomUUID(): string;
}

declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function appendFileSync(path: string, data: string, options?: { encoding?: "utf8" }): void;
  export function statSync(path: string): { size: number };
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { force?: boolean }): void;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:http" {
  export function createServer(handler: (request: any, response: any) => void | Promise<void>): any;
}

declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string);
    pathname: string;
    searchParams: { get(name: string): string | null };
  }
}

declare module "node:sqlite" {
  export class StatementSync {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:test" {
  export default function test(name: string, fn: (context?: any) => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: any, expected: any, message?: string): void;
    deepEqual(actual: any, expected: any, message?: string): void;
    ok(value: any, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    rejects(fn: () => Promise<any>, expected?: any): Promise<void>;
    throws(fn: () => any, expected?: any): void;
  };
  export default assert;
}
