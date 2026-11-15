// The Node entry: the package's public surface, with packages/embeddings/.env loaded first (relative to
// THIS module, so cross-package callers such as the sources ingestion scripts pick up VOYAGE_API_KEY from
// their own directories too). A Worker imports the bare package and passes `apiKey` instead.
import { loadPackageEnv } from "@opusfinder/shared/env";

loadPackageEnv(import.meta.url);

export * from "./index";
