// WHP EPT liquidity discovery and signed-quote intake. No custody or settlement keys.
import http from 'node:http';
import {createHash, createPublicKey, randomBytes, verify} from 'node:crypto';
import {mkdirSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

export const PREFIX = 'WHP-EPT-LIQUIDITY-QUOTE/v1\n';
export const ID = 'ept-15000';
const BASE = `/liquidity/offers/${ID}`;
const EXCLUSIONS = ['UPSTREAM_EPT_ESTATE','UNRELATED_IP','UNRELATED_ASSETS','WHP_EQUITY','PERSONAL_GUARANTEE','BLANKET_LIEN','CROSS_COLLATERALIZATION'];
const hash = x => createHash('sha256').update(x).digest('hex');
const fail = (code, status=422) => {throw Object.assign(new Error(code), {status});};
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, max=512) => typeof x === 'string' && x.length > 0 && x.length <= max;
function keys(o, expected) {
  if (!obj(o) || Object.keys(o).some(k => !expected.includes(k)) || expected.some(k => !Object.hasOwn(o,k))) fail('SCHEMA_MISMATCH');
}
export function canonical(v, depth=0) {
  if(depth>16) fail('JSON_TOO_DEEP',400);
  if(v===null || typeof v==='boolean' || typeof v==='string') return JSON.stringify(v);
  if(Array.isArray(v)) return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';
  if(obj(v)) return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k],depth+1)).join(',')+'}';
  fail('ONLY_STRINGS_BOOLEANS_NULL_ARRAYS_OBJECTS',400);
}
function amount(s, places=6) {
  if(typeof s!=='string' || !new RegExp(`^(0|[1-9][0-9]{0,12})(\\.[0-9]{1,${places}})?$`).test(s)) fail('INVALID_DECIMAL_AMOUNT');
  const [whole,frac='']=s.split('.');
  return BigInt(whole)*10n**BigInt(places)+BigInt(frac.padEnd(places,'0'));
}
const date = s => typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s;

export function makeOffer(origin, environment='LIVE') {
  if(!['LIVE','TEST'].includes(environment)) fail('INVALID_ENVIRONMENT',500);
  const u=new URL(origin);
  if(u.origin!==origin || u.username || u.password || (environment==='LIVE' && u.protocol!=='https:')) fail('INVALID_PUBLIC_ORIGIN',500);
  return {
    protocol:'WHP-Decision-Integrity-v1', schema_version:'1.0.0', offer_id:ID,
    transaction_type:'DUAL_MODE_OFFER', status:'OPEN_FOR_SIGNED_QUOTES', environment,
    seller:{name:'Justin Bowen',capacity:'INDIVIDUAL'},
    asset:{classification:'ACCOUNT',article_12_state:'CONTROL_NOT_YET_ESTABLISHED',origin:'EPT_INTERNAL_USE_LICENSE',
      title:'The Elemental Properties of True',licensed_field:'Bounded internal constitutional and governance use by WHP',
      face_value:{amount:'15000.00',currency:'USD'},account_debtor:'Wheeler Hubbell Publishing, Inc.',
      evidence_status:'PAYMENT_RIGHT_DESCRIBED_BY_SELLER; LEGAL_EFFECT_NOT_ATTESTED_BY_THIS_SERVICE',
      executed_license_sha256:null,control_record_uri:null},
    funding:{partial_funding_permitted:true,modes:['PURCHASE','SECURED_ADVANCE'],mode_preference:null},
    exclusions:EXCLUSIONS,
    settlement:{network:environment==='LIVE'?'eip155:8453':'eip155:84532',asset:'USDC',
      execution_enabled:false,recipient:null,escrow_contract:null},
    endpoints:{offer:origin+BASE,quote:origin+BASE+'/quote',validate:origin+BASE+'/validate-quote',
      schema:origin+'/schemas/quote.json',activity:origin+BASE+'/activity'},
    authorization:{quote_signature_scheme:'Ed25519',signature_format:'hex',public_key_format:'JWK',
      signed_message_prefix:PREFIX,canonicalization:'WHP sorted-key JSON v1; no JSON numbers; UTF-8; no whitespace',
      signature_scope:'Origin, environment, offer hash, identity, all terms, nonce and expiry'},
    boundaries:{human_underwriting_required:false,receipt_is_acceptance:false,quote_is_funded_capital:false,
      custody:false,upstream_rights_transferred:false,live_completion_proven:false}
  };
}

export function validateQuote(envelope, offer, now=Date.now(), checkExpiry=true) {
  keys(envelope,['quote','authorization']);
  const q=envelope.quote;
  keys(q,['version','environment','origin','offer_id','offer_sha256','quote_id','nonce','issued_at','expires_at',
    'mode','capital_provider','funding','acquired_or_collateral_face_usd','repayment','recourse','exclusions',
    'approval','settlement','documents']);
  if(q.version!=='1.0.0' || q.environment!==offer.environment || q.origin!==new URL(offer.endpoints.offer).origin ||
      q.offer_id!==ID || q.offer_sha256!==hash(canonical(offer))) fail('OFFER_BINDING_MISMATCH');
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(q.quote_id) || !/^[a-f0-9]{64}$/.test(q.nonce)) fail('INVALID_QUOTE_ID_OR_NONCE');
  if(!date(q.issued_at)||!date(q.expires_at)||Date.parse(q.expires_at)<=Date.parse(q.issued_at)) fail('INVALID_QUOTE_WINDOW');
  if(checkExpiry && (Date.parse(q.issued_at)>now+60000 || Date.parse(q.expires_at)<=now)) fail('QUOTE_NOT_CURRENT');
  if(!offer.funding.modes.includes(q.mode)) fail('UNSUPPORTED_MODE');
  keys(q.capital_provider,['name','signing_key_sha256','wallet','authority_reference']);
  if(!text(q.capital_provider.name,200)||!text(q.capital_provider.authority_reference,1000) ||
    !/^[a-f0-9]{64}$/.test(q.capital_provider.signing_key_sha256) ||
    !/^0x[0-9a-fA-F]{40}$/.test(q.capital_provider.wallet)) fail('INVALID_CAPITAL_PROVIDER');
  keys(q.funding,['currency','gross','net_to_seller','withheld_costs','provider_borne_costs','cost_breakdown']);
  if(q.funding.currency!=='USDC') fail('WRONG_FUNDING_CURRENCY');
  const gross=amount(q.funding.gross), net=amount(q.funding.net_to_seller), costs=amount(q.funding.withheld_costs);
  amount(q.funding.provider_borne_costs);
  if(gross<=0n||net<=0n||gross!==net+costs) fail('FUNDING_MATH_MISMATCH');
  if(!Array.isArray(q.funding.cost_breakdown)||q.funding.cost_breakdown.length>32) fail('INVALID_COST_BREAKDOWN');
  let total=0n;
  for(const row of q.funding.cost_breakdown){keys(row,['description','amount']);if(!text(row.description,200))fail('INVALID_COST_DESCRIPTION');total+=amount(row.amount);}
  if(total!==costs) fail('COST_BREAKDOWN_MISMATCH');
  const face=amount(q.acquired_or_collateral_face_usd,2);
  if(face<=0n || face>1500000n) fail('FACE_AMOUNT_OUTSIDE_PAYMENT_RIGHT');
  keys(q.recourse,['ordinary_obligor_nonpayment','direct_borrower_recourse','seller_representation_recourses','terms']);
  if(typeof q.recourse.direct_borrower_recourse!=='boolean'||!text(q.recourse.ordinary_obligor_nonpayment)||
    !Array.isArray(q.recourse.seller_representation_recourses)||q.recourse.seller_representation_recourses.length>32||
    q.recourse.seller_representation_recourses.some(x=>!text(x))||!text(q.recourse.terms,4000)) fail('INVALID_RECOURSE');
  if(q.mode==='PURCHASE') {if(q.repayment!==null)fail('PURCHASE_CANNOT_HIDE_REPAYMENT');}
  else {
    keys(q.repayment,['obligor','principal','total_due','maturity','interest_and_fee_terms','surplus_treatment']);
    if(q.repayment.obligor!=='Justin Bowen'||amount(q.repayment.principal)!==gross||amount(q.repayment.total_due)<gross||
      !date(q.repayment.maturity)||Date.parse(q.repayment.maturity)<=Date.parse(q.issued_at)||
      !text(q.repayment.interest_and_fee_terms,4000)||!text(q.repayment.surplus_treatment,2000)) fail('INVALID_REPAYMENT_TERMS');
  }
  if(canonical(q.exclusions)!==canonical(EXCLUSIONS)) fail('EXCLUSIONS_CHANGED');
  keys(q.approval,['additional_human_review_required','standing_authority_reference','remaining_programmatic_conditions']);
  if(q.approval.additional_human_review_required!==false||!text(q.approval.standing_authority_reference,1000)||
    !Array.isArray(q.approval.remaining_programmatic_conditions)||q.approval.remaining_programmatic_conditions.length>32||
    q.approval.remaining_programmatic_conditions.some(x=>!text(x,1000))) fail('NOT_MACHINE_EXECUTABLE_QUOTE');
  keys(q.settlement,['network','asset','funding_deadline','execution_method','execution_reference']);
  if(q.settlement.network!==offer.settlement.network||q.settlement.asset!=='USDC'||!date(q.settlement.funding_deadline)||
    Date.parse(q.settlement.funding_deadline)<Date.parse(q.issued_at)||!text(q.settlement.execution_method,200)||
    !text(q.settlement.execution_reference,2000)) fail('INVALID_SETTLEMENT_DESCRIPTION');
  if(!Array.isArray(q.documents)||q.documents.length>16) fail('INVALID_DOCUMENT_REFERENCES');
  for(const d of q.documents){keys(d,['name','sha256','uri']);if(!text(d.name,200)||!/^[a-f0-9]{64}$/.test(d.sha256)||!text(d.uri,2000))fail('INVALID_DOCUMENT_REFERENCE');const u=new URL(d.uri);if(u.protocol!=='https:'||u.username||u.password)fail('INVALID_DOCUMENT_URI');}
  const a=envelope.authorization;
  keys(a,['scheme','public_key','signature']);keys(a.public_key,['kty','crv','x']);
  if(a.scheme!=='Ed25519'||a.public_key.kty!=='OKP'||a.public_key.crv!=='Ed25519'||
    !/^[A-Za-z0-9_-]{43}$/.test(a.public_key.x)||!/^[a-f0-9]{128}$/.test(a.signature)) fail('INVALID_SIGNATURE_FORMAT');
  let key;try{key=createPublicKey({key:a.public_key,format:'jwk'});}catch{fail('INVALID_PUBLIC_KEY');}
  const kid=hash(key.export({type:'spki',format:'der'}));
  if(kid!==q.capital_provider.signing_key_sha256) fail('SIGNING_KEY_MISMATCH');
  if(!verify(null,Buffer.from(PREFIX+canonical(q)),key,Buffer.from(a.signature,'hex'))) fail('SIGNATURE_INVALID');
  return {quote:q,key_id:kid,body_hash:hash(canonical(envelope)),signature_verified:true};
}

export function openStore(path) {
  if(path!==':memory:') mkdirSync(resolve(path,'..'),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS quotes (
    environment TEXT NOT NULL, key_id TEXT NOT NULL, nonce TEXT NOT NULL, quote_id TEXT NOT NULL,
    body_hash TEXT NOT NULL, receipt_token TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL,
    envelope TEXT NOT NULL, receipt TEXT NOT NULL,
    PRIMARY KEY(environment,key_id,nonce), UNIQUE(environment,key_id,quote_id)) STRICT;`);
  return db;
}
export function recordQuote(db,envelope,offer,now=Date.now()) {
  // Verify authenticity even when replaying an expired, previously recorded quote.
  const v=validateQuote(envelope,offer,now,false), q=v.quote;
  db.exec('BEGIN IMMEDIATE');
  try {
    const old=db.prepare('SELECT body_hash,receipt FROM quotes WHERE environment=? AND key_id=? AND (nonce=? OR quote_id=?)').all(q.environment,v.key_id,q.nonce,q.quote_id);
    if(old.length){if(old.length!==1||old[0].body_hash!==v.body_hash) fail('NONCE_OR_QUOTE_ID_CONFLICT',409);db.exec('COMMIT');return {status:200,receipt:JSON.parse(old[0].receipt)};}
    validateQuote(envelope,offer,now,true);
    const token=randomBytes(32).toString('hex');
    const receipt={status:'SIGNED_QUOTE_RECORDED',environment:q.environment,quote_id:q.quote_id,mode:q.mode,
      received_at:new Date(now).toISOString(),expires_at:q.expires_at,quote_sha256:v.body_hash,
      signature_verified:true,provider_identity_verified:false,wallet_control_verified:false,
      capital_commitment_verified:false,accepted:false,settlement_confirmed:false,live_completion_proven:false,
      receipt_url:new URL(`/liquidity/receipts/${token}`,q.origin).href};
    db.prepare('INSERT INTO quotes VALUES (?,?,?,?,?,?,?,?,?)').run(q.environment,v.key_id,q.nonce,q.quote_id,v.body_hash,token,receipt.received_at,canonical(envelope),JSON.stringify(receipt));
    db.exec('COMMIT');return {status:201,receipt};
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}

export function schema() {
  const str={type:'string'};const objSchema=(properties)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
  const money={type:'string',pattern:'^(0|[1-9][0-9]{0,12})(\\.[0-9]{1,6})?$'};
  return {$schema:'https://json-schema.org/draft/2020-12/schema',title:'WHP EPT signed capital quote v1',
    ...objSchema({quote:objSchema({version:{const:'1.0.0'},environment:{enum:['LIVE','TEST']},origin:str,offer_id:{const:ID},
      offer_sha256:str,quote_id:str,nonce:str,issued_at:str,expires_at:str,mode:{enum:['PURCHASE','SECURED_ADVANCE']},
      capital_provider:objSchema({name:str,signing_key_sha256:str,wallet:str,authority_reference:str}),
      funding:objSchema({currency:{const:'USDC'},gross:money,net_to_seller:money,withheld_costs:money,provider_borne_costs:money,
        cost_breakdown:{type:'array',items:objSchema({description:str,amount:money})}}),acquired_or_collateral_face_usd:money,
      repayment:{oneOf:[{type:'null'},objSchema({obligor:{const:'Justin Bowen'},principal:money,total_due:money,maturity:str,interest_and_fee_terms:str,surplus_treatment:str})]},
      recourse:objSchema({ordinary_obligor_nonpayment:str,direct_borrower_recourse:{type:'boolean'},seller_representation_recourses:{type:'array',items:str},terms:str}),
      exclusions:{const:EXCLUSIONS},approval:objSchema({additional_human_review_required:{const:false},standing_authority_reference:str,remaining_programmatic_conditions:{type:'array',items:str}}),
      settlement:objSchema({network:{enum:['eip155:8453','eip155:84532']},asset:{const:'USDC'},funding_deadline:str,execution_method:str,execution_reference:str}),
      documents:{type:'array',items:objSchema({name:str,sha256:str,uri:str})}}),authorization:objSchema({scheme:{const:'Ed25519'},
      public_key:objSchema({kty:{const:'OKP'},crv:{const:'Ed25519'},x:str}),signature:str})})};
}

export function createApp({origin,environment='LIVE',db=null,storageDurable=false,commit='UNKNOWN'}) {
  const offer=makeOffer(origin,environment), offerHash=hash(canonical(offer));
  const publicOffer=()=>({...offer,offer_sha256:offerHash,offer_hash_scope:'Canonical offer excluding these two hash fields'});
  function send(res,status,value,headers={}) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));}
  const server=http.createServer({maxHeaderSize:16384},async(req,res)=>{
    try{
      const path=new URL(req.url,origin).pathname;
      if(req.headers.origin && req.headers.origin!==origin) return send(res,403,{error:'ORIGIN_NOT_ALLOWED'});
      if(req.method==='GET') {
        if(path==='/healthz') return send(res,200,{status:'UP',environment,commit,quote_intake_ready:!!db,storage_durable:storageDurable,settlement_enabled:false});
        if(path==='/readyz')return send(res,db?200:503,{quote_intake_ready:!!db,storage_durable:storageDurable});
        if(path===BASE)return send(res,200,publicOffer());
        if(path==='/'||path==='/agents.json'||path==='/.well-known/liquidity.json') return send(res,200,{name:'WHP EPT Liquidity',version:'1.0.0',environment,
          transport:'HTTPS_JSON',offer:origin+BASE,openapi:origin+'/openapi.json',quote_schema:origin+'/schemas/quote.json',
          signature_scheme:'Ed25519',modes:offer.funding.modes,quote_intake_ready:!!db,settlement_enabled:false,
          registry_submission_status:'NOT_SUBMITTED',protected_standing_services_used:false});
        if(path==='/schemas/quote.json')return send(res,200,schema());
        if(path==='/openapi.json')return send(res,200,{openapi:'3.1.0',info:{title:'WHP EPT Liquidity',version:'1.0.0'},servers:[{url:origin}],
          paths:{[BASE]:{get:{operationId:'getEPTOffer',responses:{200:{description:'Current quote solicitation, not a capital commitment'}}}},
          [BASE+'/quote']:{post:{operationId:'submitEPTQuote',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/SignedQuote'}}}},responses:{201:{description:'Signed quote durably recorded; not accepted or funded'},200:{description:'Idempotent replay'},422:{description:'Signature or terms rejected'},409:{description:'Nonce conflict'},503:{description:'Durable intake unavailable'}}}},
          [BASE+'/validate-quote']:{post:{operationId:'validateEPTQuote',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/SignedQuote'}}}},responses:{200:{description:'No-write validation'},422:{description:'Rejected'}}}},
          [BASE+'/activity']:{get:{responses:{200:{description:'Recorded quote counts; never funding proof'}}}},
          '/liquidity/receipts/{token}':{get:{parameters:[{name:'token',in:'path',required:true,schema:{type:'string',pattern:'^[a-f0-9]{64}$'}}],responses:{200:{description:'Private capability receipt'},404:{description:'Unknown token'}}}}},components:{schemas:{SignedQuote:schema()}}});
        if(path==='/llms.txt'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(`# WHP EPT Liquidity\n\nOffer: ${origin+BASE}\nOpenAPI: ${origin}/openapi.json\nQuote schema: ${origin}/schemas/quote.json\n\n$15,000 USD EPT license payment right described by Justin Bowen. Purchase and secured-advance quotes, including partial funding, are accepted programmatically. No manual underwriting desk. Ed25519-signed quote intake is NOT acceptance, funded capital or settlement. No payment or collateral transfer should be sent to this service. No wallet signing key is held.\n`);}
        if(path===BASE+'/activity') {if(!db)return send(res,503,{error:'DURABLE_STORAGE_UNAVAILABLE'});const count=db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE environment=?').get(environment).n;return send(res,200,{environment,signed_quotes_recorded:count,capital_commitments_verified:0,settlements:0,live_completion_proven:false});}
        if(/^\/liquidity\/receipts\/[a-f0-9]{64}$/.test(path)){if(!db)return send(res,503,{error:'DURABLE_STORAGE_UNAVAILABLE'});const r=db.prepare('SELECT receipt FROM quotes WHERE receipt_token=? AND environment=?').get(path.split('/').pop(),environment);return send(res,r?200:404,r?JSON.parse(r.receipt):{error:'NOT_FOUND'});}
        return send(res,404,{error:'NOT_FOUND'});
      }
      if(req.method!=='POST'||![BASE+'/quote',BASE+'/validate-quote'].includes(path))return send(res,405,{error:'METHOD_NOT_ALLOWED'});
      if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||''))return send(res,415,{error:'JSON_REQUIRED'});
      if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')return send(res,415,{error:'CONTENT_ENCODING_UNSUPPORTED'});
      if(path===BASE+'/quote' && !db)return send(res,503,{error:'DURABLE_STORAGE_UNAVAILABLE'});
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>32768){send(res,413,{error:'BODY_TOO_LARGE'});req.resume();return;}chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'INVALID_JSON'});}
      if(path===BASE+'/validate-quote'){validateQuote(body,offer);return send(res,200,{status:'VALID_SIGNATURE_AND_SCHEMA',persisted:false,accepted:false,capital_commitment_verified:false,settlement_confirmed:false});}
      const result=recordQuote(db,body,offer);return send(res,result.status,result.receipt);
    }catch(e){send(res,e.status||500,{error:e.status?e.message:'INTERNAL_ERROR'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  return {server,offer};
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  const environment=process.env.WHP_LIQUIDITY_ENVIRONMENT||'LIVE';
  const origin=process.env.WHP_LIQUIDITY_ORIGIN||(process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:null);
  if(!origin)throw new Error('WHP_LIQUIDITY_ORIGIN_REQUIRED');
  const dataDir=process.env.WHP_LIQUIDITY_DATA_DIR||'/data';
  const volume=process.env.RAILWAY_VOLUME_MOUNT_PATH;
  let db=null,durable=false;
  if(volume){mkdirSync(dataDir,{recursive:true});if(realpathSync(dataDir)!==realpathSync(volume))throw new Error('VOLUME_PATH_MISMATCH');db=openStore(join(dataDir,'ept-quotes.sqlite'));durable=true;}
  else if(environment==='TEST'){db=openStore(join(dataDir,'ept-quotes-test.sqlite'));}
  const {server}=createApp({origin,environment,db,storageDurable:durable,commit:process.env.RAILWAY_GIT_COMMIT_SHA||'UNKNOWN'});
  const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_PORT');
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'STARTED',port,environment,quote_intake_ready:!!db,storage_durable:durable})));
  const shutdown=()=>{server.close(()=>{db?.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
