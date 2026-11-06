// @effect-diagnostics nodeBuiltinImport:off -- Test fixture: certificates for a TLS server are made with the openssl CLI.
// fork: real certificates for the validation-failure tests (research/remote-loopback-forwarding.md
// 3.6). One test CA signs a good leaf, an expired one and a leaf for another host; an intermediate
// signs a leaf the server presents without its chain; and a self-signed certificate nobody signed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface TlsPair {
  readonly key: string;
  readonly cert: string;
}

export interface TlsFixtures {
  /** The test CA, to be trusted by the client under test. */
  readonly ca: string;
  /** SAN `localhost`, signed by the CA. */
  readonly valid: TlsPair;
  /** SAN `localhost`, signed by the CA, expired in 2020. */
  readonly expired: TlsPair;
  /** SAN `other.example`, signed by the CA. */
  readonly wrongHost: TlsPair;
  /** SAN `localhost`, signed by an intermediate; `cert` is the leaf alone, `chain` has both. */
  readonly viaIntermediate: TlsPair & { readonly chain: string };
  /** SAN `localhost`, signed by nobody. */
  readonly selfSigned: TlsPair;
  readonly dispose: () => void;
}

const CONFIG = `
[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
[ca]
default_ca = ca_default
[ca_default]
dir = .
database = index.txt
new_certs_dir = .
serial = serial.txt
default_md = sha256
policy = policy_any
unique_subject = no
copy_extensions = none
[policy_any]
commonName = supplied
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[v3_leaf_localhost]
basicConstraints = CA:FALSE
subjectAltName = DNS:localhost, IP:127.0.0.1
[v3_leaf_other]
basicConstraints = CA:FALSE
subjectAltName = DNS:other.example
`;

export const makeTlsFixtures = async (): Promise<TlsFixtures> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-tls-"));
  const openssl = (...args: ReadonlyArray<string>) => execFile("openssl", [...args], { cwd: dir });
  const read = (name: string) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8");
  NodeFS.writeFileSync(NodePath.join(dir, "openssl.cnf"), CONFIG);
  NodeFS.writeFileSync(NodePath.join(dir, "index.txt"), "");
  NodeFS.writeFileSync(NodePath.join(dir, "serial.txt"), "1000\n");
  const cnf = ["-config", "openssl.cnf"] as const;

  await openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "3650",
    "-subj",
    "/CN=T3X Test CA",
    "-extensions",
    "v3_ca",
    ...cnf,
  );

  const csr = async (name: string, subject: string) => {
    await openssl(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      subject,
      ...cnf,
    );
  };

  // `openssl ca` is used for every signed certificate: it is the one command that can backdate.
  const sign = async (
    name: string,
    signer: { readonly cert: string; readonly key: string },
    extensions: string,
    window: ReadonlyArray<string> = ["-days", "3650"],
  ) => {
    await openssl(
      "ca",
      "-batch",
      "-notext",
      "-in",
      `${name}.csr`,
      "-out",
      `${name}.pem`,
      "-cert",
      signer.cert,
      "-keyfile",
      signer.key,
      "-extensions",
      extensions,
      ...window,
      ...cnf,
    );
  };

  const root = { cert: "ca.pem", key: "ca.key" };

  await csr("valid", "/CN=localhost");
  await sign("valid", root, "v3_leaf_localhost");

  await csr("expired", "/CN=localhost");
  await sign("expired", root, "v3_leaf_localhost", [
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
  ]);

  await csr("wrong", "/CN=other.example");
  await sign("wrong", root, "v3_leaf_other");

  await csr("intermediate", "/CN=T3X Test Intermediate");
  await sign("intermediate", root, "v3_ca");
  await csr("chained", "/CN=localhost");
  await sign("chained", { cert: "intermediate.pem", key: "intermediate.key" }, "v3_leaf_localhost");

  await openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "self.key",
    "-out",
    "self.pem",
    "-days",
    "3650",
    "-subj",
    "/CN=localhost",
    "-extensions",
    "v3_leaf_localhost",
    ...cnf,
  );

  return {
    ca: read("ca.pem"),
    valid: { key: read("valid.key"), cert: read("valid.pem") },
    expired: { key: read("expired.key"), cert: read("expired.pem") },
    wrongHost: { key: read("wrong.key"), cert: read("wrong.pem") },
    viaIntermediate: {
      key: read("chained.key"),
      cert: read("chained.pem"),
      chain: `${read("chained.pem")}${read("intermediate.pem")}`,
    },
    selfSigned: { key: read("self.key"), cert: read("self.pem") },
    dispose: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};
