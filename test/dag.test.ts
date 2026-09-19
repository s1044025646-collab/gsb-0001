import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCycle, evaluateExpression, validateDag } from "../shared/dag.ts";
import type { WorkflowDef } from "../shared/types.ts";

const wf = (edges: [string, string][]): WorkflowDef => {
  const ids = new Set<string>(["a", "b", "c", "d"]);
  edges.forEach(([s, t]) => {
    ids.add(s);
    ids.add(t);
  });
  return {
    id: "t",
    name: "t",
    nodes: [...ids].map((id) => ({
      id,
      kind: "task",
      label: id,
      position: { x: 0, y: 0 },
      config: {},
    })),
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
  };
};

test("无环 DAG 通过校验", () => {
  assert.equal(detectCycle(wf([["a", "b"], ["b", "c"], ["a", "c"]])), null);
  assert.equal(validateDag(wf([["a", "b"]])).length, 0);
});

test("检测到简单环 a->b->c->a", () => {
  const cycle = detectCycle(wf([["a", "b"], ["b", "c"], ["c", "a"]]));
  assert.ok(cycle);
  assert.ok(cycle!.includes("a") && cycle!.includes("b") && cycle!.includes("c"));
  assert.ok(validateDag(wf([["a", "b"], ["b", "a"]])).some((e) => e.cycle));
});

test("条件表达式求值", () => {
  assert.equal(evaluateExpression("$input > 3", "5"), true);
  assert.equal(evaluateExpression("$input > 3", "2"), false);
  assert.equal(evaluateExpression('$input == "ok"', "ok"), true);
  assert.equal(evaluateExpression("$input != 0", "5"), true);
  assert.equal(evaluateExpression("$input != 0", "0"), false);
});
