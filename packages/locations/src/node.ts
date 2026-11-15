// The Node entry: the package's public surface, with the OpenRouter key's .env (packages/llm/.env)
// loaded first. This package has no env of its own. A Worker imports the bare package and passes the key
// to createLocationModel instead.
import "@opusfinder/llm/node";

export * from "./index";
