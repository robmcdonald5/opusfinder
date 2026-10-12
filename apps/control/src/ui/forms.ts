import { INHERIT, type KnobView, type StageView, type ValueSource } from "@opusfinder/control";

import { controlRow } from "./components";
import { esc, num } from "./format";
import { modeLabel, sourceNote, type ModeKind } from "./vocab";

/** The server re-validates every change (classify(), parseValue()); the HTML limits only catch typos early. */

/** Where /ui/change may redirect: panel pages only, never an arbitrary URL. */
export const BACK_PATH = /^\/(?:stages(?:\/[a-z0-9_]+)?|health)?$/;

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
 * `from` is the value shown: the server applies nothing if it has moved since the page loaded.
 */
function inlineForm(
  target: string,
  from: string,
  back: string,
  field: string,
  name: string,
): string {
  return `<form class="sw" method="post" action="/ui/change" autocomplete="off">${field}<button type="submit" class="go primary" aria-label="Confirm the change to ${esc(
    name,
  )}">Confirm</button><button type="reset" class="go">Cancel</button>${hidden("target", target)}${hidden(
    "from",
    from,
  )}${hidden("back", back)}</form>`;
}

/** `name` is plain text: what the dropdown sets, for its accessible name. */
export function modeControl(
  sw: { target: string; modes: readonly string[]; desired: string; source?: ValueSource },
  kind: ModeKind,
  back: string,
  name: string,
): string {
  // An unreadable value, or one this dropdown doesn't offer, shows as a placeholder, so the dropdown still
  // reads the value and any pick, the same mode included, is a change that gets a Confirm.
  const listed = sw.source !== "invalid" && sw.modes.includes(sw.desired);
  return inlineForm(
    sw.target,
    sw.desired,
    back,
    `<select name="value" aria-label="${esc(name)}">${
      listed
        ? ""
        : `<option value="${esc(sw.desired)}" selected disabled hidden>${esc(modeLabel(sw.desired, kind))}</option>`
    }${options(
      sw.modes.map((m) => ({
        value: m,
        label: modeLabel(m, kind),
        selected: listed && m === sw.desired,
      })),
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
    String(k.value),
    back,
    `<label class="field"><input name="value" type="number" inputmode="decimal" min="${esc(
      k.min,
    )}" max="${esc(k.max)}" step="${k.int ? "1" : "any"}" required placeholder="${esc(num(k.value))}" title="${esc(
      hint,
    )}" aria-label="${esc(k.label)}" style="width:${chars}ch">${
      unit ? `<span>${esc(unit.trim())}</span>` : ""
    }</label>`,
    k.label,
  );
}

/** A knob's value, editable in place when `edit` is the page to come back to. */
function knobSetting(k: KnobView, edit: string | null): string {
  if (edit) return `${knobControl(k, edit)}${sourceNote(k.source)}`;
  return `${esc(num(k.value))}${k.unit ? ` ${esc(k.unit)}` : ""}${sourceNote(k.source)}`;
}

export function knobRow(k: KnobView, edit: string | null): string {
  return controlRow({ name: k.label, hover: k.target, value: knobSetting(k, edit) });
}

/** A slice can only be capped below its stage, or follow it (no override set). */
export function sliceControl(
  stage: StageView,
  slice: { target: string; label: string; override: string | null; source?: ValueSource },
  back: string,
): string {
  return modeControl(
    {
      target: slice.target,
      modes: [INHERIT, ...stage.modes.slice(0, -1)],
      desired: slice.override ?? INHERIT,
      source: slice.source,
    },
    "stage",
    back,
    `${stage.label} for ${slice.label}`,
  );
}
