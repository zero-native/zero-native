/**
 * zero-native: @flow state machine and effect persistence engine
 * Implements ARCHITECTURE.md §12 (flows & effects) and §13 (persistence).
 */

export type EffectKind = 'safe' | 'keyed' | 'once';

export interface EffectRecord {
  id: string;
  kind: EffectKind;
  status: 'started' | 'done' | 'failed';
  key?: string;
  at: number;
  reconcile?: string;
  result?: any;
  error?: string;
}

export interface FlowState<TData = Record<string, any>> {
  flowId: string;
  name: string;
  schemaVersion: number;
  step: string;
  data: TData;
  updatedAt: number;
  expiresAt: number;
  effects: Record<string, EffectRecord>;
}

export interface EffectConfig<TData = any> {
  kind: EffectKind;
  reconcile?: string;
}

export interface EffectHandler<TData = any, TResult = any> {
  id: string;
  kind: EffectKind;
  reconcile?: string;
  execute: (data: TData, key?: string) => Promise<TResult>;
}

export function effect<TData = any, TResult = any>(
  id: string,
  config: EffectConfig<TData>,
  execute: (data: TData, key?: string) => Promise<TResult>
): EffectHandler<TData, TResult> {
  if ((config.kind === 'once' || config.kind === 'keyed') && !config.reconcile) {
    throw new Error(`Effect '${id}' of kind '${config.kind}' MUST declare a 'reconcile' step.`);
  }
  return {
    id,
    kind: config.kind,
    reconcile: config.reconcile,
    execute,
  };
}

export interface FlowStep<TData = any> {
  enter?: EffectHandler<TData, any> | ((data: TData, flow: FlowInstance<TData>) => void | Promise<void>);
  on?: Record<string, (data: TData, payload: any, flow: FlowInstance<TData>) => void | Promise<void>>;
}

export interface FlowConfig<TData = any> {
  name: string;
  schemaVersion: number;
  expiresAfter: { minutes: number; sliding?: boolean };
  initial: string;
  data: TData;
  steps: Record<string, FlowStep<TData>>;
  migrate?: Record<number, (oldData: any) => any>;
}

// FlowStore interface (Native or Test memory adapter)
export interface FlowStorageAdapter {
  save(flowState: FlowState): void;
  load(name: string): FlowState | null;
  delete(name: string): void;
}

let activeAdapter: FlowStorageAdapter = {
  save(state) {
    if (typeof (globalThis as any).__zn_flow_save === 'function') {
      (globalThis as any).__zn_flow_save(JSON.stringify(state));
    }
  },
  load(name) {
    if (typeof (globalThis as any).__zn_flow_load === 'function') {
      const raw = (globalThis as any).__zn_flow_load(name);
      return raw ? JSON.parse(raw) : null;
    }
    return null;
  },
  delete(name) {
    if (typeof (globalThis as any).__zn_flow_delete === 'function') {
      (globalThis as any).__zn_flow_delete(name);
    }
  },
};

export function setFlowStorageAdapter(adapter: FlowStorageAdapter) {
  activeAdapter = adapter;
}

export class FlowInstance<TData = any> {
  public state: FlowState<TData>;
  private config: FlowConfig<TData>;
  private isDestroyed = false;
  private inEffectExecution = false;

  constructor(config: FlowConfig<TData>, existingState?: FlowState<TData>) {
    this.config = config;
    const now = Date.now();
    const expiryMs = (config.expiresAfter?.minutes ?? 15) * 60 * 1000;

    if (existingState) {
      this.state = existingState;
    } else {
      this.state = {
        flowId: `flow_${config.name}_${now}_${Math.random().toString(36).substring(2, 8)}`,
        name: config.name,
        schemaVersion: config.schemaVersion,
        step: config.initial,
        data: JSON.parse(JSON.stringify(config.data)),
        updatedAt: now,
        expiresAt: now + expiryMs,
        effects: {},
      };
      this.persist();
    }
  }

  public get step(): string {
    return this.state.step;
  }

  public get data(): TData {
    return this.state.data;
  }

  public persist() {
    const now = Date.now();
    this.state.updatedAt = now;
    if (this.config.expiresAfter?.sliding !== false) {
      const expiryMs = (this.config.expiresAfter?.minutes ?? 15) * 60 * 1000;
      this.state.expiresAt = now + expiryMs;
    }
    activeAdapter.save(this.state);
  }

  /**
   * Transitions to a new step.
   * Write-ahead rule: updates step and persists state BEFORE executing step's enter handler.
   */
  public async go(nextStep: string, dataPatch?: Partial<TData>): Promise<void> {
    if (this.isDestroyed) return;
    const stepDef = this.config.steps[nextStep];
    if (!stepDef) {
      throw new Error(`Unknown step '${nextStep}' in flow '${this.config.name}'`);
    }

    if (dataPatch) {
      this.state.data = { ...this.state.data, ...dataPatch };
    }
    this.state.step = nextStep;
    this.persist();

    // Execute enter effect / handler
    if (stepDef.enter) {
      if (typeof stepDef.enter === 'function') {
        await stepDef.enter(this.state.data, this);
      } else {
        await this.runEffect(stepDef.enter);
      }
    }
  }

  /**
   * Executes an Effect with write-ahead logging (ARCHITECTURE §12.3).
   */
  public async runEffect(effectHandler: EffectHandler<TData, any>): Promise<any> {
    const effectId = effectHandler.id;
    const now = Date.now();
    const key = effectHandler.kind === 'keyed'
      ? `${this.state.flowId}_${effectId}_${this.state.step}`
      : undefined;

    // 1. Write-Ahead: Mark effect as 'started' and persist BEFORE invoking action
    const record: EffectRecord = {
      id: effectId,
      kind: effectHandler.kind,
      status: 'started',
      key,
      at: now,
      reconcile: effectHandler.reconcile,
    };
    this.state.effects[effectId] = record;
    this.persist();

    this.inEffectExecution = true;
    try {
      const result = await effectHandler.execute(this.state.data, key);
      // 2. Mark effect as 'done' with result
      this.state.effects[effectId] = {
        ...record,
        status: 'done',
        result,
      };
      this.persist();
      this.inEffectExecution = false;
      return result;
    } catch (err: any) {
      this.state.effects[effectId] = {
        ...record,
        status: 'failed',
        error: String(err?.message || err),
      };
      this.persist();
      this.inEffectExecution = false;
      throw err;
    }
  }

  /**
   * Dispatches an event to the current step's event handlers.
   */
  public async dispatch(event: string, payload?: any): Promise<void> {
    if (this.isDestroyed) return;
    const currentStepDef = this.config.steps[this.state.step];
    if (!currentStepDef || !currentStepDef.on || !currentStepDef.on[event]) {
      return;
    }
    await currentStepDef.on[event](this.state.data, payload, this);
  }

  /**
   * Drops/clears the flow from persistence.
   */
  public drop() {
    this.isDestroyed = true;
    activeAdapter.delete(this.config.name);
  }
}

export interface RestoreOutcome<TData = any> {
  status: 'active' | 'dropped' | 'reconcile';
  flow?: FlowInstance<TData>;
  reconcileStep?: string;
  reason?: string;
}

export function defineFlow<TData = any>(config: FlowConfig<TData>) {
  // Validate effects at definition time
  for (const [stepName, step] of Object.entries(config.steps)) {
    if (step.enter && typeof step.enter !== 'function') {
      const eff = step.enter as EffectHandler;
      if ((eff.kind === 'once' || eff.kind === 'keyed') && !eff.reconcile) {
        throw new Error(`Step '${stepName}' in flow '${config.name}' has '${eff.kind}' effect '${eff.id}' without a 'reconcile' step.`);
      }
    }
  }

  return {
    config,
    start(initialData?: Partial<TData>): FlowInstance<TData> {
      const instance = new FlowInstance<TData>({
        ...config,
        data: { ...config.data, ...initialData },
      });
      return instance;
    },

    /**
     * Cold-start restore engine adhering strictly to ARCHITECTURE §12.5.
     */
    restore(savedState: FlowState<TData> | null, nativeCachedResult?: any): RestoreOutcome<TData> {
      if (!savedState) {
        return { status: 'dropped', reason: 'no_saved_state' };
      }

      const now = Date.now();
      const hasUnsafeEffectStarted = Object.values(savedState.effects).some(
        (eff) => (eff.kind === 'once' || eff.kind === 'keyed') && eff.status === 'started'
      );

      // Rule 1: Check Expiry
      if (now > savedState.expiresAt) {
        if (!hasUnsafeEffectStarted) {
          activeAdapter.delete(config.name);
          return { status: 'dropped', reason: 'expired_safe' };
        }
        // Money may have moved! Open in reconcile step
        return {
          status: 'reconcile',
          reconcileStep: 'verifying',
          reason: 'expired_with_in_flight_effects',
        };
      }

      // Rule 2: Schema Version Migrations
      let currentData = savedState.data;
      if (savedState.schemaVersion < config.schemaVersion) {
        try {
          if (!config.migrate) throw new Error('No migrations declared');
          for (let v = savedState.schemaVersion; v < config.schemaVersion; v++) {
            if (config.migrate[v]) {
              currentData = config.migrate[v](currentData);
            } else {
              throw new Error(`Missing migration for schema v${v}`);
            }
          }
          savedState.data = currentData;
          savedState.schemaVersion = config.schemaVersion;
        } catch (migErr) {
          if (hasUnsafeEffectStarted) {
            return { status: 'reconcile', reconcileStep: 'verifying', reason: 'migration_failed_in_flight' };
          }
          activeAdapter.delete(config.name);
          return { status: 'dropped', reason: 'migration_failed' };
        }
      }

      // Rule 3: Native Result Pre-caching integration (§12.4)
      if (nativeCachedResult !== undefined && nativeCachedResult !== null) {
        for (const eff of Object.values(savedState.effects)) {
          if (eff.status === 'started' && eff.kind === 'once') {
            eff.status = 'done';
            eff.result = nativeCachedResult;
          }
        }
      }

      // Rule 4: Handle started effects according to effect kind table (§12.2)
      for (const eff of Object.values(savedState.effects)) {
        if (eff.status === 'started') {
          if (eff.kind === 'once') {
            // Irreversible: NEVER run again automatically; force to reconcile step!
            savedState.step = eff.reconcile || 'verifying';
          }
          // 'safe' and 'keyed' remain active to be retried by the restored step
        }
      }

      // Rule 5: Payment Rule (§12.5)
      // Once /pay or UPI has started, restored flow NEVER launches UPI app automatically.
      if (savedState.step === 'launchingUpi' || savedState.step === 'paying') {
        savedState.step = 'verifying';
      }

      const instance = new FlowInstance<TData>(config, savedState);
      return { status: 'active', flow: instance };
    },
  };
}
