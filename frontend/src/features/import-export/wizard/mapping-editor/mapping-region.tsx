'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';
import type { FieldOption } from '../mapping-region-types';
import type {
  ColumnMapping,
  TransformationKind,
  TransformationSpec,
  WizardContract,
} from '../api/wizard-contract.types';

/**
 * One row per column of the file: what it should become, and what is done to it.
 *
 * The design principle throughout is that a proposal must be **checkable**. The
 * editor guesses, and a guess the person cannot verify is worse than no guess:
 * they accept it, it is wrong, and nobody finds out until the catalogue is. So
 * every proposal shows its confidence and the reasons behind it, and every
 * column carries a visible state — mapped, ignored, or still undecided.
 *
 * "Undecided" is a first-class state rather than a default. A column nobody
 * looked at is how a price column silently goes missing from an import.
 */

export type { FieldOption } from '../mapping-region-types';

export function MappingRegion({
  columns,
  fieldOptions,
  contract,
  focusedColumnIndex,
  onFocusColumn,
  onAssignField,
  onIgnoreColumn,
  onAddTransformation,
  onRemoveTransformation,
  onMoveTransformation,
  onSetOption,
}: {
  columns: ColumnMapping[];
  fieldOptions: FieldOption[];
  contract: WizardContract | null;
  focusedColumnIndex: number | null;
  onFocusColumn: (columnIndex: number | null) => void;
  onAssignField: (columnIndex: number, field: string | null) => void;
  onIgnoreColumn: (columnIndex: number) => void;
  onAddTransformation: (columnIndex: number, kind: TransformationKind) => void;
  onRemoveTransformation: (columnIndex: number, at: number) => void;
  onMoveTransformation: (columnIndex: number, from: number, to: number) => void;
  onSetOption: (columnIndex: number, at: number, option: string, value: unknown) => void;
}) {
  const claimed = new Map<string, number>();
  for (const column of columns) {
    const resolved = column.field;
    if (resolved) claimed.set(resolved, (claimed.get(resolved) ?? 0) + 1);
  }

  if (columns.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">Choose a file to see its columns here.</p>;
  }

  return (
    <ul className="divide-y divide-slate-100" data-testid="mapping-columns">
      {columns.map((column) => (
        <ColumnRow
          key={column.columnIndex}
          column={column}
          fieldOptions={fieldOptions}
          contract={contract}
          duplicated={Boolean(column.field && (claimed.get(column.field) ?? 0) > 1)}
          expanded={focusedColumnIndex === column.columnIndex}
          onToggleExpanded={() =>
            onFocusColumn(focusedColumnIndex === column.columnIndex ? null : column.columnIndex)
          }
          onAssignField={onAssignField}
          onIgnoreColumn={onIgnoreColumn}
          onAddTransformation={onAddTransformation}
          onRemoveTransformation={onRemoveTransformation}
          onMoveTransformation={onMoveTransformation}
          onSetOption={onSetOption}
        />
      ))}
    </ul>
  );
}

function ColumnRow({
  column,
  fieldOptions,
  contract,
  duplicated,
  expanded,
  onToggleExpanded,
  onAssignField,
  onIgnoreColumn,
  onAddTransformation,
  onRemoveTransformation,
  onMoveTransformation,
  onSetOption,
}: {
  column: ColumnMapping;
  fieldOptions: FieldOption[];
  contract: WizardContract | null;
  duplicated: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onAssignField: (columnIndex: number, field: string | null) => void;
  onIgnoreColumn: (columnIndex: number) => void;
  onAddTransformation: (columnIndex: number, kind: TransformationKind) => void;
  onRemoveTransformation: (columnIndex: number, at: number) => void;
  onMoveTransformation: (columnIndex: number, from: number, to: number) => void;
  onSetOption: (columnIndex: number, at: number, option: string, value: unknown) => void;
}) {
  const selectId = `field-${column.columnIndex}`;
  const chain = column.transformations ?? [];
  const undecided = column.field === null && !column.reviewed;

  return (
    <li className={cn('py-3', undecided && 'bg-amber-50/60')} data-testid={`column-${column.columnIndex}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-800" title={column.header}>
            {column.header || <span className="italic text-slate-400">(no heading)</span>}
          </p>
          <ColumnStatus column={column} undecided={undecided} duplicated={duplicated} />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            What should the column “{column.header}” become?
          </label>
          <select
            id={selectId}
            value={column.field ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              if (value === '') onIgnoreColumn(column.columnIndex);
              else onAssignField(column.columnIndex, value);
            }}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            {/* Ignoring is offered as a choice in the same control as mapping,
                because it IS the same decision — not an afterthought reached
                through a separate button. */}
            <option value="">Do not import this column</option>
            {fieldOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.required ? ' (required)' : ''}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-controls={`transformations-${column.columnIndex}`}
            className="rounded border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            {chain.length > 0 ? `${chain.length} step${chain.length === 1 ? '' : 's'}` : 'Clean up'}
          </button>
        </div>
      </div>

      {expanded ? (
        <div id={`transformations-${column.columnIndex}`} className="mt-3 rounded bg-slate-50 p-3">
          <TransformationChain
            columnIndex={column.columnIndex}
            chain={chain}
            contract={contract}
            disabled={column.field === null}
            onAdd={onAddTransformation}
            onRemove={onRemoveTransformation}
            onMove={onMoveTransformation}
            onSetOption={onSetOption}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The line under each column heading that says where it stands.
 *
 * Confidence is written as words as well as a number. "84%" alone invites
 * someone to treat a coin-flip as a fact; "a fair guess — 84%" does not.
 */
function ColumnStatus({
  column,
  undecided,
  duplicated,
}: {
  column: ColumnMapping;
  undecided: boolean;
  duplicated: boolean;
}) {
  if (duplicated) {
    return (
      <p className="text-xs font-semibold text-rose-700">
        Another column is also mapped to this field. Only one column can fill it.
      </p>
    );
  }
  if (undecided) {
    return <p className="text-xs font-semibold text-amber-800">Still needs a decision.</p>;
  }
  if (column.field === null) {
    return <p className="text-xs text-slate-500">Will not be imported.</p>;
  }

  const reasons = column.reasons ?? [];
  return (
    <div className="text-xs text-slate-600">
      {column.confidence !== undefined ? (
        <span className="font-medium">{describeConfidence(column.confidence)}</span>
      ) : null}
      {reasons.length > 0 ? (
        // The reasons are what make a proposal checkable rather than something
        // to be accepted on faith.
        <span> — {reasons.join('; ')}</span>
      ) : null}
    </div>
  );
}

export function describeConfidence(confidence: number): string {
  const percent = Math.round(confidence * 100);
  if (confidence >= 0.9) return `Confident — ${percent}%`;
  if (confidence >= 0.7) return `Fairly sure — ${percent}%`;
  if (confidence >= 0.4) return `Uncertain — ${percent}%, please check`;
  return `A guess — ${percent}%, please check`;
}

function TransformationChain({
  columnIndex,
  chain,
  contract,
  disabled,
  onAdd,
  onRemove,
  onMove,
  onSetOption,
}: {
  columnIndex: number;
  chain: { kind: TransformationKind; options?: Record<string, unknown> }[];
  contract: WizardContract | null;
  disabled: boolean;
  onAdd: (columnIndex: number, kind: TransformationKind) => void;
  onRemove: (columnIndex: number, at: number) => void;
  onMove: (columnIndex: number, from: number, to: number) => void;
  onSetOption: (columnIndex: number, at: number, option: string, value: unknown) => void;
}) {
  const specs = contract?.transformations ?? [];
  const specFor = (kind: TransformationKind) => specs.find((s) => s.kind === kind);

  if (disabled) {
    return <p className="text-xs text-slate-500">Choose what this column becomes before cleaning up its values.</p>;
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {chain.map((step, index) => {
          const spec = specFor(step.kind);
          return (
            <li key={`${step.kind}-${index}`} className="rounded border border-slate-200 bg-white p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">
                    {index + 1}. {spec?.label ?? step.kind}
                  </p>
                  {/* An operation the server does not describe is one this
                      build cannot run. Saying so here beats failing later. */}
                  {spec ? (
                    <p className="text-xs text-slate-500">{spec.description}</p>
                  ) : (
                    <p className="text-xs font-semibold text-rose-700">
                      This step is not available on this version. Remove it before continuing.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => onMove(columnIndex, index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move ${spec?.label ?? step.kind} earlier`}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(columnIndex, index, index + 1)}
                    disabled={index === chain.length - 1}
                    aria-label={`Move ${spec?.label ?? step.kind} later`}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(columnIndex, index)}
                    aria-label={`Remove ${spec?.label ?? step.kind}`}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {spec && spec.options.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {spec.options.map((option) => (
                    <OptionField
                      key={option.name}
                      columnIndex={columnIndex}
                      stepIndex={index}
                      spec={spec}
                      option={option}
                      value={step.options?.[option.name]}
                      onSetOption={onSetOption}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <AddStep specs={specs} onAdd={(kind) => onAdd(columnIndex, kind)} columnIndex={columnIndex} />
    </div>
  );
}

function OptionField({
  columnIndex,
  stepIndex,
  spec,
  option,
  value,
  onSetOption,
}: {
  columnIndex: number;
  stepIndex: number;
  spec: TransformationSpec;
  option: TransformationSpec['options'][number];
  value: unknown;
  onSetOption: (columnIndex: number, at: number, option: string, value: unknown) => void;
}) {
  const id = `opt-${columnIndex}-${stepIndex}-${option.name}`;
  const helpId = option.help ? `${id}-help` : undefined;
  const current = value ?? option.default ?? '';

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {option.label}
      </label>

      {option.type === 'CHOICE' ? (
        <select
          id={id}
          aria-describedby={helpId}
          value={String(current)}
          onChange={(event) => onSetOption(columnIndex, stepIndex, option.name, event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        >
          {(option.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : option.type === 'BOOLEAN' ? (
        <input
          id={id}
          type="checkbox"
          aria-describedby={helpId}
          checked={Boolean(current)}
          onChange={(event) => onSetOption(columnIndex, stepIndex, option.name, event.target.checked)}
          className="mt-1"
        />
      ) : (
        <input
          id={id}
          type={option.type === 'NUMBER' ? 'number' : 'text'}
          aria-describedby={helpId}
          value={String(current)}
          onChange={(event) =>
            onSetOption(
              columnIndex,
              stepIndex,
              option.name,
              option.type === 'NUMBER' ? Number(event.target.value) : event.target.value,
            )
          }
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        />
      )}

      {option.help ? (
        <p id={helpId} className="mt-1 text-xs text-slate-500">
          {option.help}
        </p>
      ) : null}

      {/* The worked example travels with the operation, so the effect is
          visible without anyone having to try it on their own data. */}
      <p className="mt-1 text-xs text-slate-400">
        Example: <span className="font-mono">{spec.example.before || '(empty)'}</span> →{' '}
        <span className="font-mono">{spec.example.after}</span>
      </p>
    </div>
  );
}

function AddStep({
  specs,
  onAdd,
  columnIndex,
}: {
  specs: TransformationSpec[];
  onAdd: (kind: TransformationKind) => void;
  columnIndex: number;
}) {
  const id = `add-step-${columnIndex}`;
  const groups = ['TEXT', 'NUMBER', 'DATE', 'LIST', 'VALUE'] as const;

  if (specs.length === 0) {
    // The contract has not arrived. Offering a hardcoded list here is exactly
    // the Phase 8 mistake: the editor would promise something this deployment
    // might not be able to do.
    return <p className="text-xs text-slate-500">Loading the available clean-up steps…</p>;
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        Add a clean-up step
      </label>
      <select
        id={id}
        value=""
        onChange={(event) => {
          if (event.target.value) onAdd(event.target.value as TransformationKind);
        }}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      >
        <option value="">Choose a step…</option>
        {groups.map((group) => {
          const inGroup = specs.filter((s) => s.group === group);
          if (inGroup.length === 0) return null;
          return (
            <optgroup key={group} label={GROUP_LABELS[group]}>
              {inGroup.map((spec) => (
                <option key={spec.kind} value={spec.kind}>
                  {spec.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

const GROUP_LABELS: Record<'TEXT' | 'NUMBER' | 'DATE' | 'LIST' | 'VALUE', string> = {
  TEXT: 'Text',
  NUMBER: 'Numbers',
  DATE: 'Dates',
  LIST: 'Lists',
  VALUE: 'Values',
};
