/**
 * 搜索规划引擎（六阶段协议，与 MCP 版 grok-search 对齐）
 *
 * plan_intent → plan_complexity → plan_sub_query(×N) → plan_search_term(×N) → plan_tool_mapping(×N) → plan_execution
 * 复杂度要求：Level 1 = 阶段 1-3；Level 2 = 阶段 1-5；Level 3 = 全部 6 阶段
 */
import { randomUUID } from "node:crypto";

export const PHASE_NAMES = [
  "intent_analysis",
  "complexity_assessment",
  "query_decomposition",
  "search_strategy",
  "tool_selection",
  "execution_order",
] as const;

export type PhaseName = (typeof PHASE_NAMES)[number];

export const REQUIRED_PHASES: Record<number, Set<PhaseName>> = {
  1: new Set(["intent_analysis", "complexity_assessment", "query_decomposition"]),
  2: new Set([
    "intent_analysis",
    "complexity_assessment",
    "query_decomposition",
    "search_strategy",
    "tool_selection",
  ]),
  3: new Set([
    "intent_analysis",
    "complexity_assessment",
    "query_decomposition",
    "search_strategy",
    "tool_selection",
    "execution_order",
  ]),
};

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface PhaseRecord {
  phase: string;
  thought: string;
  confidence: number;
  data: unknown[];
}

export class PlanningSession {
  phases = new Map<string, PhaseRecord>();

  completedPhases(): string[] {
    return PHASE_NAMES.filter((p) => this.phases.has(p));
  }

  requiredPhases(): Set<PhaseName> {
    const level = this.getComplexityLevel();
    return REQUIRED_PHASES[level] ?? REQUIRED_PHASES[1];
  }

  getComplexityLevel(): number {
    const rec = this.phases.get("complexity_assessment");
    if (!rec || rec.data.length === 0) return 1;
    const first = rec.data[0] as { level?: number };
    return first?.level === 2 ? 2 : first?.level === 3 ? 3 : 1;
  }

  isComplete(): boolean {
    for (const p of this.requiredPhases()) {
      if (!this.phases.has(p)) return false;
    }
    return true;
  }

  buildExecutablePlan(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, rec] of this.phases) {
      out[name] = rec.data.length === 1 ? rec.data[0] : rec.data;
    }
    return out;
  }
}

export class PlanningEngine {
  private sessions = new Map<string, PlanningSession>();

  newSession(): PlanningSession {
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 12);
    const session = new PlanningSession();
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): PlanningSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** 处理一个阶段：is_revision 覆盖已有记录，否则累积（list 型阶段）/ 新建 */
  processPhase(opts: {
    phase: string;
    thought: string;
    sessionId: string;
    isRevision?: boolean;
    confidence?: number;
    phaseData: unknown;
  }): Record<string, unknown> {
    const { phase, thought, sessionId, isRevision, confidence, phaseData } = opts;
    if (!PHASE_NAMES.includes(phase as PhaseName)) {
      return { error: `Unknown phase: ${phase}. Valid: ${PHASE_NAMES.join(", ")}` };
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new PlanningSession();
      this.sessions.set(sessionId, session);
    }

    const existing = session.phases.get(phase);
    if (isRevision || !existing) {
      session.phases.set(phase, {
        phase,
        thought,
        confidence: confidence ?? 1.0,
        data: [phaseData],
      });
    } else if (Array.isArray(existing.data)) {
      existing.data.push(phaseData);
      existing.thought = thought;
      existing.confidence = confidence ?? existing.confidence;
    }

    return {
      session_id: sessionId,
      phase,
      status: session.isComplete() ? "complete" : "in_progress",
      completed_phases: session.completedPhases(),
      required_phases: [...session.requiredPhases()],
      data: session.phases.get(phase)?.data ?? [],
      plan: session.buildExecutablePlan(),
    };
  }
}

export const engine = new PlanningEngine();
