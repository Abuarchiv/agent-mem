export const SEARCH_SIGNALS = ["lexical", "semantic", "graph", "procedure", "recency"] as const;
export type SearchSignal = typeof SEARCH_SIGNALS[number];
export type SignalValues = Record<SearchSignal, number>;
export type SearchKind = "identifier" | "recent" | "relation" | "procedure" | "semantic";
export const DEFAULT_SEARCH_WEIGHTS: Readonly<SignalValues> = Object.freeze({ lexical: 1, semantic: 1, graph: 0.25, procedure: 0.4, recency: 0.1 });
export interface ProcedureRule { scope_id: string; capture_id: string; terms: string[]; }
export interface SearchReport {
  query_id: string;
  binding_id: string;
  scope_id: string;
  kind: SearchKind;
  created_at: string;
  stages: string[];
  reranker: "applied" | "disabled" | "unavailable" | "skipped";
  graph_hops: number;
  graph_added: number;
  graph_complete: boolean;
  weights: SignalValues;
  learned_samples: number;
  candidates: Array<{ capture_id: string; features: SignalValues }>;
  procedure_ids: string[];
}
