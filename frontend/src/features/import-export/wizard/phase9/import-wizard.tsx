'use client';

import React from 'react';
import { MappingEditor } from '../mapping-editor/mapping-editor';
import { fieldCatalogueFor, unsupportedFields } from './field-catalogue';
import {
  initialMappingState,
  mappingReducer,
  type ImportType,
  type MappingState,
} from '../mapping/mapping-state';
import { wizardService } from '../api/wizard.service';
import type { TableMapping } from '../api/wizard-contract.types';
import {
  clearProgress,
  describeProgress,
  loadProgress,
  pruneExpired,
  restorableFrom,
  saveProgress,
  type ProgressStorage,
  type SavedProgress,
} from '../mapping/progress-store';
import {
  incompatibilities,
  isUserEdit,
  mayAutosave,
  type Hydration,
  type ProgressScope,
} from '../mapping/progress-hydration';
import { decodeWizardLocation, encodeWizardLocation, resolveLink, type WizardLocation } from '../mapping/wizard-location';
import { lifecycleService, type PlanLifecycle, type StoredPlan } from '../api/lifecycle.service';
import { RunPanel } from '../run/run-panel';
import { proofIsHeld, type RunState } from '../run/run-machine';
import { decisionIdentity } from '../run/decision-identity';
import { projectPlanActions, type InFlight, type PlanSurface } from '../run/plan-actions';
import { PlanSurfaceView } from '../run/plan-surface';
import { SourcePicker, type SourcePickerClient } from './source-picker';
import { RelationshipSummary } from './relationship-summary';
import {
  RelationshipsStep,
  questionsFor,
  type RelationshipDecisions,
} from './relationships-step';
import type { RelationshipOptions } from '../api/lifecycle.service';
import { evaluateProgression, canBuildPlan, sectionDomId, type ProgressionState } from './progression';
import { normalizeRelationships } from './relationship-contract';
import { useImportRun, type LifecycleClient } from '../run/use-import-run';
import { editorReadiness, mappingForRequest } from '../mapping/mapping-state';

/**
 * The real import wizard.
 *
 * This replaces the Phase 8 rehearsal, which rendered every number from a local
 * fixture and issued no request at all. That was the right shape for a
 * rehearsal and the wrong shape for an importer: a wizard whose choices come
 * from a file in the bundle can offer an operation the server would refuse, and
 * can show a preview the server never computed.
 *
 * So everything shown here comes from the server. The operations the editor
 * offers arrive from `GET /import/wizard/contract`; the preview of what would
 * be written is computed by the same function that will run at validation time
 * before execution. The fixtures survive as deterministic test data and are
 * imported by no file that runs in the browser.
 *
 * The wizard still writes nothing on its own. Mapping and previewing are
 * read-only; the only thing that mutates a catalogue is an execution, which
 * needs an approval this screen deliberately does not grant.
 */

export type WizardAvailability =
  /** The caller may build and run imports. */
  | 'ALLOWED'
  /** Signed in, but this role may not import. */
  | 'FORBIDDEN'
  /** Imports are configured off — the private bucket is not provisioned yet. */
  | 'UNAVAILABLE';

export interface WizardBootstrap {
  availability: WizardAvailability;
  /** Why imports are unavailable, in tenant-facing words. Never operator detail. */
  unavailableReason?: string;
  token: string;
  /*
    No `fieldOptions`.

    The route used to hand the wizard a catalogue, and handed it the products
    one for every import type. A prop that CAN disagree with the import type
    is the defect; the catalogue is a function of the type and is derived from
    it below, where nothing can pass a different one in.
  */
  /** Where the wizard was pointed, decoded from the URL. */
  location?: WizardLocation;
  sourceStatus?: 'AVAILABLE' | 'EXPIRED' | 'MISSING' | 'FORBIDDEN' | 'NONE' | 'CANCELLED';
  storage?: ProgressStorage | null;
  now?: () => number;
  /** The shop a store-scoped import belongs to. Required for historical sales. */
  storeId?: string;
  /** Shown so nobody imports into the wrong company or branch by accident. */
  organizationName?: string | null;
  storeName?: string | null;
  /** Injected in tests so the journey can be driven without a server. */
  lifecycle?: LifecycleClient &
    Pick<typeof lifecycleService, 'getAnalysis' | 'startAnalysis' | 'relationshipOptions'> &
    /**
     * Optional so that a test double need not provide it. Where it IS provided
     * the file's content hash pins saved decisions to the exact bytes they were
     * made against; where it is not, that one check stands down and the other
     * seven still run. Absence must never be mistaken for agreement, so a
     * missing hash compares as "unknown" rather than as "the same".
     */
    Partial<Pick<typeof lifecycleService, 'getSource'>> &
    /**
     * Required, unlike `getSource`. Cancelling is an action the wizard OFFERS,
     * and offering a control whose handler might not exist is exactly the dead
     * optional prop this stage was rejected for.
     */
    Pick<typeof lifecycleService, 'cancelSource'> &
    /** Reading a stored plan for review. */
    Partial<Pick<typeof lifecycleService, 'getPlan' | 'planLifecycle' | 'withdrawApproval'>>;
  /** How often the analysis and the run are asked for their status. */
  pollIntervalMs?: number;
  /**
   * How long to wait for an analysis before calling it stalled. Generous by
   * default: the runner ticks every two minutes, so a normal wait is well under
   * this and anything past it is worth a person's attention.
   */
  analysisDeadlineMs?: number;
  /**
   * How long to wait for a preview before calling it a failure.
   *
   * Bounded because the alternative was observed in production: an editor
   * reporting "Waiting for the preview." with nothing in flight and no way out.
   */
  previewTimeoutMs?: number;
  /** Client-side route transition supplied by the Next route. */
  navigate?: (href: string) => void;
}

/**
 * The client phase, reduced to what it is still allowed to say.
 *
 * A phase describes a request THIS browser has sent and not yet had answered.
 * It is presentation — a spinner beats a screen that looks idle while a write
 * is being authorised — and since this correction it decides no capability.
 */
function planInFlight(run: RunState): InFlight {
  switch (run.phase) {
    case 'PLANNING':
      return 'PLANNING';
    case 'APPROVING':
      return 'APPROVING';
    case 'STARTING':
      return 'STARTING';
    case 'CANCELLING':
      return 'CANCELLING';
    default:
      return 'NONE';
  }
}

export function Phase9ImportWizard({
  availability,
  unavailableReason,
  token,
  location = {},
  sourceStatus = 'NONE',
  storage = typeof window === 'undefined' ? null : window.localStorage,
  now = () => Date.now(),
  storeId,
  organizationName,
  storeName,
  lifecycle = lifecycleService,
  pollIntervalMs = 2000,
  analysisDeadlineMs = 5 * 60 * 1000,
  previewTimeoutMs = 20_000,
  navigate = (href) => window.history.pushState(window.history.state, '', href),
}: WizardBootstrap) {
  /**
   * The type the LINK claims, which is a hint and never an answer.
   *
   * On a plan route the answer belongs to the plan — see `resolvedType` below.
   * This value seeds the reducer so that the no-plan flows (upload, mapping a
   * fresh file) behave as they always have, and it is overruled the moment the
   * server speaks.
   */
  const hintedType: ImportType = location.importType ?? 'PRODUCTS';
  // The link as the URL and the page describe it. The server may know better —
  // see `link` below — but hydration and the source fetch need an id before
  // any request has come back.
  /**
   * Every reducer action, watched for whether a PERSON made it.
   *
   * After a discard, autosave is blocked until somebody genuinely edits
   * something — otherwise clearing the entry re-fires the autosave effect (the
   * hydration state is one of its dependencies) and the draft is written
   * straight back. The wizard's own housekeeping actions must not count, so
   * the decision is made from the action type rather than from timing.
   */
  const dispatch = React.useCallback((action: Parameters<typeof rawDispatch>[0]) => {
    if (isUserEdit((action as { type: string }).type)) {
      setHydration((current) => (current.kind === 'DISCARDED_UNTOUCHED' ? { kind: 'DIRTY_AFTER_DISCARD' } : current));
    }
    rawDispatch(action);
  }, []);

  const requestedLink = resolveLink(location, sourceStatus);
  const sourceId = requestedLink.kind === 'OPEN' ? requestedLink.sourceId : null;

  const [state, rawDispatch] = React.useReducer(mappingReducer, hintedType, initialMappingState);
  // Before a source exists there is no mapping for a type change to invalidate,
  // so the choice lives here rather than in the reducer. Once the source is
  // registered the type travels in the link, and the reducer owns it.
  const [pendingType, setPendingType] = React.useState<ImportType>(hintedType);
  // Read from storage DURING the first render, not in an effect.
  //
  // This is the whole shape of the bug it fixes. The read used to happen in an
  // effect, alongside a save that ran in another effect, and effects do not
  // promise an order — so the save could observe an empty relationship state
  // and write `{}` over the saved decisions before the read had produced an
  // offer for anybody to accept. Reading first, synchronously, makes that
  // race impossible rather than unlikely.
  const [hydration, setHydration] = React.useState<Hydration>(() =>
    readHydration(storage ?? null, sourceId, now),
  );
  const hydratedFor = React.useRef<string | null>(sourceId);
  // The file's bytes, so saved decisions can be pinned to them. Its own state
  // rather than a nullable value, because "not fetched yet" and "fetched and
  // there is none" must not both read as null while compatibility is judged.
  const [sourceIdentity, setSourceIdentity] = React.useState<{
    state: 'LOADING' | 'SETTLED';
    hash: string | null;
    status: string | null;
  }>({ state: 'LOADING', hash: null, status: null });

  /**
   * What the link resolves to once the SERVER has been asked.
   *
   * The route cannot know a file was cancelled — it decides `AVAILABLE` from
   * the presence of an id in the URL — so a cancelled import reopened from a
   * bookmark went straight back to the editor as though the decision to end it
   * had never been made. The server's answer overrides the URL's optimism.
   */
  const link =
    sourceIdentity.status === 'CANCELLED' ? resolveLink(location, 'CANCELLED') : requestedLink;
  const [analysis, setAnalysis] = React.useState<{ id: string; status: string; failureReason?: string | null } | null>(
    null,
  );
  // How long we have been waiting, so the screen can say so rather than spin.
  const [waitedMs, setWaitedMs] = React.useState(0);
  // Bumped to re-run the analysis effect when somebody asks to keep waiting.
  const [watchAttempt, setWatchAttempt] = React.useState(0);
  // The three relationship decisions, and whether each was confirmed. Held
  // beside the mapping and persisted with it: a reload that lost them would
  // silently drop a custody choice somebody had already made.
  const [rawRelationships, setRelationships] = React.useState<RelationshipDecisions>({});
  /*
    The decisions this import type may actually carry.

    Normalised at the single point every consumer reads, rather than at each
    call site, because the ones that matter are easy to miss: the plan request,
    the autosave, and the decisions key the plan hash is computed over. A
    mapping saved while a file was being imported as products and reopened as
    historical sales would otherwise carry the old `stores` and `categories`
    answers straight back into the new plan's hash — silently, since the
    questions that produced them are no longer on screen.
  */
  const relationships = React.useMemo(
    () => normalizeRelationships(state.importType, rawRelationships),
    [state.importType, rawRelationships],
  );
  // No `confirmed` state any more. Selecting IS confirming; a second tick that
  // restated the first is what made the plan unbuildable from a control the
  // operator could not see.
  const [options, setOptions] = React.useState<RelationshipOptions | null>(null);
  // Three distinct states, because they call for three different responses:
  // still loading, could not load, and loaded but the company has nothing to
  // offer. Collapsing the last two would tell somebody to configure a location
  // when in fact the request simply failed.
  const [optionsState, setOptionsState] = React.useState<'LOADING' | 'READY' | 'FAILED'>('LOADING');
  const [optionsAttempt, setOptionsAttempt] = React.useState(0);
  // Which preview request is the current one. A late answer from an abandoned
  // attempt must not overwrite what is on screen.
  const previewGeneration = React.useRef(0);
  const [previewAttempt, setPreviewAttempt] = React.useState(0);
  /**
   * A stored plan opened for review, rather than a file opened for mapping.
   *
   * The listing said "Ready to review" and routed back to the mapping editor,
   * which then waited for a preview of decisions that were already settled and
   * already on the server. Reviewing a plan reads the plan; it does not remap
   * the file.
   */
  const [planReview, setPlanReview] = React.useState<{
    state: 'LOADING' | 'READY' | 'FAILED';
    lifecycle: PlanLifecycle | null;
    plan: StoredPlan | null;
  }>({ state: 'LOADING', lifecycle: null, plan: null });
  const [editingMapping, setEditingMapping] = React.useState(false);
  // Bumped to re-read the plan after it changes underneath us.
  const [planReviewAttempt, setPlanReviewAttempt] = React.useState(0);
  const reviewPlanId = location.planId && !editingMapping ? location.planId : null;
  // Cancelling asks first. It ends a file somebody may have spent twenty
  // minutes on, and a single unguarded click at the bottom of a long form is
  // how that time gets lost.
  const [cancelStage, setCancelStage] = React.useState<'IDLE' | 'CONFIRMING' | 'WORKING' | 'DONE' | 'FAILED'>('IDLE');
  const [cancelMessage, setCancelMessage] = React.useState<string | null>(null);

  // The contract is fetched once. Until it arrives the editor says it is
  // loading rather than offering a guessed list of operations.
  React.useEffect(() => {
    if (availability !== 'ALLOWED') return;
    let cancelled = false;
    void wizardService
      .getContract(token)
      .then((contract) => {
        if (!cancelled) dispatch({ type: 'CONTRACT_LOADED', contract });
      })
      .catch(() => {
        // A missing contract is not fatal to the screen; the editor degrades to
        // "loading the available clean-up steps" rather than to a broken page.
      });
    return () => {
      cancelled = true;
    };
  }, [availability, token, dispatch]);

  // Entries that have aged out are removed on entry. Separate from the read
  // above, which happens during render: pruning WRITES, and a write during
  // render is the kind of thing that runs twice under a strict-mode remount.
  React.useEffect(() => {
    if (storage) pruneExpired(storage, now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  // A source that changes after mount — picked, or uploaded — gets its own
  // hydration. Without this the wizard would carry the previous source's
  // verdict, and `NONE` from a previous source would license autosave over
  // work saved for the new one.
  React.useEffect(() => {
    if (hydratedFor.current === sourceId) return;
    hydratedFor.current = sourceId;
    setHydration(readHydration(storage ?? null, sourceId, now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage, sourceId]);

  /**
   * Read the plan, and what may be done with it.
   *
   * Two reads, both authoritative and both refused for anyone else's plan:
   * the stored plan for what it says, and the lifecycle for what may be
   * offered. No analysis is started and no preview is requested — there is
   * nothing here to re-derive.
   */
  React.useEffect(() => {
    // `getPlan`/`planLifecycle` are optional so a test double need not carry
    // them; without them there is no review to open, and saying so beats
    // calling undefined.
    if (availability !== 'ALLOWED' || !reviewPlanId || !lifecycle.getPlan || !lifecycle.planLifecycle) return;
    let cancelled = false;
    setPlanReview({ state: 'LOADING', lifecycle: null, plan: null });
    const readLifecycle = lifecycle.planLifecycle;
    const readPlan = lifecycle.getPlan;
    void Promise.all([readLifecycle(token, reviewPlanId), readPlan(token, reviewPlanId)])
      .then(([life, plan]) => {
        if (cancelled) return;
        setPlanReview({ state: 'READY', lifecycle: life, plan });
        // The server's answer goes INTO the machine, not merely beside it.
        //
        // It used to be held only in this component's state, so the run hook's
        // handlers — which read the execution id from the machine — had nothing
        // to work with on a reopened plan. View results, Stop and Continue were
        // offered from this lifecycle and then looked somewhere that did not
        // have it. One holder of the server's answer, not two.
        dispatchRun({ type: 'LIFECYCLE_OBSERVED', lifecycle: life });
        // The server's plan becomes the ACTIVE plan.
        //
        // Without this the review screen held the plan and the run machine
        // held none, so `approve()` — which reads the machine's — returned at
        // its first line and the button did nothing at all. One active plan,
        // one approval path, whether it was just built or just loaded.
        dispatchRun({
          type: 'PLAN_LOADED',
          plan: {
            id: plan.id,
            planHash: plan.planHash,
            readiness: plan.summary?.readiness ?? { allowed: true },
            outstanding: 0,
            alreadyExisted: true,
          },
        });
      })
      .catch(() => {
        // Fails closed and visibly. A plan somebody may not see and a plan that
        // could not be loaded are the same answer here, deliberately.
        if (!cancelled) setPlanReview({ state: 'FAILED', lifecycle: null, plan: null });
      });
    return () => {
      cancelled = true;
    };
    // `dispatchRun` is declared from the run reducer below this resume effect.
    // The reducer dispatch is stable; naming it here would access the binding
    // before initialization during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, token, reviewPlanId, lifecycle, planReviewAttempt]);

  /*
    ------------------------------------------------------------------ the type

    What this import IS, as opposed to what the link says it is.

    A stored plan carries its own `importType`, set when it was built and
    unchangeable afterwards. Where one is loaded, that is the answer; the URL's
    `type` parameter is a hint that may be stale, absent or simply wrong, and it
    has no standing against the server's record.

    This mattered because the wizard had no way to find that out. The type was
    read from the URL once, at mount, into a reducer with no action that could
    revise it — so a plan reached by a link that had lost its `type` was a
    products import from then on, and every screen below agreed with it: the
    field catalogue, the relationship questions, the preview request, and the
    compatibility check that was supposed to stop stale products decisions from
    entering another type.
  */
  const planType: ImportType | null = planReview.plan?.importType ?? null;

  /**
   * True while a plan is being read and has not yet said what it is.
   *
   * The wizard renders NOTHING type-specific in this window. Showing the
   * products editor "for now" is the whole defect in miniature: a mapping
   * screen that is wrong for a second is a mapping screen somebody can click.
   */
  //
  // Conditioned on `availability` because the plan is not READ unless the
  // caller may import. Without that, a forbidden or unconfigured tenant would
  // wait forever on a request that was never sent, and be told a plan was
  // opening instead of being told they may not import.
  const typePending =
    availability === 'ALLOWED' && Boolean(location.planId) && planType === null && planReview.state !== 'FAILED';

  /** The authoritative type. The plan's where there is one, the link's otherwise. */
  const resolvedType: ImportType = planType ?? hintedType;

  /**
   * The link disagreed with the plan, or said nothing at all.
   *
   * Kept as state to be RENDERED, not just acted on. Silently rewriting the
   * address bar would leave somebody who followed a `type=PRODUCTS` link looking
   * at a historical-sales editor with no account of why, and "it corrected
   * itself" is not something a person can verify after the fact.
   */
  const typeCorrection =
    planType !== null && location.importType !== planType
      ? { hinted: location.importType ?? null, actual: planType }
      : null;

  // Tell the reducer, so everything derived from the type follows: the field
  // catalogue, the relationship questions, the preview request, the saved-work
  // compatibility check.
  React.useEffect(() => {
    if (planType) dispatch({ type: 'TYPE_RESOLVED', importType: planType });
  }, [planType, dispatch]);

  /*
    Canonicalise the address bar.

    `history.replaceState` rather than a router navigation: this is not going
    anywhere, it is correcting the description of where we already are, and a
    navigation would remount the wizard and re-read the plan to reach the same
    screen. Replacing rather than pushing keeps Back pointing where the reader
    came from instead of at the wrong link they arrived by.
  */
  React.useEffect(() => {
    if (!typeCorrection || typeof window === 'undefined') return;
    const corrected = encodeWizardLocation({ ...location, importType: typeCorrection.actual });
    if (window.location.search === corrected) return;
    window.history.replaceState(null, '', `${window.location.pathname}${corrected}`);
    // `location` is derived fresh from the URL on every render and would make
    // this effect self-triggering; the correction itself is what identifies the
    // work, so it is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeCorrection?.actual, typeCorrection?.hinted]);

  /**
   * Fields the stored plan maps that this import type cannot express.
   *
   * A plan is only ever built from a catalogue, so a non-empty answer means the
   * catalogue has changed underneath a stored plan — a field withdrawn because
   * the runner never read it, most likely. It is reported and blocks; the
   * alternative, quietly leaving those columns out of the editor, would show a
   * column as unmapped when the plan says otherwise and let the next save
   * rewrite the plan to match the screen.
   */
  const unsupported = React.useMemo(
    () => (planType ? unsupportedFields(planType, planReview.plan?.mapping?.columns) : []),
    [planType, planReview.plan],
  );

  // The file's bytes, so decisions can be pinned to them.
  React.useEffect(() => {
    if (availability !== 'ALLOWED' || !sourceId || !lifecycle.getSource) {
      setSourceIdentity({ state: 'SETTLED', hash: null, status: null });
      return;
    }
    let cancelled = false;
    setSourceIdentity({ state: 'LOADING', hash: null, status: null });
    void lifecycle
      .getSource(token, sourceId)
      .then((source) => {
        if (!cancelled) setSourceIdentity({ state: 'SETTLED', hash: source.contentHash, status: source.status });
      })
      .catch(() => {
        // A hash we could not read is UNKNOWN, not "matches". Settling with
        // null stands this one check down; it never manufactures agreement.
        if (!cancelled) setSourceIdentity({ state: 'SETTLED', hash: null, status: null });
      });
    return () => {
      cancelled = true;
    };
  }, [availability, token, sourceId, lifecycle]);

  // What the decisions on screen are currently being made against.
  const currentScope: ProgressScope = React.useMemo(
    () => ({
      sourceId: sourceId ?? '',
      importType: state.importType,
      sourceHash: sourceIdentity.hash,
      analysisId: analysis?.id ? analysis.id : null,
      sheet: state.mapping.sheet ?? null,
      headerRow: state.mapping.headerRow ?? null,
      headers: (state.mapping.columns ?? []).map((column) => column.header),
      storeId: storeId ?? null,
      locationIds: (options?.stockDestinations ?? []).map((destination) => destination.id),
      storeIds: (options?.stores ?? []).map((store) => store.id),
    }),
    [sourceId, state.importType, sourceIdentity.hash, analysis?.id, state.mapping, storeId, options],
  );

  // Enough has loaded to judge whether saved work still applies. Judging early
  // would compare decisions against an empty header list and reject everything.
  const scopeKnown =
    optionsState === 'READY' &&
    sourceIdentity.state === 'SETTLED' &&
    // The type must be settled BEFORE saved work is judged against it.
    //
    // `currentScope.importType` comes from the reducer, and while a plan is
    // still loading the reducer holds the LINK's hint. Comparing a saved
    // products mapping against that hint compares PRODUCTS to PRODUCTS and
    // finds nothing wrong — which is exactly how stale products decisions would
    // be restored into a historical-sales import. A guard is only a guard once
    // it has something authoritative to guard against.
    !typePending &&
    (state.mapping.columns?.length ?? 0) > 0;

  // Saved work that no longer describes this import is refused, not offered —
  // and refused OUT LOUD. Silently dropping it would leave somebody wondering
  // where their twenty minutes went; silently restoring it would put a custody
  // choice beside a file it was never reviewed against.
  React.useEffect(() => {
    if (!scopeKnown) return;
    if (hydration.kind !== 'OFFERED' && hydration.kind !== 'RESTORED') return;

    const saved = hydration.kind === 'OFFERED' ? hydration.saved.scope : hydration.scope;
    const reasons = incompatibilities(saved, currentScope);
    if (reasons.length === 0) return;

    // Removed as well as refused: an entry that cannot be restored must not
    // come back and ask again on the next reload.
    if (storage && sourceId) clearProgress(storage, sourceId);
    // Decisions that came from it go with it. Keeping them would leave the
    // wizard holding exactly the stale answers this check just refused.
    if (hydration.kind === 'RESTORED') setRelationships({});
    setHydration({ kind: 'INCOMPATIBLE', reasons });
  }, [scopeKnown, hydration, currentScope, storage, sourceId]);

  // Decisions are written down as they are made — but ONLY once it is settled
  // what was already there. The sample rows are never written: they are the
  // customer's prices and costs, and browser storage outlives the session by a
  // long way.
  React.useEffect(() => {
    if (!storage || link.kind !== 'OPEN' || state.mapping.columns.length === 0) return;
    // The gate. While storage is still being read, or while an offer is on
    // screen that nobody has answered, there is something here worth more than
    // what we would write over it.
    if (!mayAutosave(hydration)) return;
    saveProgress(storage, state, link.sourceId, now(), currentScope, { decisions: relationships });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    storage,
    hydration,
    currentScope,
    state.mapping,
    state.acknowledged,
    state.focusedRegion,
    state.focusedColumnIndex,
    relationships,
  ]);

  // What this caller may choose from. Fetched, never held locally — a
  // hardcoded location id is a cross-tenant bug waiting for a second customer.
  React.useEffect(() => {
    if (availability !== 'ALLOWED' || !sourceId) return;
    let cancelled = false;
    setOptionsState('LOADING');
    void lifecycle
      .relationshipOptions(token, storeId ?? null)
      .then((next) => {
        if (cancelled) return;
        setOptions(next);
        setOptionsState('READY');
      })
      .catch(() => {
        // Fails CLOSED. Without these choices a plan cannot be prepared
        // correctly, and offering empty pickers would invite somebody to
        // conclude their company has no locations when the request merely
        // failed.
        if (cancelled) return;
        setOptions(null);
        setOptionsState('FAILED');
      });
    return () => {
      cancelled = true;
    };
  }, [availability, token, sourceId, storeId, lifecycle, optionsAttempt]);

  // The analysis: start one, then watch it until it has read the file.
  //
  // Started rather than assumed, because a source can be opened from a link
  // long after its first analysis, and a source whose analysis failed should be
  // readable again rather than permanently stuck. The 409 a second live
  // analysis produces is not an error here — it means somebody else is already
  // reading the same file, and waiting is the right response.
  React.useEffect(() => {
    // Not while a stored plan is being reviewed. Its decisions are settled and
    // hashed; re-reading the file would be work nobody asked for, and a second
    // analysis of an immutable source is exactly what this wizard was built to
    // stop doing.
    if (availability !== 'ALLOWED' || !sourceId || reviewPlanId) return;
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const startedAt = now();

    const watch = (analysisId: string) => {
      void lifecycle
        .getAnalysis(token, analysisId)
        .then((current) => {
          if (cancelled) return;
          setAnalysis({ id: current.id, status: current.status, failureReason: current.failureReason });

          if (current.status === 'COMPLETED') {
            const tables = current.tables as {
              sample?: { headers: string[]; rows: string[][]; firstRowNumber: number; sheet?: string };
              columnTypes?: string[];
            } | null;
            const proposals = (current.proposals ?? []) as {
              columnIndex: number;
              header: string;
              field: string | null;
              confidence?: number;
              reasons?: string[];
            }[];
            if (!tables?.sample) return;
            dispatch({
              type: 'SOURCE_LOADED',
              sample: tables.sample,
              columnTypes: tables.columnTypes ?? [],
              // A proposal is a suggestion, never a decision: `reviewed` stays
              // false so every column still needs a person to look at it.
              proposals: proposals.map((p) => ({
                columnIndex: p.columnIndex,
                header: p.header,
                field: p.field,
                ...(p.confidence === undefined ? {} : { confidence: p.confidence }),
                ...(p.reasons?.length ? { reasons: p.reasons } : {}),
              })) as never,
            });
            return;
          }

          if (current.status === 'FAILED') return;

          // Bounded, not endless. The runner is driven by a scheduler tick, so
          // a wait of a minute or two is ordinary — but a wait with NO end is a
          // spinner somebody watches until they give up, having learned
          // nothing. Past the deadline this becomes a state with a name and an
          // action rather than more spinning.
          if (now() - startedAt > analysisDeadlineMs) {
            setAnalysis({ id: analysisId, status: 'STALLED' });
            return;
          }
          setWaitedMs(now() - startedAt);
          handle = setTimeout(() => watch(analysisId), pollIntervalMs);
        })
        .catch(() => {
          if (cancelled) return;
          if (now() - startedAt > analysisDeadlineMs) {
            setAnalysis({ id: analysisId, status: 'STALLED' });
            return;
          }
          handle = setTimeout(() => watch(analysisId), pollIntervalMs);
        });
    };

    void lifecycle
      .startAnalysis(token, sourceId)
      .then((started) => {
        if (!cancelled) watch(started.id);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error && error.message ? error.message : '';

        // "Already being read" is not a failure — somebody else holds it, and
        // waiting is the right response. Anything else IS a failure, and
        // showing "Reading your file…" over it would leave a person watching a
        // spinner for a file that will never be read.
        // A conflict used to park here as RUNNING with NO id — and `watch` is
        // driven by an id, so polling never started and the spinner never
        // ended. That is the defect this whole path exists to avoid, so an
        // analysis we cannot name is terminal and says so.
        if (/already being read/i.test(message)) {
          setAnalysis({
            id: '',
            status: 'STALLED',
            failureReason: 'This file is already being read, but we lost track of which reading. Reopen this import to pick it up.',
          });
          return;
        }
        setAnalysis({
          id: '',
          status: 'FAILED',
          failureReason: message || 'This file could not be read. Upload it again to continue.',
        });
      });

    return () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, token, sourceId, pollIntervalMs, analysisDeadlineMs, watchAttempt, reviewPlanId]);

  const { run, actions, dispatch: dispatchRun } = useImportRun(
    {
      token,
      sourceId: sourceId ?? '',
      importType: state.importType,
      mapping: mappingForRequest(state),
      sample: state.sample,
      columnTypes: state.columnTypes,
      storeId,
      acknowledgedIssueCodes: state.acknowledged,
      relationships,
    },
    { service: lifecycle, pollIntervalMs },
  );

  /**
   * The active plan's id, from wherever it came from.
   *
   * A ref rather than a dependency so the withdraw callback does not have to be
   * rebuilt — and so it reads the CURRENT plan rather than the one that existed
   * when the callback was created.
   */
  const runPlanIdRef = React.useRef<string | null>(null);
  runPlanIdRef.current = run.plan?.id ?? null;

  // Withdrawal is a single-flight mutation, like approval and execution. A
  // second press while the first is out would race the server's own revoke.
  const withdrawInFlight = React.useRef(false);
  const [withdrawing, setWithdrawing] = React.useState(false);

  // A REAL edit retracts the plan, for the same reason the mapping reducer
  // clears `approvalToken`: an approval attests to a specific plan, and a plan
  // is a hash of specific decisions.
  //
  // Keyed on the VALUE of those decisions, never on the identity of the objects
  // holding them. The previous version watched three references, which React
  // rebuilds on ordinary re-renders — so it retracted plans nobody had touched,
  // at moments nobody chose, including the window between an approval and the
  // lifecycle refetch that follows it. That is what stranded `bcdb9687…`.
  //
  // The reducer refuses this once an approval or a run exists, so the guard is
  // in two places on purpose: this one stops the dispatch happening, and that
  // one stops it mattering if some future caller reaches it another way.
  const decisionsKey = decisionIdentity({
    mapping: state.mapping,
    acknowledged: state.acknowledged,
    relationships,
  });
  const lastDecisionsKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    // The first render establishes the baseline. Treating it as a change would
    // retract a plan that has only just been loaded from the server.
    if (lastDecisionsKey.current === null) {
      lastDecisionsKey.current = decisionsKey;
      return;
    }
    if (lastDecisionsKey.current === decisionsKey) return;
    lastDecisionsKey.current = decisionsKey;
    dispatchRun({ type: 'PLAN_INVALIDATED' });
    // `dispatchRun` is a reducer dispatch and never changes identity. The
    // dependency list is deliberately the decisions KEY alone, because adding
    // anything object-shaped here is how the previous version came to fire on
    // re-renders that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionsKey]);

  // What the mapping and sample oblige this import to decide.
  const questions = React.useMemo(
    () => questionsFor(state.mapping.columns ?? [], state.sample?.rows ?? [], state.importType),
    [state.mapping, state.sample, state.importType],
  );
  const progression = evaluateProgression({ optionsState, questions, options, decisions: relationships });
  const relationshipsSettled = canBuildPlan(progression);

  /**
   * Warn before leaving while the one-time authorisation is held.
   *
   * A courtesy, NOT a guarantee. Browsers ignore this on a crash, a closed
   * laptop or a killed tab, and some suppress it without interaction — so the
   * recovery path above exists whether or not this ever fires, and correctness
   * never rests on it. It just means the common case, a deliberate reload,
   * stops costing somebody their approval.
   */
  React.useEffect(() => {
    if (typeof window === 'undefined' || !proofIsHeld(run)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers show their own wording; a non-empty value is what asks.
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [run]);

  /**
   * Withdraw an approval this browser can no longer use.
   *
   * A decision somebody makes and signs, not a repair applied behind their
   * back. On success the plan is re-read, so the screen shows the state the
   * SERVER now reports — PREPARED, approvable again — rather than one this
   * code inferred.
   */
  const withdrawApproval = React.useCallback(() => {
    // The plan id from EITHER entry: the URL when a stored plan was opened, and
    // the machine when this tab built one. Reading only the URL is why the
    // fresh-prepare path had a recovery panel it could never act on — the
    // handler returned at its first line, silently, exactly like the dead
    // Approve button before it.
    const planId = reviewPlanId ?? runPlanIdRef.current;
    const withdraw = lifecycle.withdrawApproval;
    // FAIL VISIBLY. A missing id or a client without the call is a named state
    // on screen, never a no-op.
    if (!planId || !withdraw) {
      dispatchRun({
        type: 'FAILED',
        message: !planId
          ? 'This approval could not be withdrawn because the plan is not loaded. Reopen it from your imports and try again.'
          : 'Withdrawing an approval is not available in this session. Reopen the import from your imports list.',
      });
      return;
    }
    if (withdrawInFlight.current) return;
    withdrawInFlight.current = true;
    setWithdrawing(true);
    void withdraw(token, planId, 'The one-time authorization was not held by this browser.')
      .then(() => {
        // Re-read rather than guess. The projection decides what may be done
        // now, and it is the only thing that should.
        setPlanReviewAttempt((n) => n + 1);
        // Explicit release, not automatic invalidation: the authorisation is
        // gone on the server because somebody asked for it to be.
        dispatchRun({ type: 'PLAN_RELEASED' });
      })
      .catch((error: unknown) => {
        dispatchRun({
          type: 'FAILED',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'That approval could not be withdrawn. Nothing in your catalogue has changed.',
        });
      })
      .finally(() => {
        withdrawInFlight.current = false;
        setWithdrawing(false);
      });
  }, [lifecycle, token, reviewPlanId, dispatchRun]);

  /**
   * Ask the server what this mapping would do — with an end to the waiting.
   *
   * Bounded, because "Waiting for the preview." was a state with no exit: a
   * request that was never made looks exactly like one that never answers, and
   * neither produced an error anybody could act on. A generation counter makes
   * abandonment explicit — a late answer from a superseded request is dropped
   * rather than allowed to overwrite the current one — and the timeout turns
   * silence into a message with a Retry beside it.
   */
  const requestPreview = React.useCallback(
    async (mapping: TableMapping) => {
      if (!state.sample) return;
      const generation = ++previewGeneration.current;
      dispatch({ type: 'PREVIEW_STARTED' });

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PREVIEW_TIMEOUT')), previewTimeoutMs),
      );

      try {
        const preview = await Promise.race([
          wizardService.preview(token, { importType: state.importType, sample: state.sample, mapping }),
          timeout,
        ]);
        // Superseded: somebody edited the mapping, or pressed Retry, while this
        // was in flight. Its answer describes a question nobody is asking.
        if (generation !== previewGeneration.current) return;
        dispatch({ type: 'PREVIEW_SUCCEEDED', preview });
      } catch (error) {
        if (generation !== previewGeneration.current) return;
        const timedOut = error instanceof Error && error.message === 'PREVIEW_TIMEOUT';
        dispatch({
          type: 'PREVIEW_FAILED',
          message: timedOut
            ? 'We could not check your mapping in time. Nothing in your catalogue has changed — try again.'
            : error instanceof Error && error.message
              ? error.message
              : 'The preview could not be built. Nothing in your catalogue has changed.',
        });
      }
    },
    [token, state.sample, state.importType, previewTimeoutMs, dispatch],
  );

  /**
   * Ask again, explicitly.
   *
   * A failure is terminal on purpose — retrying for ever is how a broken server
   * becomes a broken client — so the automatic request stands down and this is
   * the only way back. Bumping the generation first makes any late answer from
   * the failed attempt irrelevant.
   */
  const retryPreview = React.useCallback(() => {
    previewGeneration.current += 1;
    setPreviewAttempt((n) => n + 1);
    dispatch({ type: 'PREVIEW_RETRY' });
  }, [dispatch]);

  if (availability === 'FORBIDDEN') {
    return (
      <div className="card bg-white p-8 text-center" data-testid="wizard-forbidden">
        <h2 className="text-sm font-bold text-slate-800">You do not have permission to import</h2>
        <p className="mx-auto mt-2 max-w-md text-xs text-slate-600">
          Importing changes the whole company&rsquo;s catalogue, so it is limited to company managers. Ask a manager to
          run this import for you.
        </p>
      </div>
    );
  }

  /*
    Nothing type-specific until the plan has said what it is.

    Placed above every other branch that can render one, because "which import
    is this?" is upstream of the field catalogue, the relationship questions and
    the preview alike. The previous behaviour was to render the products editor
    while the plan loaded and then keep it: a screen that is wrong for a moment
    is a screen somebody can click, and the mapping dropdown is one click deep.
  */
  if (typePending) {
    return (
      <div className="card bg-white p-4" data-testid="import-type-pending">
        <p className="text-xs text-slate-600" role="status">
          Opening the plan you prepared&hellip;
        </p>
      </div>
    );
  }

  /*
    A stored plan this build can no longer show honestly.

    Only reachable when the catalogue has lost a field a stored plan uses. It is
    named rather than described vaguely, and it stops here rather than opening
    an editor: a mapping editor that cannot express the mapping it was given
    will show those columns as unmapped, and the next save writes that back.
  */
  if (unsupported.length > 0) {
    return (
      <div className="card space-y-2 bg-white p-4" role="alert" data-testid="plan-fields-unsupported">
        <p className="text-xs font-semibold text-amber-900">
          This plan uses fields a {typeLabel(resolvedType)} import can no longer fill.
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-700" data-testid="unsupported-field-list">
          {unsupported.map((entry) => (
            <li key={`${entry.field}:${entry.header}`}>
              <span className="font-mono">{entry.field}</span>
              {entry.header ? <> — from the column &ldquo;{entry.header}&rdquo;</> : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-600">
          Nothing in your catalogue has changed and this plan has not been altered. Prepare a new plan from the same
          file to continue.
        </p>
      </div>
    );
  }

  if (availability === 'UNAVAILABLE') {
    return (
      <div className="card bg-white p-8 text-center" data-testid="wizard-unavailable">
        <h2 className="text-sm font-bold text-slate-800">Imports are not available right now</h2>
        <p className="mx-auto mt-2 max-w-md text-xs text-slate-600">
          {/* The tenant-facing sentence, never the operator's reason: the
              configuration problem names buckets and credentials. */}
          {unavailableReason ?? 'Nothing is missing from your account. Please try again later.'}
        </p>
      </div>
    );
  }

  if (link.kind !== 'OPEN') {
    // No source yet, so this is the beginning of an import — offer the step
    // that creates one. This branch used to state "Choose a file to import."
    // and provide nothing to choose a file with, which left the safe path
    // without a starting point.
    return (
      <div className="space-y-3" data-testid="wizard-start-over">
        {link.reason && link.reason !== 'Choose a file to import.' ? (
          <p className="text-xs text-slate-600" data-testid="wizard-start-over-reason">
            {link.reason}
          </p>
        ) : null}
        <SourcePicker
          token={token}
          importType={pendingType}
          onImportTypeChange={setPendingType}
          organizationName={organizationName}
          storeName={storeName}
          storeId={storeId ?? null}
          client={lifecycle as unknown as SourcePickerClient}
          onStarted={(newSourceId, chosenType) => {
            // A full navigation, not a state flip: the source id belongs in the
            // URL so the run is linkable, survives a reload, and can be handed
            // to somebody else.
            navigate(
              `/dashboard/import-export/wizard${encodeWizardLocation({ sourceId: newSourceId, importType: chosenType })}`,
            );
          }}
        />
      </div>
    );
  }

  /**
   * End this import, after asking.
   *
   * The server is the one that decides: it refuses while a run is in flight and
   * refuses once one has finished, and says which. Those answers are shown as
   * they come back rather than pre-judged here, because the browser cannot know
   * whether a run started a second ago.
   */
  // Plain functions, NOT `useCallback`. The component returns early for the
  // forbidden, unavailable and start-over branches above this point, so a hook
  // here would run on some renders and not others — which React counts as a
  // different component each time, and it crashes the page outright.
  const cancelImport = async () => {
    if (!sourceId) return;
    setCancelStage('WORKING');
    try {
      const result = await lifecycle.cancelSource(token, sourceId);
      setCancelMessage(result.notice);
      setCancelStage('DONE');
      // The saved mapping goes with it. Leaving it behind would offer to
      // restore work into a file that has been ended.
      if (storage) clearProgress(storage, sourceId);
    } catch (error) {
      setCancelMessage(error instanceof Error ? error.message : 'This import could not be cancelled.');
      setCancelStage('FAILED');
    }
  };

  /**
   * Keep the work and leave.
   *
   * Saving is what the wizard already does on every change; the only thing this
   * adds is somewhere to go. It writes once more before leaving so that a
   * decision made a moment ago cannot be outrun by the navigation.
   */
  const saveAndExit = () => {
    if (storage && sourceId && state.mapping.columns.length > 0 && mayAutosave(hydration)) {
      saveProgress(storage, state, sourceId, now(), currentScope, { decisions: relationships });
    }
    navigate('/dashboard/import-export');
  };

  /*
    Reviewing a stored plan.

    Returned BEFORE the editor is built, so nothing below starts an analysis,
    asks for a preview, restores browser-local mapping or creates a second
    plan. The decisions were made and hashed already; this screen reads them.
  */
  if (reviewPlanId) {
    if (planReview.state === 'LOADING') {
      return (
        <div className="card bg-white p-4" data-testid="plan-review-loading">
          <p className="text-xs text-slate-600">Opening the plan you prepared…</p>
        </div>
      );
    }
    if (planReview.state === 'FAILED' || !planReview.plan || !planReview.lifecycle) {
      return (
        <div className="card space-y-2 bg-white p-4" role="alert" data-testid="plan-review-failed">
          <p className="text-xs font-semibold text-amber-900">That import plan could not be opened.</p>
          <p className="text-xs text-slate-600">
            It may belong to another company, or it may no longer exist. Nothing in your catalogue has changed.
          </p>
        </div>
      );
    }
    return (
      <>
        <TypeCorrectionNotice correction={typeCorrection} />
        <PlanReview
        plan={planReview.plan}
        // The FRESHEST answer wins. The run machine refetches the lifecycle the
        // moment an approval is granted, and reading the one fetched on entry
        // instead would leave the screen describing a plan as it was before the
        // click — two sources of the same truth, which is the shape of every
        // defect on this screen so far.
        lifecycle={run.lifecycle ?? planReview.lifecycle}
        options={options}
        run={run}
        surface={projectPlanActions({
          lifecycle: run.lifecycle ?? planReview.lifecycle,
          proofHeld: proofIsHeld(run),
          inFlight: withdrawing ? 'WITHDRAWING' : planInFlight(run),
          results: { loaded: run.resultsLoaded, loading: run.resultsLoading },
          // The machine can know a run exists, and what became of it, before the
          // lifecycle is re-read. It outranks the server's last answer for exactly
          // that window — including when the run was abandoned and can be resumed.
          observedExecution: run.execution
            ? {
                status: run.execution.status,
                resumable: run.execution.resumable,
                cancelRequested: run.execution.cancelRequested,
              }
            : null,
        })}
        onApprove={actions.approve}
        onExecute={actions.execute}
        onWithdraw={withdrawApproval}
        onEditMapping={() => setEditingMapping(true)}
        onCancelRun={actions.cancel}
        onResumeRun={actions.resume}
        onViewResults={actions.loadResults}
        reportHref={actions.reportHref}
        />
      </>
    );
  }


  return (
    <div className="space-y-4 pb-2">
      <TypeCorrectionNotice correction={typeCorrection} />
      {hydration.kind === 'OFFERED' ? (
        <div className="card flex flex-wrap items-center justify-between gap-3 bg-sky-50 p-3" data-testid="restore-offer">
          <p className="text-xs text-slate-800">{hydration.description}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'RESTORED', state: restorableFrom(hydration.saved) });
                // The relationship decisions come back WITH the mapping they
                // were made against. Restoring one without the other would
                // put a custody choice next to a mapping it was never
                // reviewed against.
                // Stale keys from a save made under a different import type are
                // dropped by `normalizeRelationships` before anything reads
                // this — never silently carried into the new plan's hash.
                setRelationships((hydration.saved.relationships ?? {}) as RelationshipDecisions);
                // Restored, not resolved-and-forgotten: the scope travels with
                // the verdict so that a file still being read can still object
                // once it arrives.
                setHydration({ kind: 'RESTORED', scope: hydration.saved.scope });
              }}
              className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="restore-continue"
            >
              Restore saved work
            </button>
            <button
              type="button"
              onClick={() => {
                // Refusing REMOVES it. An offer declined that reappears on the
                // next reload is an offer that was never declined.
                if (storage && sourceId) clearProgress(storage, sourceId);
                setHydration({ kind: 'DISCARDED_UNTOUCHED' });
              }}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="restore-discard"
            >
              Discard saved work and restart
            </button>
          </div>
        </div>
      ) : null}

      {hydration.kind === 'INCOMPATIBLE' ? (
        <div className="card space-y-1 bg-amber-50 p-3" role="status" data-testid="restore-incompatible">
          <p className="text-xs font-semibold text-amber-900">
            Saved decisions for this import could not be brought back.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {hydration.reasons.map((reason) => (
              <li key={reason} className="text-xs text-slate-700">
                {reason}
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-600">Please make those decisions again below.</p>
        </div>
      ) : null}

      {/*
        Lifecycle actions, in the stage header.

        NOT a sticky footer. That one was 47px tall and parked 96px above the
        viewport bottom — `position: sticky; bottom: 0` resolves against the
        scroll container's padding box, and that container carried `pb-24`. It
        sat across the middle of a forty-five column mapping form with three to
        six inputs behind it at every scroll position, and it was rejected in
        manual acceptance twice. An unobstructed editor is worth more than a
        control that is always on screen.

        Leaving and cancelling live here, at the top, where they are reachable
        without scrolling and where they cannot cover anything. Moving between
        stages lives in the footer below, after the content — the two are
        different kinds of action and are not duplicated.
      */}
      {link.kind === 'OPEN' && cancelStage !== 'DONE' ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-white px-3 py-2"
          data-testid="wizard-actions"
        >
          <p className="text-xs text-slate-600" data-testid="wizard-stage">
            {!state.sample
              ? 'Reading your file'
              : relationshipsSettled
                ? 'Ready to review the import plan'
                : 'Mapping columns and deciding what they mean'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveAndExit}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="wizard-save-exit"
            >
              Save and exit
            </button>
            <button
              type="button"
              onClick={() => setCancelStage('CONFIRMING')}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="wizard-cancel-import"
            >
              Cancel import
            </button>
          </div>
        </div>
      ) : null}

      {/* While the file is still being read there is nothing to map, and
          rendering the editor underneath produced the state an operator
          actually reported: "Reading your file…" above "Choose a file to
          import." — the screen contradicting itself. One state at a time. */}
      {analysis && analysis.status !== 'COMPLETED' ? (
        <div
          className="card bg-white p-4 text-xs text-slate-600"
          role="status"
          aria-live="polite"
          data-testid="analysis-status"
        >
          {analysis.status === 'FAILED' ? (
            <>
              <p className="font-semibold text-rose-700">This file could not be read.</p>
              <p className="mt-1">
                {analysis.failureReason ?? 'Upload it again to continue.'}
              </p>
            </>
          ) : analysis.status === 'STALLED' ? (
            <>
              <p className="font-semibold text-amber-800">Still waiting to read your file.</p>
              <p className="mt-1">
                {analysis.failureReason ??
                  'It has taken longer than expected. Your file is safely stored and nothing has been ' +
                    'changed in your catalogue. You can keep waiting, or reopen this import later — ' +
                    'it will pick up where it left off.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  setAnalysis(null);
                  setWaitedMs(0);
                  setWatchAttempt((n) => n + 1);
                }}
                className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
                data-testid="analysis-keep-waiting"
              >
                Keep waiting
              </button>
            </>
          ) : (
            <>
              <p>Reading your file…</p>
              {/* Elapsed time, so waiting is informed rather than blind. */}
              <p className="mt-1 text-slate-500" data-testid="analysis-waited">
                {waitedMs < 1000
                  ? 'Just started.'
                  : `Waiting ${Math.round(waitedMs / 1000)}s. This usually takes a minute or two.`}
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <MappingEditor
            state={state}
            dispatch={dispatch}
            fieldOptions={fieldCatalogueFor(state.importType)}
            requestPreview={requestPreview}
            previewAttempt={previewAttempt}
          />

          {/* The decisions the mapping cannot make. Between mapping and the
              plan, because they are INPUTS to the plan rather than commentary
              on one that already exists. */}
          {state.sample && optionsState === 'FAILED' ? (
            <div className="card space-y-2 bg-white p-4" role="alert" data-testid="relationship-options-failed">
              <p className="text-xs font-semibold text-rose-700">
                The available stores, categories and stock locations could not be loaded. No plan can be prepared
                until they are available.
              </p>
              <button
                type="button"
                onClick={() => setOptionsAttempt((n) => n + 1)}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
                data-testid="retry-relationship-options"
              >
                Retry
              </button>
            </div>
          ) : null}

          {state.sample && optionsState === 'LOADING' ? (
            <p className="card bg-white p-3 text-xs text-slate-600" data-testid="relationship-options-loading">
              Loading the stores, categories and stock locations you can choose from…
            </p>
          ) : null}

          {state.sample && optionsState === 'READY' ? (
            <RelationshipsStep
              questions={questions}
              options={options}
              storeId={storeId ?? null}
              value={relationships}
              onChange={(next) => {
                // A relationship decision is a person's edit too, so it lifts a
                // discard the same way a mapping change does.
                setHydration((current) =>
                  current.kind === 'DISCARDED_UNTOUCHED' ? { kind: 'DIRTY_AFTER_DISCARD' } : current,
                );
                setRelationships(next);
              }}
            />
          ) : null}

          {state.previewError ? (
            <div className="card space-y-2 bg-amber-50 p-3" role="alert" data-testid="preview-failed">
              <p className="text-xs font-semibold text-amber-900">We could not check your mapping.</p>
              <p className="text-xs text-slate-700" data-testid="preview-failed-reason">
                {state.previewError}
              </p>
              <button
                type="button"
                onClick={retryPreview}
                className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                data-testid="preview-retry"
              >
                Try again
              </button>
            </div>
          ) : null}

          {/*
            Moving ON, in normal flow, after every editor control.

            In the document, not over it. Whatever its height, the content
            above it is complete before it begins, so nothing can be hidden
            behind it and the last mapping row needs no clearance to escape it.
          */}
          <div data-testid="wizard-footer">
            {relationshipsSettled ? (
              <div className="space-y-4">
                {/* Restated beside the approval, because the approval attests
                    to a hash these decisions are inside — and nobody should
                    have to scroll back through a form to learn what they are
                    approving. */}
                <RelationshipSummary decisions={relationships} options={options} />
                {/*
                    The same actions the review screen gets, including the two
                    that used to exist only there. Withdrawal in particular: a
                    proof lost in THIS flow had no recovery at all, because the
                    only Withdraw button in the codebase was on the other route.
                  */}
                  <RunPanel
                    state={run}
                    readiness={editorReadiness(state)}
                    actions={{
                      ...actions,
                      withdraw: withdrawApproval,
                      editMapping: () => setEditingMapping(true),
                    }}
                  />
              </div>
            ) : (
              <OutstandingRequirements progression={progression} />
            )}
          </div>
        </>
      )}

      {cancelStage === 'CONFIRMING' ? (
        <div className="card space-y-2 bg-amber-50 p-3" role="alertdialog" data-testid="cancel-confirm">
          <p className="text-xs font-semibold text-amber-900">Cancel this import?</p>
          <p className="text-xs text-slate-700">
            The mapping and decisions you have made will be discarded. Nothing in your catalogue is changed.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void cancelImport()}
              disabled={cancelStage !== 'CONFIRMING'}
              className="rounded bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white disabled:bg-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="cancel-confirm-yes"
            >
              Yes, cancel it
            </button>
            <button
              type="button"
              onClick={() => setCancelStage('IDLE')}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid="cancel-confirm-no"
            >
              Keep working on it
            </button>
          </div>
        </div>
      ) : null}

      {cancelMessage ? (
        <p
          className={cancelStage === 'FAILED' ? 'card bg-white p-3 text-xs text-amber-900' : 'card bg-white p-3 text-xs text-slate-700'}
          role="status"
          data-testid="cancel-outcome"
        >
          {cancelMessage}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What is still missing, named, with a way to get to it.
 *
 * This replaces "Answer the questions above to build the plan." — a sentence
 * that was true beside a form whose every visible control had been answered,
 * and which named neither the requirement nor where it lived. An operator read
 * it, looked at a complete-looking form, and had nowhere to go.
 *
 * Each requirement is a button rather than prose, because the useful thing to
 * do with "you have not chosen a stock location" is to be taken to the stock
 * section.
 */
function OutstandingRequirements({ progression }: { progression: ProgressionState }) {
  const focusSection = (id: 'stock' | 'stores' | 'categories') => {
    const section = document.getElementById(sectionDomId(id));
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus as well as scroll: a keyboard or screen-reader user gets nothing
    // from a scroll they cannot feel.
    section.focus({ preventScroll: true });
  };

  if (progression.kind === 'UNAVAILABLE') {
    return (
      <div className="card space-y-1 bg-white p-3 text-xs" role="alert" data-testid="relationships-unavailable">
        <p className="font-semibold text-amber-900">{progression.requirement.label}</p>
        {progression.requirement.detail ? <p className="text-slate-600">{progression.requirement.detail}</p> : null}
      </div>
    );
  }

  if (progression.kind !== 'INCOMPLETE') return null;

  return (
    <div className="card space-y-2 bg-white p-3" data-testid="relationships-outstanding">
      <p className="text-xs font-semibold text-slate-800">
        {progression.missing.length === 1
          ? 'One decision is still needed before the plan can be built:'
          : `${progression.missing.length} decisions are still needed before the plan can be built:`}
      </p>
      <ul className="space-y-1">
        {progression.missing.map((requirement) => (
          <li key={requirement.id} className="text-xs text-slate-700">
            <button
              type="button"
              onClick={() => focusSection(requirement.id)}
              className="text-left font-medium text-sky-800 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              data-testid={`goto-${requirement.id}`}
            >
              {requirement.label}
            </button>
            {requirement.detail ? <span className="ml-1 text-slate-600">{requirement.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The link that points back at exactly this place.
 *
 * Identifiers only: a URL is pasted into tickets and chat and logged by every
 * proxy in between, so no cell value rides along.
 */
export function currentLink(sourceId: string, state: MappingState): string {
  return encodeWizardLocation({
    sourceId,
    importType: state.importType,
    region: state.focusedRegion,
    ...(state.focusedColumnIndex !== null ? { column: state.focusedColumnIndex } : {}),
  });
}

export { decodeWizardLocation };

/**
 * What storage holds for this source, judged without touching it.
 *
 * A pure read, safe to run during render, which is the point: the offer has to
 * exist before any effect can run, or an effect will write over the thing the
 * offer is offering.
 */
function readHydration(storage: ProgressStorage | null, sourceId: string | null, now: () => number): Hydration {
  if (!storage || !sourceId) return { kind: 'NONE' };
  let saved: SavedProgress | null = null;
  try {
    saved = loadProgress(storage, sourceId, now());
  } catch {
    // Unreadable storage is a fresh start, not a crash.
    return { kind: 'NONE' };
  }
  if (!saved) return { kind: 'NONE' };
  return { kind: 'OFFERED', saved, description: describeProgress(saved, now()) };
}

/**
 * A plan somebody prepared earlier, read back for review.
 *
 * Everything here comes from the SERVER's stored plan. Nothing is re-derived,
 * because there is nothing to re-derive: the mapping and the relationship
 * decisions were settled when the plan was built and its hash covers them.
 *
 * This screen exists because the draft list said "Ready to review" and then
 * routed back to the mapping editor, which cleared its preview, never asked for
 * another, and sat on "Waiting for the preview." while the finished plan lay
 * unread on the server.
 */
function PlanReview({
  plan,
  lifecycle,
  options,
  run,
  surface,
  onApprove,
  onExecute,
  onWithdraw,
  onEditMapping,
  onCancelRun,
  onResumeRun,
  onViewResults,
  reportHref,
}: {
  plan: StoredPlan;
  lifecycle: PlanLifecycle;
  options: RelationshipOptions | null;
  run: RunState;
  /**
   * What may be done, computed by the SAME projection the wizard's run panel
   * uses and passed in rather than recomputed here. Two components deriving
   * the same answer from the same inputs is how they came to disagree.
   */
  surface: PlanSurface;
  onApprove: () => void;
  onExecute: () => void;
  onWithdraw: () => void;
  onEditMapping: () => void;
  onCancelRun: () => void;
  onResumeRun: () => void;
  onViewResults: () => void;
  /** The downloadable report, when a run exists. Never invented here. */
  reportHref: string | null;
}) {
  /*
    Whether a run exists, asked ONCE.

    This block used to re-derive `hasRun`, `terminal` and a headline from the
    lifecycle and the machine, alongside a second copy of the same reasoning in
    the run panel. `surface.kind` is that answer now, from the projection, so
    the two screens cannot disagree about whether an import has started.
  */
  const hasRun = surface.kind === 'TERMINAL' || surface.kind === 'IN_FLIGHT';

  const mapped = (plan.mapping?.columns ?? []).filter((c) => c.field !== null);
  const decisions = ((plan.decisions as { relationships?: RelationshipDecisions } | undefined)?.relationships ??
    {}) as RelationshipDecisions;

  return (
    <div className="space-y-4" data-testid="plan-review">
      <div className="card space-y-1 bg-white p-4">
        <h2 className="text-sm font-bold text-slate-800">Review this import plan</h2>
        <p className="text-xs text-slate-600">
          {/* The second sentence is TRUE only until a run exists. Leaving it
              standing is how this screen came to say nothing had been written
              while an import was writing. */}
          {hasRun
            ? 'Prepared earlier and unchanged since.'
            : 'Prepared earlier and unchanged since. Nothing has been written to your catalogue.'}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">Import reference</dt>
          <dd className="font-mono text-slate-700" data-testid="plan-review-hash">
            {plan.planHash.slice(0, 16)}
          </dd>
          <dt className="text-slate-500">Rows read</dt>
          <dd className="text-slate-700" data-testid="plan-review-rows">
            {plan.summary?.previewedRows ?? 0}
          </dd>
          <dt className="text-slate-500">Columns mapped</dt>
          <dd className="text-slate-700" data-testid="plan-review-columns">
            {mapped.length}
          </dd>
          <dt className="text-slate-500">Findings</dt>
          <dd className="text-slate-700" data-testid="plan-review-findings">
            {plan.summary?.summary?.total ?? 0}
          </dd>
        </dl>
      </div>

      <RelationshipSummary decisions={decisions} options={options} />

      {/*
        One surface, shared with the wizard's own run panel.

        This screen used to render its own status block, its own approved
        block, its own lost-proof block and its own action row — four
        conditions over the same lifecycle, written twice in two files. The
        wizard's copy was missing the lost-proof block entirely, which is why
        an approval created in the fresh-prepare flow had no recovery and this
        one did. There is now a single projection and a single renderer, so a
        capability cannot exist on one route and not the other.
      */}
      {run.error ? (
        <div className="card bg-amber-50 p-3" role="alert" data-testid="plan-review-error">
          <p className="text-xs text-amber-900">{run.error}</p>
        </div>
      ) : null}

      <PlanSurfaceView
        surface={surface}
        handlers={{
          approve: onApprove,
          start: onExecute,
          withdraw: onWithdraw,
          editMapping: onEditMapping,
          cancelRun: onCancelRun,
          resumeRun: onResumeRun,
          viewResults: onViewResults,
        }}
        results={{
          rows: run.rows,
          report: run.report,
          reportHref,
          loading: run.resultsLoading,
        }}
        ids={{
          APPROVE: 'plan-review-approve',
          START: 'plan-review-start',
          WITHDRAW: 'plan-review-withdraw',
          EDIT_MAPPING: 'plan-review-edit-mapping',
        }}
      />
    </div>
  );
}

/**
 * What an import type is called, in the words a person uses.
 *
 * Derived from the type rather than from a second table, so a type added to the
 * union cannot silently acquire a blank name.
 */
function typeLabel(importType: ImportType): string {
  switch (importType) {
    case 'PRODUCTS':
      return 'products';
    case 'CATEGORIES':
      return 'categories';
    case 'HISTORICAL_STORE_SALES':
      return 'historical sales';
    default:
      // Unreachable while `ImportType` is closed; kept so a new member is a
      // visible gap rather than an empty sentence on screen.
      return String(importType).toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * The link said one thing and the plan says another, stated out loud.
 *
 * Rendered on both routes, because both are reachable by a link. It is not a
 * warning — nothing is wrong, and nothing was lost — it is an account of why
 * the screen is not the one the link promised. Correcting the address bar
 * without saying so would leave somebody who followed a `type=PRODUCTS` link
 * looking at a historical-sales editor with no explanation, and no way to tell
 * a correction from a bug.
 */
function TypeCorrectionNotice({
  correction,
}: {
  correction: { hinted: ImportType | null; actual: ImportType } | null;
}) {
  if (!correction) return null;
  return (
    <p
      className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
      role="status"
      data-testid="import-type-corrected"
      data-corrected-to={correction.actual}
    >
      {correction.hinted
        ? `That link described this as a ${typeLabel(correction.hinted)} import. It is a ${typeLabel(
            correction.actual,
          )} import, and it is shown as one.`
        : `That link did not say which kind of import this is. It is a ${typeLabel(
            correction.actual,
          )} import, and it is shown as one.`}
    </p>
  );
}
