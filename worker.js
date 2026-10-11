/**
 * 拾集 Cloud API v1.8.6 — deploy as a Cloudflare Worker.
 * Bind Cloudflare D1 database as DB; add Worker Secret SJ_TOKEN (min 32 chars).
 * Allowed browser origin is fixed to the user's GitHub Pages domain.
 * The secret must NOT be committed to GitHub or embedded in index.html.
 */
const ALLOWED_ORIGIN = 'https://sweijue.github.io';
const MAX_STATE_BYTES = 1_500_000;
// Gemma 4 supports multilingual OCR and image input; no Meta Llama 3.2 agreement step.
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const encoder = new TextEncoder();
const headersFor = origin => ({
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'Vary':'Origin',
  ...(origin === ALLOWED_ORIGIN ? {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Shiji-Token',
    'Access-Control-Max-Age':'86400'
  }:{}),
});
function reply(body,status,origin){return new Response(JSON.stringify(body),{status,headers:headersFor(origin)});}
async function safeEquals(a,b){
  if(!a||!b)return false;
  const [A,B] = await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',encoder.encode(s))));
  const x=new Uint8Array(A),y=new Uint8Array(B);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
async function schema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id=1),
    revision INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    shared_text TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'shortcut',
    received_at INTEGER NOT NULL,
    delivered_at INTEGER DEFAULT NULL
  )`).run();
  await db.prepare("INSERT OR IGNORE INTO app_state (id,revision,content,updated_at) VALUES (1,0,'{}',0)").run();
}
async function readJSON(request,limit=MAX_STATE_BYTES){
  const text=await request.text();
  if(encoder.encode(text).length>limit)throw Object.assign(new Error('payload-too-large'),{status:413});
  try {return JSON.parse(text)}catch{throw Object.assign(new Error('invalid-json'),{status:400})}
}
function extractUrl(v){
  const text=String(v||'').trim();
  // Social apps may share a sentence containing a single URL.
  const match=text.match(/https?:\/\/[^\s<>"'，。]+/i);
  if(!match)return '';
  try{const u=new URL(match[0]);return ['https:','http:'].includes(u.protocol)&&u.href.length<=2500?u.href:''}catch{return ''}
}

// Fetch only public HTTPS image hosts, without redirects, to reduce SSRF risk.
function checkExternalImageURL(input){
 const u=new URL(String(input||''));
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw Object.assign(new Error('image-https-required'),{status:400});
 const h=u.hostname.toLowerCase();
 if(h==='localhost'||h==='metadata.google.internal'||h.endsWith('.local')||h.endsWith('.internal')||h.endsWith('.localhost')||h.endsWith('.test')||h.endsWith('.example')||h.endsWith('.invalid')||h.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(h)||!h.includes('.'))throw Object.assign(new Error('image-host-not-allowed'),{status:400});
 if(u.href.length>3000)throw Object.assign(new Error('image-url-too-long'),{status:400});
 return u;
}
function bytesToBase64(bytes){
 let raw='';
 for(let p=0;p<bytes.length;p+=16384)raw+=String.fromCharCode(...bytes.subarray(p,p+16384));
 return btoa(raw);
}
async function imagePayload(body){
 const direct=String(body.imageData||'');
 if(direct){
  if(!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(direct)||direct.length>2_850_000)throw Object.assign(new Error('invalid-image-data'),{status:400});
  return direct;
 }
 const u=checkExternalImageURL(body.imageUrl);
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),6500);
 try{
  const resp=await fetch(u.href,{redirect:'manual',signal:ctrl.signal,headers:{'Accept':'image/jpeg,image/png,image/webp'}});
  if(!resp.ok)throw Object.assign(new Error('image-unavailable'),{status:422});
  const mime=String(resp.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['image/jpeg','image/png','image/webp'].includes(mime))throw Object.assign(new Error('unsupported-image-type'),{status:415});
  const size=Number(resp.headers.get('content-length')||0);
  if(size>2_050_000)throw Object.assign(new Error('image-too-large'),{status:413});
  const binary=new Uint8Array(await resp.arrayBuffer());
  if(binary.byteLength>2_050_000)throw Object.assign(new Error('image-too-large'),{status:413});
  if(binary.byteLength<200)throw Object.assign(new Error('empty-image'),{status:422});
  return `data:${mime};base64,${bytesToBase64(binary)}`;
 }catch(e){if(e.name==='AbortError')throw Object.assign(new Error('image-fetch-timeout'),{status:504});throw e}
 finally{clearTimeout(timer)}
}
function safeArray(value,max=8){return Array.isArray(value)?value.filter(x=>typeof x==='string').map(s=>s.trim().slice(0,140)).filter(Boolean).slice(0,max):[]}
function parseVisionModel(out){
 const candidate=out?.choices?.[0]?.message?.content ?? out?.response ?? out?.result ?? out;
 const value=typeof candidate==='string'?candidate:Array.isArray(candidate)?candidate.map(part=>part.text||'').join('\n'):JSON.stringify(candidate||'');
 const stripped=value.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
 let raw={};
 try{raw=JSON.parse(stripped)}catch{
  const start=stripped.indexOf('{'),end=stripped.lastIndexOf('}');
  if(start>=0&&end>start){try{raw=JSON.parse(stripped.slice(start,end+1))}catch{}}
 }
 const structured=raw&&typeof raw==='object'&&!Array.isArray(raw);
 return {
  summary:String(structured&&raw.summary||(!Object.keys(raw||{}).length?stripped:'')).slice(0,240),
  visibleText:safeArray(raw.visibleText,12),
  products:safeArray(raw.products,8),
  places:safeArray(raw.places,6),
  addresses:safeArray(raw.addresses,4),
  tags:safeArray(raw.tags,8),
  uncertain:String(raw.uncertain||'').slice(0,180)
 };
}
function modelFailure(e){
 const original=String(e?.message||e||'Unknown model failure');
 const detail=original.replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/https?:\/\/\S+/g,'[URL]').slice(0,240);
 let reason='model-error';
 if(/\b3036\b|neuron|daily.+(limit|quota)|allocation|quota.exceed/i.test(original))reason='daily-quota';
 else if(/\b3040\b|capacity|too.busy|overload/i.test(original))reason='model-busy';
 else if(/\b5035\b|paid.plan|requires.+paid/i.test(original))reason='paid-plan';
 else if(/\b5016\b|model.agreement|accept.+(terms|license)/i.test(original))reason='model-license';
 else if(/\b5004\b|invalid.*(data|image|base64)|image.*invalid/i.test(original))reason='bad-image-input';
 else if(/\b3006\b|request.too.large|payload.too.large/i.test(original))reason='image-too-large';
 else if(/\b5007\b|\b3042\b|no.such.model|model.not.found/i.test(original))reason='model-unavailable';
 return {error:'vision-inference-failed',reason,detail};
}

export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';
    if(origin && origin!==ALLOWED_ORIGIN)return reply({error:'origin-not-allowed'},403,origin);
    if(request.method==='OPTIONS'){
      if(origin!==ALLOWED_ORIGIN)return reply({error:'origin-not-allowed'},403,origin);
      return new Response(null,{status:204,headers:headersFor(origin)});
    }
    const pathname=new URL(request.url).pathname.replace(/\/+$/,'')||'/';
    if(pathname==='/health'&&request.method==='GET')return reply({ok:true,version:'1.8.6',configured:!!env.DB&&!!env.SJ_TOKEN,visionConfigured:!!env.AI,visionModel:VISION_MODEL},200,origin);
    if(!env.DB||!env.SJ_TOKEN||String(env.SJ_TOKEN).length<32)return reply({error:'server-not-configured'},503,origin);
    try{
      let body=null;
      if(['POST','PUT'].includes(request.method))body=await readJSON(request,pathname==='/api/state'?MAX_STATE_BYTES:(pathname==='/api/vision'?2_900_000:25_000));
      const provided=request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')
        ||request.headers.get('X-Shiji-Token')
        ||(pathname==='/api/collect'?body?.token:null);
      if(!await safeEquals(String(provided||''),String(env.SJ_TOKEN)))return reply({error:'unauthorized'},401,origin);
      await schema(env.DB);
      if(pathname==='/api/vision'&&request.method==='POST'){
        if(!env.AI)return reply({error:'vision-ai-binding-missing'},503,origin);
        if(!body||(!body.imageData&&!body.imageUrl))return reply({error:'image-required'},400,origin);
        const image=await imagePayload(body);
        const prompt=`You inspect ONE photo shared in a social post. Read visible product labels, store signs, menus and location clues in any language (Chinese, Japanese, Korean, English). Return only valid JSON without markdown with these keys: summary (short Traditional Chinese description, not a guess), visibleText (exact readable text only, array), products (specific product names ONLY when readable on packaging, array), places (specific store/place names ONLY with clear evidence, array), addresses (only readable full addresses, array), tags (short Traditional Chinese topics grounded in photo, array), uncertain (things that are not readable or might be wrong, string). Never infer an exact shop, product, price or country just from generic objects; leave arrays empty when unsure.`;
        try{
          const output=await env.AI.run(VISION_MODEL,{
            messages:[
              {role:'system',content:'You read social media images in Chinese, Japanese, Korean, and English. Only return facts clearly supported by the image.'},
              {role:'user',content:[
                {type:'text',text:prompt},
                {type:'image_url',image_url:{url:image}}
              ]}
            ],
            chat_template_kwargs:{enable_thinking:false},
            max_completion_tokens:650,
            temperature:0.1
          });
          return reply({ok:true,model:VISION_MODEL,analysis:parseVisionModel(output)},200,origin);
        }catch(e){return reply(modelFailure(e),502,origin)}
      }
      if(pathname==='/api/state'&&request.method==='GET'){
        const r=await env.DB.prepare('SELECT revision,content,updated_at FROM app_state WHERE id=1').first();
        return reply({revision:r.revision,updatedAt:r.updated_at,data:r.revision?JSON.parse(r.content):null},200,origin);
      }
      if(pathname==='/api/state'&&request.method==='PUT'){
        if(!Number.isInteger(body?.expectedRevision)||body.expectedRevision<0||typeof body?.data!=='object'||body.data===null||Array.isArray(body.data))return reply({error:'invalid-state'},400,origin);
        if(!Array.isArray(body.data.items)||!Array.isArray(body.data.shoppingLists)||!Array.isArray(body.data.travelPlans))return reply({error:'invalid-collections'},400,origin);
        const content=JSON.stringify(body.data);
        if(encoder.encode(content).length>MAX_STATE_BYTES-1000)return reply({error:'state-too-large'},413,origin);
        const res=await env.DB.prepare('UPDATE app_state SET content=?, revision=revision+1, updated_at=? WHERE id=1 AND revision=?')
          .bind(content,Date.now(),body.expectedRevision).run();
        if(!res.meta?.changes){
          const latest=await env.DB.prepare('SELECT revision FROM app_state WHERE id=1').first();
          return reply({error:'revision-conflict',revision:latest?.revision},409,origin);
        }
        return reply({ok:true,revision:body.expectedRevision+1},200,origin);
      }
      if(pathname==='/api/collect'&&request.method==='POST'){
        const url=extractUrl(body?.url||body?.text);
        if(!url)return reply({error:'valid-url-required'},400,origin);
        const sharedText=String(body.sharedText||body.text||'').slice(0,9000);
        await env.DB.prepare(`INSERT INTO inbox (url,shared_text,source,received_at,delivered_at)
          VALUES (?,?,'shortcut',?,NULL)
          ON CONFLICT(url) DO UPDATE SET shared_text=excluded.shared_text,received_at=excluded.received_at,delivered_at=NULL`)
          .bind(url,sharedText,Date.now()).run();
        return reply({ok:true,message:'已收到，開啟拾集後將自動同步',url},200,origin);
      }
      if(pathname==='/api/inbox'&&request.method==='GET'){
        const result=await env.DB.prepare('SELECT id,url,shared_text,received_at FROM inbox WHERE delivered_at IS NULL ORDER BY id LIMIT 35').all();
        return reply({items:result.results||[]},200,origin);
      }
      if(pathname==='/api/inbox/ack'&&request.method==='POST'){
        const ids=Array.isArray(body?.ids)?body.ids.filter(x=>Number.isInteger(x)&&x>0).slice(0,35):[];
        if(!ids.length)return reply({ok:true,acked:0},200,origin);
        let n=0;
        for(const id of ids){const r=await env.DB.prepare('UPDATE inbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL').bind(Date.now(),id).run();n+=r.meta?.changes||0}
        return reply({ok:true,acked:n},200,origin);
      }
      return reply({error:'not-found'},404,origin);
    }catch(e){return reply({error:e.message||'internal-error'},e.status||500,origin)}
  }
};
