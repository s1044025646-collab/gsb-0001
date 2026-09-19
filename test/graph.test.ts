import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAndCompile, GraphError } from "../src/server/graph";
import { evalExpression } from "../src/server/expr";

void assert;

test("accepts a valid DAG", () => {
  const g = validateAndCompile({
    nodes: [
      { id: "a", kind: "start", label: "a" },
      { id: "b", kind: "task", label: "b" },
      { id: "c", kind: "end", label: "c" },
    ],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ],
  });
  assert.deepEqual(g.startNodes, ["a"]);
});

test("detects a direct cycle", () => {
  assert.throws(
    () =>
      validateAndCompile({
        nodes: [
          { id: "a", kind: "task", label: "a" },
          { id: "b", kind: "task", label: "b" },
        ],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "b", target: "a" },
        ],
      }),
    /cycle detected/
  );
});

test("detects a self loop", () => {
  assert.throws(
    () =>
      validateAndCompile({
        nodes: [{ id: "a", kind: "task", label: "a" }],
        edges: [{ id: "e1", source: "a", target: "a" }],
      }),
    /self loop/
  );
});

test("rejects dangling edge", () => {
  assert.throws(
    () =>
      validateAndCompile({
        nodes: [{ id: "a", kind: "start", label: "a" }],
        edges: [{ id: "e1", source: "a", target: "ghost" }],
      }),
    GraphError
  );
});

test("condition edges require branch annotation", () => {
  assert.throws(
    () =>
      validateAndCompile({
        nodes: [
          { id: "c", kind: "condition", label: "c" },
          { id: "t", kind: "task", label: "t" },
        ],
        edges: [{ id: "e1", source: "c", target: "t" }],
      }),
    /branch true\/false/
  );
});

test("expression evaluator resolves upstream variables", () => {
  assert.equal(evalExpression("$v > 10", { v: 14 }), true);
  assert.equal(evalExpression("$v > 10 && $ok", { v: 4, ok: true }), false);
});

test("expression evaluator rejects injection", () => {
  assert.throws(() => evalExpression("process.exit(1)", {}), /unsafe/);
  assert.throws(() => evalExpression("constructor.constructor('')", {}), /unsafe/);
});


