// @opusfinder/control — the control plane's pure core: the stage registry, the fail-closed resolver
// (effectiveMode) and the classify() permission rule. Worker-safe by construction (see registry.ts);
// imported by the control Worker (apps/control) and the `pnpm ctl` CLI (packages/ctl).
export * from "./registry";
export * from "./targets";
export * from "./resolve";
export * from "./classify";
export * from "./views";
