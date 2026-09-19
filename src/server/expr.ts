export function evalExpression(expression: string, context: Record<string, unknown>): boolean {
  const expr = expression.trim();
  // token whitelist: $variables, numbers, true/false/null, () and comparison/logic/arithmetic operators
  const token = /\s*(\$[A-Za-z_]\w*|\d+(?:\.\d+)?|true|false|null|>=|<=|===|!==|==|!=|&&|\|\||[><+\-*/%!()])/y;
  let pos = 0;
  let m: RegExpExecArray | null;
  while (pos < expr.length) {
    token.lastIndex = 0;
    m = token.exec(expr.slice(pos));
    if (!m) break;
    pos += m[0].length;
  }
  if (pos !== expr.length) throw new Error(`unsafe or invalid expression: ${expr}`);
  const normalized = expr.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) =>
    name in context ? JSON.stringify(context[name]) : "null"
  );
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${normalized});`);
  return Boolean(fn());
}
