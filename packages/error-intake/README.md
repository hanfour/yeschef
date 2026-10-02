# @yeschef/error-intake

Collect server and browser errors in a MySQL database shared with YesChef. The package masks common secrets before writing and groups matching errors by a stable fingerprint.

## Install

```sh
npm install @yeschef/error-intake mysql2
```

Install the framework package used by your application separately. NestJS, Express, and Next.js are optional peer dependencies.

Set these environment variables in the server environment:

```sh
ERROR_INTAKE_DATABASE_URL=mysql://writer:password@db.example.test/errors
ERROR_INTAKE_PROJECT=orders-api
APP_ENV=production
```

`APP_ENV` accepts `local`, `staging`, or `production`. If it is unset or invalid, `NODE_ENV=development` and `NODE_ENV=test` resolve to `local`; other values resolve to `production`.

Create one sink when the server starts. Import `MIGRATIONS` and `SCHEMA_VERSION` when initializing the database from a trusted administrator connection. The sink checks `error_intake_meta` before its first write and does not write if the installed schema version differs.

```ts
import { createMysqlSink, resolveEnvironment } from "@yeschef/error-intake";

export const errorSink = createMysqlSink({
  url: process.env.ERROR_INTAKE_DATABASE_URL!,
  project: process.env.ERROR_INTAKE_PROJECT!,
  environment: resolveEnvironment(process.env),
});
```

Close the sink during graceful shutdown with `await errorSink.close()`.

## NestJS

Register the exception filter globally and mount the browser intake handler as middleware:

```ts
import { ErrorIntakeExceptionFilter, createClientErrorHandler } from "@yeschef/error-intake/nestjs";
import { HttpAdapterHost } from "@nestjs/core";
import { errorSink } from "./error-sink.js";

app.useGlobalFilters(new ErrorIntakeExceptionFilter(errorSink, app.get(HttpAdapterHost)));
app.use("/error-intake", createClientErrorHandler(errorSink));
```

HTTP exceptions below 500 continue through Nest's default exception handling and are not collected. Server errors are recorded before Nest creates its normal response.

Mount the handler at the path the request reaches in NestJS after any frontend proxy rewrites it. For example, if a Vite or nginx proxy removes the `/api` prefix from `/api/error-intake`, the NestJS handler must use `/error-intake` as shown above. If the proxy preserves the prefix, mount it at `/api/error-intake` instead.

## Express

Mount the browser handler, then add the error middleware after application routes. For CommonJS applications such as Express 4:

```js
const { createMysqlSink, resolveEnvironment } = require("@yeschef/error-intake");
const { createClientErrorHandler, errorIntakeErrorMiddleware } = require("@yeschef/error-intake/express");
const errorSink = createMysqlSink({
  url: process.env.ERROR_INTAKE_DATABASE_URL,
  project: process.env.ERROR_INTAKE_PROJECT,
  environment: resolveEnvironment(process.env),
});

app.post("/error-intake", createClientErrorHandler(errorSink));
app.use(errorIntakeErrorMiddleware(errorSink));
```

For ES modules such as Express 5, use imports:

```ts
import { createClientErrorHandler, errorIntakeErrorMiddleware } from "@yeschef/error-intake/express";
import { errorSink } from "./error-sink.js";

app.post("/error-intake", createClientErrorHandler(errorSink));
app.use(errorIntakeErrorMiddleware(errorSink));
```

The error middleware records 5xx errors and passes every error to `next(err)` so the application's existing handler remains responsible for the response. As with NestJS, mount the browser handler at the path received by Express after proxy rewrites.

## Next.js

Use the Node.js runtime for server error collection and the App Router intake route. Keep the sink in a server-only module.

`instrumentation.ts`:

```ts
import { createOnRequestError } from "@yeschef/error-intake/next";
import { errorSink } from "./src/lib/error-sink";

export const onRequestError = createOnRequestError(errorSink);
```

`app/api/error-intake/route.ts`:

```ts
import { createClientErrorRoute } from "@yeschef/error-intake/next";
import { errorSink } from "@/src/lib/error-sink";

export const runtime = "nodejs";
export const { POST } = createClientErrorRoute(errorSink);
```

Do not use the sink, `onRequestError`, or the intake route in the Edge runtime. `mysql2` requires Node.js.

Import the sink module without a file extension (`./src/lib/error-sink`). Turbopack, the default bundler in recent Next.js versions, does not map a `.js` import to a `.ts` file.

## Browser reporting

Install the framework agnostic reporter in the browser entry point. Framework error boundaries can call `reportError(error)` directly.

```ts
import { installErrorReporter, reportError } from "@yeschef/error-intake/browser";

installErrorReporter({ endpoint: "/api/error-intake", release: "2026.10.1" });

function onFrameworkError(error: unknown): void {
  reportError(error);
}
```

The reporter listens for uncaught errors and unhandled promise rejections. It uses `navigator.sendBeacon` with a `text/plain` JSON body, then falls back to `fetch` with `keepalive` when beacons are unavailable or rejected. It sends each fingerprint once per page and allows at most ten reports per minute.

The `endpoint` must match the backend route after proxy rewriting. For example, a browser may send to `/api/error-intake` while a Vite or nginx proxy removes `/api` and forwards the request to `/error-intake`.

## Data and limits

The package does not collect user IDs, email addresses as identity fields, IP addresses, request bodies, headers, cookies, or interaction history. Browser IP is used only in process memory to enforce the receiver's per-minute rate limit and is not written to MySQL. Browser user-agent storage is reduced to the browser name, major version, and operating system.

Error messages and stacks can contain personal or secret values. The package masks email addresses, bearer tokens, JWT-shaped strings, URL query strings and fragments, long numbers, and common secret fields before storage. Masking is best effort; review the data your application may put into errors before enabling collection.

Each error group retains at most twenty samples. Matching errors in the same second add to the group count but only create one sample. Each project environment can create at most two hundred new groups per hour; later new fingerprints are grouped under the fixed `overflow` fingerprint for that hour.

## Repository acceptance

The source repository includes an external maintainer acceptance runner under `acceptance/`; it is not part of the published package. It uses `tsx`, so it can run under the Node 20 and Node 24 executables being checked. Build and pack the package first, then run `npm_config_cache="$(mktemp -d)" npx --yes tsx acceptance/run.ts` from `packages/error-intake/` twice with Node 20 and twice with Node 24.

Set `EI_PKG_ROOT_URL` to a MySQL root URL whose database path is exactly `/ei_pkg_accept`, `EI_PKG_TARBALL` to the absolute `.tgz` path, and `EI_PKG_NODE` to the absolute Node executable for that run. The runner drops and recreates `ei_pkg_accept` before testing. It writes a credential-free report under `acceptance/results/`.
