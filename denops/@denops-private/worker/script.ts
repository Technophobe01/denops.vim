import {
  assertObject,
  assertString,
  isObject,
  isString,
} from "https://deno.land/x/unknownutil@v2.1.0/mod.ts#^";
import { Session } from "https://deno.land/x/msgpack_rpc@v3.1.6/mod.ts#^";
import { using } from "https://deno.land/x/disposable@v1.1.0/mod.ts#^";
import {
  WorkerReader,
  WorkerWriter,
} from "https://deno.land/x/workerio@v1.4.4/mod.ts#^";
import { responseTimeout } from "../defs.ts";
import type { Denops, Meta } from "../../@denops/mod.ts";
import { DenopsImpl } from "../impl.ts";

const worker = self as unknown as Worker;

async function main(
  name: string,
  scriptUrl: string,
  meta: Meta,
): Promise<void> {
  const reader = new WorkerReader(worker);
  const writer = new WorkerWriter(worker);
  await using(
    new Session(reader, writer, {}, {
      responseTimeout,
      errorCallback(e) {
        if (e.name === "Interrupted") {
          return;
        }
        console.error(`Unexpected error occurred in '${name}'`, e);
      },
    }),
    async (session) => {
      // Protect the process itself from "Unhandled promises"
      // https://github.com/vim-denops/denops.vim/issues/208
      globalThis.addEventListener("unhandledrejection", (ev) => {
        // XXX:
        // Denops support Deno from 1.17 so the following `unknown` is required
        // to pass type-check. Note that the code is not invoked because "unhandledrejection"
        // event itself is supported from Deno 1.24 (and Deno 1.24 has `reason` attribute on `ev`)
        let { reason } = ev as (Event & { reason: unknown });
        if (reason instanceof Error && reason.stack) {
          reason = reason.stack;
        }
        console.error(
          `Unhandled rejection is detected. Worker of '${name}' will be reloaded: ${reason}`,
        );
        // Reload the worker because "Unhandled promises" error occured.
        session.notify("reload");
        // Avoid process death
        ev.preventDefault();
      });
      const denops: Denops = new DenopsImpl(name, meta, session);
      try {
        // Import module with fragment so that reload works properly
        // https://github.com/vim-denops/denops.vim/issues/227
        const mod = await import(`${scriptUrl}#${performance.now()}`);
        await denops.cmd(`doautocmd <nomodeline> User DenopsPluginPre:${name}`)
          .catch((e) =>
            console.warn(`Failed to emit DenopsPluginPre:${name}: ${e}`)
          );
        await mod.main(denops);
        await denops.cmd(`doautocmd <nomodeline> User DenopsPluginPost:${name}`)
          .catch((e) =>
            console.warn(`Failed to emit DenopsPluginPost:${name}: ${e}`)
          );
      } catch (e) {
        console.error(`${name}: ${e}`);
        await denops.cmd(
          `doautocmd <nomodeline> User DenopsPluginFail:${name}`,
        )
          .catch((e) =>
            console.warn(`Failed to emit DenopsPluginFail:${name}: ${e}`)
          );
      } finally {
        await session.waitClosed();
      }
    },
  );
  self.close();
}

function isMeta(v: unknown): v is Meta {
  if (!isObject(v)) {
    return false;
  }
  if (!isString(v.mode) || !["release", "debug", "test"].includes(v.mode)) {
    return false;
  }
  if (!isString(v.host) || !["vim", "nvim"].includes(v.host)) {
    return false;
  }
  if (!isString(v.version)) {
    return false;
  }
  if (
    !isString(v.platform) || !["windows", "mac", "linux"].includes(v.platform)
  ) {
    return false;
  }
  return true;
}

// Wait startup arguments and start 'main'
worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  assertObject(event.data);
  assertString(event.data.name);
  assertString(event.data.scriptUrl);
  if (!isMeta(event.data.meta)) {
    throw new Error(`Invalid 'meta' is passed: ${event.data.meta}`);
  }
  const { name, scriptUrl, meta } = event.data;
  main(name, scriptUrl, meta).catch((e) => {
    console.error(
      `Unexpected error occurred in '${name}' (${scriptUrl}): ${e}`,
    );
  });
}, { once: true });
