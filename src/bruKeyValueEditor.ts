/**
 * Shared editable key/value table (Headers, Environment, Params).
 */

import { setIcon } from "obsidian";
import { BruKeyValue } from "./bruParser";

export interface EditableKeyValueOptions {
  keyPlaceholder: string;
  valuePlaceholder: string;
  addAriaLabel: string;
  removeLabel: string;
  /** Headers/params use a leading enabled checkbox column. */
  showEnabledColumn?: boolean;
  /** When set, shows the resolved value below the input (Bruno/Postman-style). */
  resolveDisplayValue?: (raw: string) => string;
  /** Called after the key field changes (e.g. rename `:path` in URL). */
  onKeyChange?: (entry: BruKeyValue, previousKey: string) => void;
  onChange: () => void;
}

export function renderEditableKeyValueTable(
  container: HTMLElement,
  entries: BruKeyValue[],
  opts: EditableKeyValueOptions,
): void {
  const showEnabled = opts.showEnabledColumn ?? true;
  const table = container.createEl("table", {
    cls: showEnabled
      ? "bru-kv-table bru-kv-table-editable"
      : "bru-kv-table bru-kv-table-editable bru-kv-table-no-enabled",
  });

  const renderRows = () => {
    table.empty();
    if (!entries.length) {
      entries.push({ key: "", value: "", enabled: true });
    }

    entries.forEach((entry, index) => {
      const tr = table.createEl("tr");
      if (!entry.enabled) tr.addClass("bru-disabled");

      if (showEnabled) {
        const enabledTd = tr.createEl("td", { cls: "bru-kv-enabled-cell" });
        const enabledCb = enabledTd.createEl("input", {
          type: "checkbox",
          cls: "bru-kv-enabled",
        });
        enabledCb.checked = entry.enabled;
        enabledCb.addEventListener("change", () => {
          entry.enabled = enabledCb.checked;
          tr.toggleClass("bru-disabled", !entry.enabled);
          opts.onChange();
        });
      }

      const keyTd = tr.createEl("td", { cls: "bru-key" });
      const keyInput = keyTd.createEl("input", {
        type: "text",
        cls: "bru-field-input",
        attr: { placeholder: opts.keyPlaceholder },
      });
      keyInput.value = entry.key;
      keyInput.addEventListener("input", () => {
        const previousKey = entry.key;
        entry.key = keyInput.value;
        opts.onKeyChange?.(entry, previousKey);
        opts.onChange();
      });

      const valueTd = tr.createEl("td", { cls: "bru-value bru-value-cell" });
      const valueInput = valueTd.createEl("input", {
        type: "text",
        cls: "bru-field-input",
        attr: { placeholder: opts.valuePlaceholder },
      });
      valueInput.value = entry.value;
      valueInput.dataset.rawValue = entry.value;

      const resolvedPreview = valueTd.createDiv({
        cls: "bru-param-resolved",
      });
      resolvedPreview.hidden = true;

      const syncResolvedPreview = () => {
        valueInput.dataset.rawValue = entry.value;
        if (!opts.resolveDisplayValue) {
          resolvedPreview.hidden = true;
          return;
        }
        const resolved = opts.resolveDisplayValue(entry.value);
        if (resolved !== entry.value && resolved.length > 0) {
          resolvedPreview.setText(resolved);
          resolvedPreview.hidden = false;
        } else {
          resolvedPreview.hidden = true;
        }
      };

      syncResolvedPreview();
      valueInput.addEventListener("input", () => {
        entry.value = valueInput.value;
        syncResolvedPreview();
        opts.onChange();
      });

      const actionTd = tr.createEl("td", { cls: "bru-kv-action-cell" });
      const removeBtn = actionTd.createEl("button", {
        cls: "clickable-icon bru-kv-remove",
        attr: { "aria-label": opts.removeLabel },
      });
      setIcon(removeBtn, "trash-2");
      removeBtn.addEventListener("click", () => {
        entries.splice(index, 1);
        renderRows();
        opts.onChange();
      });
    });
  };

  renderRows();

  const actions = container.createDiv({ cls: "bru-kv-actions" });
  const addBtn = actions.createEl("button", {
    cls: "clickable-icon bru-kv-add",
    attr: { "aria-label": opts.addAriaLabel },
  });
  setIcon(addBtn, "plus");
  addBtn.addEventListener("click", () => {
    entries.push({ key: "", value: "", enabled: true });
    renderRows();
    opts.onChange();
    const inputs = table.querySelectorAll<HTMLInputElement>(".bru-field-input");
    inputs[inputs.length - 2]?.focus();
  });
}
