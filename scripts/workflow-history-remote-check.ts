// CI service entry: exercise the same history assertions through authenticated remote execution.
process.argv.push('--remote');
await import('./workflow-history-check.ts');
export {};
