import ts from '../mods/node_modules/typescript/lib/typescript.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = JSON.parse(readFileSync(0, 'utf8'));
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, noEmit: true, strict: true,
  paths: { '@oh-my-diff/mod-api': [fileURLToPath(new URL('../mods/api.d.ts', import.meta.url))] } });
const checker = program.getTypeChecker();
const results = {};
for (const file of files) {
  const source = program.getSourceFile(file);
  const result = { commands: [], tools: 0, component: false, imports: false, keys: [], errors: [], registrations: [] };
  results[file] = result;
  result.errors = source.parseDiagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  const visit = node => {
    if (ts.isStringLiteralLike(node) && /^(alt\+[bdfrvx]|ctrl\+shift\+f|f8)$/i.test(node.text)) result.keys.push(node.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier) && /^\.\.?\//.test(node.moduleSpecifier.text)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.length > 0
        && bindings.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) result.imports = true;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isElementAccessExpression(node.expression)
          && checker.getTypeAtLocation(node.expression.expression).getSymbol()?.name === 'ModAPI'
          && !checker.getTypeAtLocation(node.expression.argumentExpression).isStringLiteral()) {
        result.errors.push('computed ModAPI method must have a literal type for static validation; use a const method name');
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]
          && ts.isStringLiteralLike(node.arguments[0]) && /^\.\.?\//.test(node.arguments[0].text)) result.imports = true;
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (declaration?.parent && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === 'ModAPI') {
        const name = declaration.name?.getText().replace(/^['"]|['"]$/g, '');
        const argument = node.arguments[0] && checker.getTypeAtLocation(node.arguments[0]);
        const literals = argument ? (argument.isUnion() ? argument.types : [argument]).filter(type => type.isStringLiteral()).map(type => type.value) : [];
        result.registrations.push({ method: name, names: literals });
        if (name === 'tool') result.tools++;
        if (name === 'component') result.component = true;
        if (name === 'command') {
          const type = node.arguments[0] && checker.getTypeAtLocation(node.arguments[0]);
          result.commands.push(type?.isStringLiteral() ? type.value : null);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
process.stdout.write(JSON.stringify(results));
