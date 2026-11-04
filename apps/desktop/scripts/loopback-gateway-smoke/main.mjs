// fork: Electron entry of the gateway smoke. The harness is TypeScript and imports the real
// proxy, host and fake gateway; Electron's Node strips the types itself.
await import("./smoke.ts");
