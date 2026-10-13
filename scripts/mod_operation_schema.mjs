import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../mods/node_modules/typescript/lib/typescript.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export function shareSchemas(operations) {
  const counts = new Map();
  const names = new Map();
  const definitions = {};
  const map = (schema, visit) => {
    if (typeof schema !== 'object') return schema;
    const result = { ...schema };
    for (const key of ['anyOf', 'allOf', 'prefixItems']) {
      if (schema[key]) result[key] = schema[key].map(child => map(child, visit));
    }
    if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, map(child, visit)]));
    for (const key of ['items', 'additionalProperties']) {
      if (key in schema) result[key] = map(schema[key], visit);
    }
    return visit(schema, result);
  };
  const transform = visit => Object.fromEntries(Object.entries(operations).map(([operation, fields]) =>
    [operation, Object.fromEntries(Object.entries(fields).map(([field, schema]) => [field, map(schema, visit)]))]));
  transform(schema => {
    const key = JSON.stringify(schema);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return schema;
  });
  const shared = transform((schema, result) => {
    const key = JSON.stringify(schema);
    if (key.length < 80 || counts.get(key) === 1) return result;
    if (!names.has(key)) names.set(key, String(names.size));
    const name = names.get(key);
    definitions[name] = result;
    return { $ref: `#/$defs/${name}` };
  });
  return { operations: shared, $defs: definitions };
}

export function operationSchemas(source = resolve(root, 'mods/api.d.ts')) {
  const program = ts.createProgram([source], { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(source);
  const declaration = file.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'HostOperations');
  if (!declaration) throw new Error('Missing HostOperations interface');
  const active = new Set();
  function schema(type) {
    if (type.aliasSymbol?.name === 'Json') {
      const kinds = new Set(type.isUnion() ? type.types.map(part => {
        if (part.flags & ts.TypeFlags.Null) return 'null';
        if (part.flags & ts.TypeFlags.String) return 'string';
        if (part.flags & ts.TypeFlags.Number) return 'number';
        if (part.flags & ts.TypeFlags.BooleanLiteral) return String(part.intrinsicName);
        if (checker.isArrayType(part) && checker.getTypeArguments(part)[0] === type) return 'array';
        if ((part.flags & ts.TypeFlags.Object) && !part.getProperties().length &&
            checker.getIndexTypeOfType(part, ts.IndexKind.String) === type) return 'object';
        return 'unsupported';
      }) : []);
      if (kinds.size !== 7 || ['null', 'string', 'number', 'true', 'false', 'array', 'object'].some(kind => !kinds.has(kind))) {
        throw new Error('Unsupported Json alias: expected the recursive JSON value type');
      }
      return {};
    }
    if (type.flags & ts.TypeFlags.Never) return false;
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.flags & ts.TypeFlags.String) return { type: 'string' };
    if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true' };
    if (type.flags & ts.TypeFlags.TemplateLiteral) {
      const spelling = checker.typeToString(type);
      const format = {
        '`${string}.${string}`': 'dotted-string',
        '`#${string}`': 'hash-prefixed-string',
      }[spelling];
      if (!format) throw new Error(`Unsupported template literal: ${spelling}`);
      return { type: 'string', format };
    }
    if (active.has(type)) throw new Error(`Unsupported recursive type: ${checker.typeToString(type)}`);
    active.add(type);
    try {
      if (type.isUnion()) return { anyOf: type.types.map(schema) };
      if (type.isIntersection()) return { allOf: type.types.map(schema) };
      if (checker.isTupleType(type)) {
        const flags = type.target.elementFlags;
        if (flags.some(flag => flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic))) throw new Error('Unsupported variadic tuple');
        return { type: 'array', prefixItems: checker.getTypeArguments(type).map((member, index) => {
          if ((flags[index] & ts.ElementFlags.Optional) && member.isUnion()) {
            return { anyOf: member.types.filter(part => !(part.flags & ts.TypeFlags.Undefined)).map(schema) };
          }
          return schema(member);
        }),
          minItems: flags.filter(flag => flag & ts.ElementFlags.Required).length, maxItems: flags.length };
      }
      if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0]) };
      if (type.flags & ts.TypeFlags.Object) {
        if (type.getCallSignatures().length || type.getConstructSignatures().length) throw new Error('Function types are not JSON');
        const properties = {};
        const required = [];
        for (const property of type.getProperties()) {
          let member = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? declaration);
          const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
          if (optional && member.isUnion()) {
            const members = member.types.filter(part => !(part.flags & ts.TypeFlags.Undefined));
            properties[property.name] = members.length === 1 ? schema(members[0]) : { anyOf: members.map(schema) };
          } else properties[property.name] = schema(member);
          if (!optional) required.push(property.name);
        }
        const indexes = checker.getIndexInfosOfType(type);
        if (indexes.some(index => !(index.keyType.flags & ts.TypeFlags.String))) throw new Error('Unsupported non-string index signature');
        return { type: 'object', properties, required,
          ...(indexes.length ? { additionalProperties: schema(indexes[0].type) } : {}) };
      }
      throw new Error(`Unsupported type: ${checker.typeToString(type)}`);
    } finally { active.delete(type); }
  }
  return Object.fromEntries(checker.getTypeAtLocation(declaration).getProperties().map(operation => {
    const type = checker.getTypeOfSymbolAtLocation(operation, operation.valueDeclaration);
    return [operation.name, Object.fromEntries(['arguments', 'result'].map(key => {
      const member = type.getProperty(key);
      if (!member) throw new Error(`Missing ${operation.name}.${key}`);
      return [key, schema(checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration))];
    }))];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const outputIndex = args.indexOf('--output');
    if (args.some((arg, i) => arg !== '--check' && arg !== '--output' && !(outputIndex !== -1 && i === outputIndex + 1)) ||
        (outputIndex !== -1 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--')))) throw new Error('Usage: mod_operation_schema.mjs [--check] [--output PATH]');
    const output = outputIndex === -1 ? resolve(root, 'runtime/omd/src/mods/operation_schema.json') : resolve(args[outputIndex + 1]);
    const schemas = operationSchemas();
    const shared = shareSchemas(schemas);
    const section = values => Object.entries(values).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n');
    const text = `{\n  "operations": {\n${section(shared.operations)}\n  },\n  "$defs": {\n${section(shared.$defs)}\n  }\n}\n`;
    if (check) {
      if (readFileSync(output, 'utf8') !== text) throw new Error('HostOperations schema drift; regenerate in the native scratch tree and sync');
    } else writeFileSync(output, text);
    console.log(`${check ? 'Checked' : 'Generated'} request/result schemas for ${Object.keys(schemas).length} host operations`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
