/**
 * Minimal ambient declarations so the IDE/tsc understands edge-function code
 * in this Node-flavoured workspace. The Supabase CLI provides the real Deno
 * types at deploy time.
 */

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

declare module 'npm:postgres@3.4.5' {
  // postgres.js is fully typed in its own package; the edge bundler resolves
  // the npm: specifier. A loose shim keeps local tsc runs clean.
  const postgres: (url: string, options?: Record<string, unknown>) => any;
  export default postgres;
}

declare module 'npm:bcryptjs@2.4.3' {
  const bcrypt: {
    compare(plain: string, hash: string): Promise<boolean>;
    hash(plain: string, rounds?: number): Promise<string>;
  };
  export default bcrypt;
}
