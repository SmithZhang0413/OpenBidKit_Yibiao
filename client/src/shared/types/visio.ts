export type VisioDiagramType =
  | 'flowchart'
  | 'cross_functional_flowchart'
  | 'org_chart'
  | 'block_diagram'
  | 'data_flow_diagram'
  | 'network_diagram';

export type VisioDiagramStep = 'requirements' | 'plan' | 'result';
export type VisioPageOrientation = 'portrait' | 'landscape';
export type VisioDiagramTypeMode = 'auto' | 'manual';
export type VisioTaskStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface VisioDiagramRequirements {
  title: string;
  requirementText: string;
  diagramTypeMode: VisioDiagramTypeMode;
  diagramType?: VisioDiagramType;
  pageOrientation: VisioPageOrientation;
}

export interface VisioDiagramGroup {
  id: string;
  title: string;
  order?: number;
}

export interface VisioDiagramNode {
  id: string;
  text: string;
  kind: string;
  group_id?: string;
  row?: number;
  column?: number;
  width?: number;
  height?: number;
  style_role?: 'primary' | 'secondary' | 'decision' | 'external';
}

export interface VisioDiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: 'normal' | 'conditional' | 'dependency' | 'bidirectional';
}

export interface VisioDiagramPlan {
  schema_version: 1;
  title: string;
  diagram_type: VisioDiagramType;
  page: {
    name: string;
    orientation: VisioPageOrientation;
  };
  groups?: VisioDiagramGroup[];
  nodes: VisioDiagramNode[];
  edges: VisioDiagramEdge[];
  notes?: string[];
}

export interface VisioArtifactManifestPreview {
  page_index: number;
  page_name: string;
  file_name: string;
  bytes: number;
}

export interface VisioArtifactManifest {
  manifest_version: number;
  generated_at: string;
  title: string;
  diagram_type: VisioDiagramType;
  plan_schema_version: number;
  node_count: number;
  edge_count: number;
  document: {
    file_name: string;
    bytes: number;
  };
  previews: VisioArtifactManifestPreview[];
  page_summaries: unknown[];
}

export interface VisioDiagramArtifact {
  artifactRevision: string;
  planRevision: number;
  generatedAt: string;
  outputDir: string;
  documentPath: string;
  planPath: string;
  manifestPath: string;
  previewPaths: string[];
  manifest: VisioArtifactManifest;
}

export interface VisioDiagramTaskState {
  task_id: string;
  type: 'visio-plan-generation' | 'visio-rendering';
  status: VisioTaskStatus;
  progress: number;
  logs: string[];
  stats?: Record<string, unknown>;
  error?: string;
  started_at: string;
  updated_at: string;
}

export interface VisioDiagramState {
  step: VisioDiagramStep;
  requirements: VisioDiagramRequirements;
  plan?: VisioDiagramPlan;
  planRevision: number;
  activeArtifact?: VisioDiagramArtifact;
  planTask?: VisioDiagramTaskState;
  renderTask?: VisioDiagramTaskState;
}

export interface VisioMcpRuntimeStatus {
  supported: boolean;
  available: boolean;
  mode: 'bundled' | 'custom';
  source: string;
  reason: string;
}

export interface VisioMcpComponentStatus {
  phase: 'stopped' | 'starting' | 'ready' | 'closing' | 'faulted';
  healthy: boolean;
  message: string;
  updated_at: string;
  last_error: string;
  runtime: VisioMcpRuntimeStatus | null;
  server: {
    name?: string;
    version?: string;
    tool_count: number;
  } | null;
  process_id: number | null;
}

export interface VisioMcpSelfCheckResult {
  success: true;
  checked_at: string;
  duration_ms: number;
  server: {
    name?: string;
    version?: string;
  } | null;
  tools: string[];
  runtime: VisioMcpRuntimeStatus | null;
}