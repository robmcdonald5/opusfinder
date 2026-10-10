import { INHERIT, type KnobView, type StageView } from "@opusfinder/control";

import { esc } from "./html";

/**
 * The owner's change forms, one per thing being changed and placed next to it. Each is a collapsed
 * <details> (no script), offers only the values that target takes, and posts to /ui/change with a `back`
 * path so the owner lands on the page they were on. The server re-validates everything (classify() and
 * parseValue()); the HTML limits are only there to catch typos before the round trip.
 */

/** Where /ui/change may send the browser back to: panel pages only, never an arbitrary URL. */
export const BACK_PATH = /^\/(?:approvals|stages(?:\/[a-z0-9_]+)?|health)?$/;

const REASON = `<label>Reason (required, logged)<input name="reason" required maxlength="300" autocomplete="off"></label>`;

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function changeBox(summary: string, back: string, fields: string): string {
  return `<details class="change"><summary>${esc(summary)}</summary><form class="form" method="post" action="/ui/change">${hidden(
    "back",
    back,
  )}${fields}${REASON}<button type="submit">Apply</button></form></details>`;
}

function options(values: readonly { value: string; label: string; selected?: boolean }[]): string {
  return values
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join("");
}

/** Change one mode switch (the master switch, a stage or a policy) among its own modes. */
export function modeForm(
  target: string,
  modes: readonly string[],
  current: string,
  back: string,
): string {
  return changeBox(
    "Change mode",
    back,
    `${hidden("target", target)}<label>New mode<select name="value">${options(
      modes.map((m) => ({
        value: m,
        label: m === current ? `${m} (now)` : m,
        selected: m === current,
      })),
    )}</select></label>`,
  );
}

export function knobForm(k: KnobView, back: string): string {
  const unit = k.unit ? ` ${k.unit}` : "";
  return changeBox(
    "Change value",
    back,
    `${hidden("target", k.target)}<label>New value (${esc(k.min)}–${esc(k.max)}${esc(unit)}, now ${esc(
      k.value,
    )})<input name="value" type="number" inputmode="decimal" min="${esc(k.min)}" max="${esc(
      k.max,
    )}" step="${k.int ? "1" : "any"}" required autocomplete="off"></label>`,
  );
}

/**
 * Narrow one slice (source, lane) of a stage. An override can only cap a slice below its stage, so the
 * choices are the stage's modes below its top one, plus "inherit" (clear) — the top mode IS no override.
 */
export function overrideForm(
  stage: StageView,
  dim: string,
  values: readonly string[],
  back: string,
): string {
  const set = new Map(stage.overrides.filter((o) => o.dim === dim).map((o) => [o.value, o]));
  const narrower = stage.modes.slice(0, -1);
  return changeBox(
    `Narrow one ${dim}`,
    back,
    `<label>${esc(dim)}<select name="target">${options(
      values.map((v) => {
        const o = set.get(v);
        return {
          value: `${stage.id}@${dim}=${v}`,
          label: o ? `${v} (now ${o.override})` : `${v} (follows the stage)`,
        };
      }),
    )}</select></label><label>Set to<select name="value">${options([
      ...narrower.map((m) => ({ value: m, label: m })),
      { value: INHERIT, label: "inherit (follow the stage)" },
    ])}</select></label>`,
  );
}
