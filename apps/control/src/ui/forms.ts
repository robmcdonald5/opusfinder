import { INHERIT, type KnobView, type StageView } from "@opusfinder/control";

import { controlRow } from "./components";
import { esc, num } from "./format";
import { modeLabel, sourceNote, type ModeKind } from "./vocab";

/** The server re-validates every change (classify(), parseValue()); the HTML limits only catch typos early. */

/** Where /ui/change may redirect: panel pages only, never an arbitrary URL. */
export const BACK_PATH = /^\/(?:approvals|stages(?:\/[a-z0-9_]+)?|health)?$/;

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function options(values: readonly { value: string; label: string; selected?: boolean }[]): string {
  return values
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join("");
}

/**
 * A value edited in place. Confirm and Cancel stay hidden until the field differs from the stored value
 * (the stylesheet's `.sw:has(…)`), so a stray pick never applies anything; Cancel is a plain reset.
 */
function inlineForm(target: string, back: string, field: string, name: string): string {
  return `<form class="sw" method="post" action="/ui/change" autocomplete="off">${field}<button type="submit" class="go primary" aria-label="Confirm the change to ${esc(
    name,
  )}">Confirm</button><button type="reset" class="go">Cancel</button>${hidden("target", target)}${hidden(
    "back",
    back,
  )}</form>`;
}

/** `name` is plain text: what the dropdown sets, for its accessible name. */
export function modeControl(
  sw: { target: string; modes: readonly string[]; desired: string },
  kind: ModeKind,
  back: string,
  name: string,
): string {
  return inlineForm(
    sw.target,
    back,
    `<select name="value" aria-label="${esc(name)}">${options(
      sw.modes.map((m) => ({ value: m, label: modeLabel(m, kind), selected: m === sw.desired })),
    )}</select>`,
    name,
  );
}

/** The current value is the placeholder, so the field reads as the value until something is typed. */
function knobControl(k: KnobView, back: string): string {
  const unit = k.unit ? ` ${k.unit}` : "";
  const chars = Math.max(2, num(k.max).length, num(k.value).length);
  const hint = `${num(k.min)}–${num(k.max)}${unit}, default ${num(k.default)}${unit}`;
  return inlineForm(
    k.target,
    back,
    `<label class="field"><input name="value" type="number" inputmode="decimal" min="${esc(
      k.min,
    )}" max="${esc(k.max)}" step="${k.int ? "1" : "any"}" required placeholder="${esc(num(k.value))}" title="${esc(
      hint,
    )}" aria-label="${esc(k.label)}" style="width:calc(${chars}ch + 18px)">${
      unit ? `<span>${esc(unit.trim())}</span>` : ""
    }</label>`,
    k.label,
  );
}

/** A knob's value, editable in place when `edit` is the page to come back to. */
export function knobSetting(k: KnobView, edit: string | null): string {
  if (edit) return `${knobControl(k, edit)}${sourceNote(k.source)}`;
  return `${esc(num(k.value))}${k.unit ? ` ${esc(k.unit)}` : ""}${sourceNote(k.source)}`;
}

export function knobRow(k: KnobView, edit: string | null): string {
  return controlRow({ name: k.label, hover: k.target, value: knobSetting(k, edit) });
}

/** A slice can only be capped below its stage, or follow it (no override set). */
export function sliceControl(
  stage: StageView,
  slice: { target: string; label: string; override: string | null },
  back: string,
): string {
  return modeControl(
    {
      target: slice.target,
      modes: [INHERIT, ...stage.modes.slice(0, -1)],
      desired: slice.override ?? INHERIT,
    },
    "stage",
    back,
    `${stage.label} for ${slice.label}`,
  );
}
