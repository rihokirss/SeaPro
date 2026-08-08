/**
 * Pure grid-routing types. Geographic data adapters deliberately live outside
 * this module: a caller only has to expose its rasterised data through
 * `RoutingGrid`.
 */

export type RouteRisk = 'clear' | 'caution' | 'unknown';

export interface GridCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface GridPoint extends GridCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface RoutingCell {
  /** A hard constraint: land, insufficient depth, a buffered obstacle, etc. */
  readonly blocked: boolean;
  /** Positive traversal cost relative to ordinary safe water. Ignored if blocked. */
  readonly costMultiplier: number;
  readonly risk: RouteRisk;
  readonly reasons?: readonly string[];
}

export interface RoutingGrid {
  readonly width: number;
  readonly height: number;
  /**
   * Optional proven lower bound for every traversable cell multiplier. Supplying
   * it enables an admissible A* heuristic. If omitted, search uses a zero
   * heuristic (Dijkstra), which is slower but remains optimal.
   */
  readonly minimumCostMultiplier?: number;
  cellAt(x: number, y: number): RoutingCell;
}

export const ROUTING_COST_MULTIPLIERS = Object.freeze({
  preferred: 0.8,
  clear: 1,
  lowClearance: 5,
  unknown: 25,
  warning: 50,
});

export type SearchFailureReason = 'no_route' | 'aborted' | 'timeout' | 'node_limit';

export interface PathSearchSuccess {
  readonly status: 'found';
  readonly path: readonly GridPoint[];
  /** Cost in grid-cell units, including cell multipliers. */
  readonly totalCost: number;
  readonly expandedNodes: number;
}

export interface PathSearchFailure {
  readonly status: 'not_found';
  readonly reason: SearchFailureReason;
  readonly expandedNodes: number;
}

export type PathSearchResult = PathSearchSuccess | PathSearchFailure;

export interface PathSearchOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxExpandedNodes?: number;
  /** A proven lower bound; overrides `grid.minimumCostMultiplier`. */
  readonly minimumCostMultiplier?: number;
  /** Number of expanded nodes between event-loop yields; 0 disables yielding. */
  readonly yieldEvery?: number;
  /** Injectable for tests and non-Node schedulers. */
  readonly yieldControl?: () => Promise<void>;
  /** Monotonic clock in milliseconds; injectable for deterministic tests. */
  readonly clock?: () => number;
}

export interface HierarchicalSearchOptions extends PathSearchOptions {
  /** Width/height of one coarse cell in fine-grid cells. */
  readonly coarseFactor?: number;
  /** Initial fine-search corridor around the coarse path, in coarse cells. */
  readonly corridorPadding?: number;
  /** Number of one-cell corridor expansions before an optional full search. */
  readonly corridorExpansionSteps?: number;
  readonly fallbackToFullGrid?: boolean;
}

export interface EndpointSnapOptions {
  readonly maxDistanceCells: number;
  /** Optional additional eligibility check for otherwise traversable cells. */
  readonly allowed?: (point: GridPoint) => boolean;
}

export interface SnappedEndpoint {
  readonly requested: GridCoordinate;
  readonly point: GridPoint;
  readonly distanceCells: number;
  readonly shifted: boolean;
}

export interface PathValidation {
  readonly valid: boolean;
  readonly totalCost: number;
  readonly cells: readonly GridPoint[];
  readonly blockedAt?: GridPoint;
}

export interface SimplifyPathOptions {
  /** Maximum multiplicative cost increase allowed for a shortcut. Defaults to 1. */
  readonly maxCostRatio?: number;
  /** Do not introduce a worse risk class than the original sub-path. Defaults true. */
  readonly preserveRisk?: boolean;
  /** Path points that string pulling must retain, in route order. */
  readonly requiredPoints?: readonly GridPoint[];
  /** Optional cancellation/deadline checkpoint for potentially quadratic work. */
  readonly checkpoint?: () => void;
}

export interface GridRiskSegment {
  readonly risk: RouteRisk;
  readonly reasons: readonly string[];
  readonly from: GridPoint;
  readonly to: GridPoint;
  readonly startCellIndex: number;
  readonly endCellIndex: number;
  readonly cellCount: number;
}
