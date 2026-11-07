import { describe, expect, it } from "vite-plus/test";

import { findSecret } from "./infraLogs.ts";

// The server's ticket shape: base64url(claims JSON) "." signature.
const ticket = (claims: Record<string, unknown>, signature: string) =>
  `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
const SESSION = { v: 1, kind: "websocket", sid: "8d49011b-7af0-4f61-97aa-3edf22b079ff" };
const gateway = ticket(
  {
    ...SESSION,
    aud: "loopback-gateway",
    jkt: "EItDl0KTINU33gipQFBwJP_c_Px-6WshSUEqau26qe8",
    iat: 1794024788236,
    exp: 1794025088236,
  },
  "sqdZrd0eRESAAwhLi-zhtik3RdFMCp_GlCnsbSLP9w",
);
const rpc = ticket(
  {
    ...SESSION,
    aud: "rpc",
    jkt: "EItDl0KTINU33gipQFBwJP_c_Px-6WshSUEqau26qe8",
    iat: 1794024788300,
    exp: 1794025088300,
  },
  "Zk3Qm9x1LpWvT7cUo2YhBnRe4SdAfGjK8iVtXbN6yMw",
);
const references = [
  ticket(
    {
      ...SESSION,
      aud: "loopback-gateway",
      jkt: "EItDl0KTINU33gipQFBwJP_c_Px-6WshSUEqau26qe8",
      iat: 1794024788299,
      exp: 1794025088299,
    },
    "Pq7Rs2Tu9Vw1Xy3Za5Bc8De0Fg4HiJ6kLmNoPqRsTuV",
  ),
];

describe("findSecret", () => {
  it("finds the whole ticket, a claims piece and a signature piece, wherever they are", () => {
    expect(findSecret(`x ${gateway} y`, gateway, { references })).toBe(gateway);
    // The timestamps are where this ticket differs from the reference: the last digits.
    const claimsPiece = gateway.slice(gateway.indexOf(".") - 18, gateway.indexOf(".") - 2);
    expect(findSecret(`... ${claimsPiece} ...`, gateway, { references })).toBeDefined();
    const signaturePiece = gateway.slice(-20, -2);
    expect(findSecret(`... ${signaturePiece} ...`, gateway, { references })).toBeDefined();
  });

  it("does not take what tickets of the session share for a leak", () => {
    expect(findSecret(`wsTicket=${rpc}`, gateway, { references })).toBeUndefined();
    // Without a reference the shared start is what would be flagged.
    expect(findSecret(`wsTicket=${rpc}`, gateway)).toBeDefined();
  });

  it("finds any 12-character piece of a made-up ticket", () => {
    expect(findSecret("a b c", "AAAA.BBBB")).toBeUndefined();
    expect(findSecret("zzz abcdefghijkl zzz", "0123.abcdefghijkl")).toBe("abcdefghijkl");
  });
});
