/** Where the packaged app keeps frpc; the backend and the `t3x` launcher both point `T3X_FRPC_PATH` here. */
export const bundledFrpcPath = (
  path: { readonly join: (...segments: ReadonlyArray<string>) => string },
  resourcesPath: string,
  platform: NodeJS.Platform,
) => path.join(resourcesPath, "bin", platform === "win32" ? "frpc.exe" : "frpc");
