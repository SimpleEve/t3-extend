import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { SIGNED_URL_ROUTE_OPTIONS } from "../../http.ts";
import { requestUrl } from "../../requestUrl.ts";
import {
  THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX,
  storeThemeBackgroundUpload,
  validateThemeBackgroundUploadToken,
} from "./upload.ts";

// fork: POST /api/theme-backgrounds/upload/<token>. The token is the capability, as it is for an
// attachment upload; the route answers `{ hash }` once the picture is stored.
export const layerThemeBackgroundUploadRoute = HttpRouter.add(
  "POST",
  `${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });

    const token = url.value.pathname.slice(`${THEME_BACKGROUND_UPLOAD_ROUTE_PREFIX}/`.length);
    const claims = token ? yield* validateThemeBackgroundUploadToken(token) : null;
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });

    const contentLength = request.headers["content-length"];
    if (
      contentLength !== undefined &&
      (!Number.isInteger(Number(contentLength)) || Number(contentLength) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", { status: 400 });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeThemeBackgroundUpload(
      claims,
      Stream.fromPull(Effect.succeed(bodyPull)),
    );
    return stored.ok
      ? yield* HttpServerResponse.json({ hash: stored.hash })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
  SIGNED_URL_ROUTE_OPTIONS,
);
