import type { WorkflowDef } from "../../shared/types.ts";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  workflows: () => req<{ id: string; name: string }[]>("/api/workflows"),
  workflow: (id: string) => req<WorkflowDef>(`/api/workflows/${id}`),
  saveWorkflow: (def: WorkflowDef) =>
    req<{ ok: boolean; errors?: { message: string }[] }>("/api/workflows", {
      method: "PUT",
      body: JSON.stringify(def),
    }),
  startRun: (workflowId: string, idempotencyKey?: string) =>
    req<{ runId: string; duplicated: boolean }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ workflowId, idempotencyKey: idempotencyKey || undefined }),
    }),
  run: (id: string) =>
    req<{
      run: any;
      workflow: WorkflowDef;
      execs: any[];
      logs: any[];
    }>(`/api/runs/${id}`),
  runs: () => req<any[]>("/api/runs"),
  pause: (id: string) => req(`/api/runs/${id}/pause`, { method: "POST" }),
  resume: (id: string) => req(`/api/runs/${id}/resume`, { method: "POST" }),
  cancel: (id: string) => req<{ killed: number }>(`/api/runs/${id}/cancel`, { method: "POST" }),
};
