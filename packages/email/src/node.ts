// The Node entry: the package's public surface, with packages/email/.env loaded first (relative to THIS
// module, so cross-package callers such as the Inngest serve process and the trigger CLI pick up the
// Resend config from their own directories too). A Worker imports the bare package and passes an
// EmailConfig instead.
import { loadPackageEnv } from "@opusfinder/shared/env";

loadPackageEnv(import.meta.url);

export * from "./index";
