import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const request=JSON.parse(process.argv[1]);
const root=realpathSync(process.cwd());
const observed=new Map();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function pathFor(name) {
  if(typeof name!=='string'||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) throw Error('analysis_path_invalid');
  const path=resolve(root,name);
  if(!path.startsWith(root+sep)) throw Error('analysis_path_invalid');
  let current=root;
  for(const part of name.split('/')) {
    current=resolve(current,part);
    if(lstatSync(current).isSymbolicLink()) throw Error('analysis_symlink_denied');
  }
  if(realpathSync(path)!==path) throw Error('analysis_path_invalid');
  return path;
}
function listing(name,limit) {
  const entries=[];
  const ignored=new Set(['node_modules','target','dist','build','vendor','vendors','venv','__pycache__','coverage']);
  function walk(directory,prefix) {
    for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(item.isDirectory()&&(item.name.startsWith('.')||ignored.has(item.name))) continue;
      const relative=prefix?prefix+'/'+item.name:item.name;
      if(item.isSymbolicLink()) { if(/\.(rs|py|ts|tsx|js|jsx|mjs|cjs|java)$/.test(relative)) entries.push({path:relative,kind:'symlink',size:0,mtime_ms:0}); continue; }
      const stat=lstatSync(resolve(directory,item.name));
      if(item.isDirectory()) walk(resolve(directory,item.name),relative);
      else if(/\.(rs|py|ts|tsx|js|jsx|mjs|cjs|java)$/.test(relative)) entries.push({path:relative,kind:'file',size:stat.size,mtime_ms:stat.mtimeMs});
      if(entries.length>limit) return;
    }
  }
  if(name) walk(pathFor(name),name); else walk(root,'');
  return {entries:entries.slice(0,limit),truncated:entries.length>limit};
}
function files(names,readText,hash) {
  const result={};
  for(const name of names) {
    const path=pathFor(name);
    const stat=lstatSync(path);
    if(!stat.isFile()) { result[name]=null; continue; }
    const raw=readFileSync(path);
    const digest=sha(raw);
    observed.set(name,digest);
    result[name]=readText?{text:raw.toString('utf8'),sha256:digest}:{kind:'file',size:raw.length,mtime_ms:stat.mtimeMs,...(hash?{sha256:digest}:{})};
  }
  return {files:result};
}
const handlers=new Map();
const api={
  artifact_output:request.raw_html===true,
  provide(){},
  tool(spec,handler){handlers.set(spec.name,handler)},
  host:{call(operation,args){
    if(operation==='workspace.fingerprint') {
      if(args?.expected&&args.expected!==request.candidate) throw Error('analysis_candidate_stale');
      for(const [name,digest] of observed) if(sha(readFileSync(pathFor(name)))!==digest) throw Error('analysis_source_stale');
      return {candidate_sha256:request.candidate};
    }
    if(operation==='workspace.list') return listing(args.path||'',args.max_entries||20000);
    if(operation==='workspace.read') return files(args.paths,true,false);
    if(operation==='workspace.stat') return files(args.paths,false,args.hash===true);
    throw Error('analysis_host_operation_unsupported:'+operation);
  }}
};
const source=readFileSync(0,'utf8');
try {
  const module=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64'));
  module.default(api);
  const handler=handlers.get(request.tool);
  if(!handler) throw Error('analysis_tool_unavailable');
  const value=await handler(request.input);
  process.stdout.write(request.raw_html===true?value.html:JSON.stringify(value));
} catch(error) {
  process.stderr.write(String(error?.message||error));
  process.exitCode=1;
}
