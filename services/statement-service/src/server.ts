import { NodeRuntime } from "@effect/platform-node";
import { launch } from "./main.js";

/**
 * Runnable entrypoint for the statement HTTP service. Kept separate from
 * `main.ts` so that importing the application layer (e.g. from tests) has no
 * side effects — only running this file starts a listening server.
 */
NodeRuntime.runMain(launch);
