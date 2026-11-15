// The Node entry: the package's public surface, with packages/llm/.env loaded first (relative to THIS
// module, so cross-package callers pick up the key from their own directories too). Scripts and the
// Node-hosted pipelines import this; a Worker imports the bare package and passes `apiKey` instead.
import { loadPackageEnv } from "@opusfinder/shared/env";

loadPackageEnv(import.meta.url);

export * from "./index";
